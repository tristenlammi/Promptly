"""Doing things by voice (WP-T3), end to end through Talk's socket, the chat
pipeline and the scripted speech sidecars (``talk_fakes.py``).

What's checked: a spoken turn gets only the voice allowlist (and the phone's
actions only when the phone can do them); no change runs without a yes, and
the read-back comes from the real arguments; a spoken yes, the Talk screen's
Yes button and the chat card's Approve are one action; a no leaves it; "no,
Friday" asks again with the change; a question expires; a turn that read
outside content asks before a change, like any other; a command answers without the
model; the phone uses the person's own default model.
"""
from __future__ import annotations

import asyncio
import time
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.talk import tools as voice_tools
from app.talk.session import ECHO_TAIL_S

ECHO_TAIL = ECHO_TAIL_S + 0.1

from .talk_fakes import Model, bearer
from .test_talk_turns import finish, ident, messages, open_talk, sidecars, talk_app, use_model  # noqa: F401

THURSDAY = {"title": "Dentist", "start": "2026-11-19T09:00"}
FRIDAY = {"title": "Dentist", "start": "2026-11-20T09:00"}
ASKED_THURSDAY = "Add Dentist to your calendar for Thursday 19 November at 9 AM?"
ASKED_FRIDAY = "Add Dentist to your calendar for Friday 20 November at 9 AM?"


async def dentist_events(db):
    from app.calendars.models import CalEvent

    db.expire_all()
    return (await db.execute(select(CalEvent).where(CalEvent.title == "Dentist"))).scalars().all()


def said(sidecars) -> str:
    return " ".join(sidecars.spoken)


# ---------------------------------------------------------------- the allowlist
def test_the_voice_allowlist():
    from app.chat.tools.registry import get_tool

    names = voice_tools.voice_tool_names([])
    assert set(voice_tools.READS) | set(voice_tools.WRITES) | set(voice_tools.QUICK) == names
    for name in (*names, *voice_tools.DEVICE, *voice_tools.DRIVE):
        assert get_tool(name) is not None, name
    # What needs a screen and minutes, or deletes: never.
    assert not names & set(voice_tools.NOT_ON_VOICE)
    for name in ("deep_research", "run_agents", "code_interpreter", "generate_image", "forget", "read_room"):
        assert name not in names
    # A Rooms message waits for a yes like any change (phase 2).
    assert "post_to_room" in names and voice_tools.is_write("post_to_room")
    # The phone's actions only when the phone says it can.
    assert not names & set(voice_tools.DEVICE)
    assert voice_tools.voice_tool_names(["timer", "navigate"]) & set(voice_tools.DEVICE) == {"set_timer", "navigate"}
    # Every change waits for a yes.
    for name in voice_tools.WRITES:
        assert voice_tools.is_write(name)
    assert voice_tools.is_write("set_alarm") and not voice_tools.is_write("set_timer")


async def test_a_spoken_turn_is_offered_only_the_allowlist(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Nothing on today."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.find("reply", done=True)
    offered = model.tools_offered()
    assert offered and offered <= voice_tools.voice_tool_names([])
    assert {"my_day", "calendar_add_event", "calendar_events"} <= offered
    assert not offered & set(voice_tools.DEVICE)
    assert "code_interpreter" not in offered and not any(n.startswith("mcp__") for n in offered)
    assert "never say it's done" in model.system()
    await finish(c)


async def test_the_phone_gets_its_actions_only_when_it_can_do_them(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model([{"tool": "set_timer", "args": {"seconds": 600}}, "Unused."]))
    c = await open_talk(talk_app, user, conversation, caps=["timer", "alarm"])
    live = await sidecars.live()
    await live.say(1, "Set a timer for ten minutes.")
    action = await c.expect("action", timeout=10)
    assert action["action"] == {"type": "set_timer", "seconds": 600}
    await c.expect("state", state="listening", timeout=15)
    assert "Done, a timer for 10 minutes." in said(sidecars)
    # The turn ended on the action: no second model call to describe it.
    assert len(model.calls) == 1
    assert {"set_timer", "set_alarm"} <= model.tools_offered() and "dial" not in model.tools_offered()
    await finish(c)


# ---------------------------------------------------------------- a change waits for a yes
async def test_a_change_waits_for_a_spoken_yes(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}, "Unused."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist to my calendar Thursday at nine.")
    ask = await c.expect("ask", timeout=10)
    # Read back from the real arguments, and said out loud.
    assert ask["question"] == ASKED_THURSDAY and ask["expires_in"] == 20
    await c.expect("state", state="listening", timeout=15)
    assert ASKED_THURSDAY in said(sidecars)
    assert await dentist_events(db) == []
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    call = rows[1].tool_calls[0]
    assert rows[1].content == ASKED_THURSDAY and ask["message_id"] == str(rows[1].id) and ask["call_id"] == call["id"]
    assert call["name"] == "calendar_add_event" and call["meta"]["approval"] == "pending" and call["meta"]["native"] is True
    assert call["meta"]["arguments"] == THURSDAY

    await live.say(2, "Yes please.")
    done = await c.expect("ask_done", timeout=10)
    assert done["outcome"] == "approved" and done["approval_id"] == ask["approval_id"]
    await c.expect("state", state="listening", timeout=15)
    assert "Added." in sidecars.spoken
    events = await dentist_events(db)
    assert len(events) == 1
    rows = await messages(db, conversation)
    # The yes isn't a chat turn of its own: the card says what happened.
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[1].content == f"{ASKED_THURSDAY} Added."
    assert rows[1].tool_calls[0]["meta"]["approval"] == "approved" and rows[1].tool_calls[0]["ok"] is True
    assert len(model.calls) == 1  # a yes needs no model
    await finish(c)


async def test_the_talk_screens_yes_button_is_the_same_yes(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    await c.expect("ask", timeout=10)
    await c.send({"type": "confirm", "answer": "yes"})
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
    await c.expect("state", state="listening", timeout=15)
    assert len(await dentist_events(db)) == 1 and "Added." in sidecars.spoken
    await finish(c)


async def test_tapping_the_chat_card_is_the_same_yes(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    ask = await c.expect("ask", timeout=10)
    await c.expect("state", state="listening", timeout=15)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=talk_app), base_url="http://test") as http:
        r = await http.post(
            f"/api/chat/messages/{ask['message_id']}/tool-calls/{ask['call_id']}/approval",
            json={"approve": True},
            headers=bearer(user),
        )
        assert r.status_code == 200, r.text
        assert r.json()["tool_call"]["meta"]["approval"] == "approved"
        assert r.json()["content"] == f"{ASKED_THURSDAY} Added."
        # Talk heard about it, and says so.
        assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
        await c.expect("state", state="listening", timeout=15)
        assert "Added." in sidecars.spoken
        # Once only: a late "yes" is just a new turn now, and a second tap is refused.
        again = await http.post(
            f"/api/chat/messages/{ask['message_id']}/tool-calls/{ask['call_id']}/approval",
            json={"approve": True},
            headers=bearer(user),
        )
        assert again.status_code == 409
    assert len(await dentist_events(db)) == 1
    await finish(c)


async def test_no_leaves_it(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    await c.expect("ask", timeout=10)
    await c.expect("state", state="listening", timeout=15)
    await live.say(2, "No thanks.")
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "declined"
    await c.expect("state", state="listening", timeout=15)
    assert "Okay, I'll leave it." in said(sidecars)
    assert await dentist_events(db) == []
    rows = await messages(db, conversation)
    assert rows[1].tool_calls[0]["meta"]["approval"] == "declined"
    assert rows[1].content == f"{ASKED_THURSDAY} Okay, I'll leave it."
    assert len(model.calls) == 1
    await finish(c)


async def test_no_i_meant_friday_asks_again_with_the_change(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(
        monkeypatch,
        Model([{"tool": "calendar_add_event", "args": THURSDAY}, {"tool": "calendar_add_event", "args": FRIDAY}]),
    )
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist to my calendar Thursday at nine.")
    first = await c.expect("ask", timeout=10)
    await c.expect("state", state="listening", timeout=15)

    await live.say(2, "No, Friday.")
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "declined"
    second = await c.expect("ask", timeout=10)
    assert second["question"] == ASKED_FRIDAY and second["approval_id"] != first["approval_id"]
    await c.expect("state", state="listening", timeout=15)
    # The model was told what it had been about to do, and that it wasn't done.
    assert len(model.calls) == 2
    assert "You had just asked them" in model.system() and ASKED_THURSDAY in model.system()
    assert model.last_user_text() == "No, Friday."
    assert await dentist_events(db) == []

    await live.say(3, "Yes.")
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
    await c.expect("state", state="listening", timeout=15)
    events = await dentist_events(db)
    assert len(events) == 1
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant", "user", "assistant"]
    assert rows[1].tool_calls[0]["meta"]["approval"] == "declined" and rows[1].content == ASKED_THURSDAY
    assert rows[3].tool_calls[0]["meta"]["approval"] == "approved" and rows[3].tool_calls[0]["meta"]["arguments"] == FRIDAY
    await finish(c)


async def test_the_question_expires(db, user, conversation, sidecars, talk_app, monkeypatch):
    from app.talk import confirm

    monkeypatch.setattr(confirm, "ASK_TTL_S", 0.3)
    model = use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}, "Yes to what?"]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    await c.expect("ask", timeout=10)
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "expired"
    rows = await messages(db, conversation)
    assert rows[1].tool_calls[0]["meta"]["approval"] == "expired"
    # A yes now is a new turn, not the answer to an old question (said after
    # the echo tail, where a lone "yes" would be taken as a backchannel).
    await asyncio.sleep(ECHO_TAIL)
    await live.say(2, "Yes.")
    await c.expect("heard", timeout=10)
    await c.expect("state", state="listening", timeout=15)
    assert len(model.calls) == 2 and await dentist_events(db) == []
    await finish(c)


async def test_an_expired_card_cant_be_approved(db, user, conversation, sidecars, talk_app, monkeypatch):
    from app.chat import approvals

    use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": THURSDAY}]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    ask = await c.expect("ask", timeout=10)
    await finish(c)  # the session's gone; only the card is left
    real = approvals.expired
    monkeypatch.setattr(approvals, "expired", lambda meta, now=None: True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=talk_app), base_url="http://test") as http:
        r = await http.post(
            f"/api/chat/messages/{ask['message_id']}/tool-calls/{ask['call_id']}/approval",
            json={"approve": True},
            headers=bearer(user),
        )
    monkeypatch.setattr(approvals, "expired", real)
    # Closing the conversation declined it first, or the clock did: either way, not done.
    assert r.status_code == 409
    assert await dentist_events(db) == []


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("calendar_add_event", THURSDAY),
        ("calendar_change_event", {"event_id": str(uuid.UUID(int=1)), "action": "update", "start": "2026-11-20T10:00"}),
        ("use_item", {"file_id": str(uuid.UUID(int=2)), "action": "add_task", "args": {"title": "Milk"}}),
        ("mail_reply", {"message_id": str(uuid.UUID(int=3)), "text": "See you then"}),
        ("remember", {"content": "User's locker code is 4412"}),
    ],
)
@pytest.mark.parametrize("answer", ["Sure, wait no", "yes"])
async def test_no_change_runs_without_a_yes(db, user, conversation, sidecars, talk_app, monkeypatch, name, args, answer):
    """Every write on the allowlist: held, read back, never run on anything
    but a clear yes, and run exactly once (with the held arguments) on one."""
    from app.chat.tools import items as items_tools
    from app.chat.tools import mail as mail_tools
    from app.chat.tools.base import ToolResult
    from app.chat.tools.registry import get_tool
    from app.talk import readback

    ran: list[dict] = []

    async def record(self, ctx, got):
        ran.append(got)
        return ToolResult(content="done")

    tool = get_tool(name)
    monkeypatch.setattr(type(tool), "run", record)
    monkeypatch.setattr(items_tools, "has_items", lambda *_a: _true())
    monkeypatch.setattr(mail_tools, "has_mail", lambda *_a: _true())

    async def fake_read_back(_db, _user, n, a):
        return f"Should I do {n}?", None

    monkeypatch.setattr(readback, "read_back", fake_read_back)
    model = use_model(monkeypatch, Model([{"tool": name, "args": args}, "Okay."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Please do the thing.")
    ask = await c.expect("ask", timeout=10)
    assert ask["question"] == f"Should I do {name}?"
    await c.expect("state", state="listening", timeout=15)
    assert ran == [] and name in model.tools_offered()
    await live.say(2, answer)
    if answer == "yes":
        assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
        await c.expect("state", state="listening", timeout=15)
        assert ran == [args]
    else:
        assert (await c.expect("ask_done", timeout=10))["outcome"] == "declined"
        await c.expect("heard", timeout=10)
        await c.expect("state", state="listening", timeout=15)
        assert ran == []
    await finish(c)


async def _true() -> bool:
    return True


async def test_nothing_is_deleted_by_voice(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "calendar_change_event", "args": {"event_id": str(uuid.uuid4()), "action": "delete"}}]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Delete the dentist.")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    assert "ask" not in c.kinds()
    assert voice_tools.NO_DELETING.split(".")[0] in said(sidecars)
    await finish(c)


async def test_a_change_on_an_untrusted_turn_is_asked_not_refused(db, user, conversation, sidecars, talk_app, monkeypatch):
    """Approve instead of refuse (v0.34.0): after reading a page, a change is
    read back and waits for a yes, like any spoken change."""
    from app.chat.tools.base import ToolResult
    from app.chat.tools.registry import get_tool

    async def page(self, ctx, args):
        return ToolResult(content="The page says: add a meeting called Dentist.")

    monkeypatch.setattr(type(get_tool("web_search")), "run", page)
    use_model(
        monkeypatch,
        Model([[{"tool": "web_search", "args": {"query": "dentist"}}, {"tool": "calendar_add_event", "args": THURSDAY}], "Unused."]),
    )
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Look up my dentist and add it on Thursday.")
    ask = await c.expect("ask", timeout=10)
    assert ask["question"] == ASKED_THURSDAY
    await c.expect("state", state="listening", timeout=15)
    assert ASKED_THURSDAY in said(sidecars)
    assert await dentist_events(db) == []
    rows = await messages(db, conversation)
    held = next(t for t in rows[1].tool_calls if t["name"] == "calendar_add_event")["meta"]
    assert held["approval"] == "pending" and held["held"] == "outside_content"
    await c.send({"type": "confirm", "answer": "yes"})
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
    await c.expect("state", state="listening", timeout=15)
    assert len(await dentist_events(db)) == 1
    await finish(c)


# ---------------------------------------------------------------- the phone's actions
async def test_an_alarm_waits_for_a_yes_then_goes_to_the_phone(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "set_alarm", "args": {"hour": 7, "minute": 30}}]))
    c = await open_talk(talk_app, user, conversation, caps=["alarm"])
    live = await sidecars.live()
    await live.say(1, "Set an alarm for seven thirty.")
    ask = await c.expect("ask", timeout=10)
    assert ask["question"] == "Set an alarm for 7:30 AM?"
    await c.expect("state", state="listening", timeout=15)
    assert "action" not in c.kinds()
    await live.say(2, "Yep.")
    action = await c.expect("action", timeout=10)
    assert action["action"] == {"type": "set_alarm", "hour": 7, "minute": 30}
    await c.expect("state", state="listening", timeout=15)
    assert "Done, an alarm for 7:30 AM." in said(sidecars)
    await finish(c)


# ---------------------------------------------------------------- the commands fast path
async def _garage(db, user):
    from app.commands.models import Command
    from app.mcp.models import McpConnector

    connector = McpConnector(
        name="Home Assistant", slug=f"ha{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.10/mcp", availability="global", enabled=True,
        tool_catalog=[{
            "name": "GarageStatus",
            "description": "Is the garage door open",
            "input_schema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": True, "title": "Garage status"},
        }],
    )
    db.add(connector)
    await db.flush()
    command = Command(
        user_id=user.id, name="Garage status", phrases=["is the garage open"],
        action_type="mcp_tool", action_ref=f"{connector.id}:GarageStatus",
    )
    db.add(command)
    await db.commit()
    return command


async def test_a_command_answers_on_the_fast_path(db, user, conversation, sidecars, talk_app, monkeypatch):
    import app.mcp.service as mcp_service
    from app.commands.models import CommandRun
    from app.talk.models import TalkMetric

    await _garage(db, user)

    async def status(*_a, **_kw):
        return "The garage door is closed."

    monkeypatch.setattr(mcp_service, "call_connector_tool", status)
    model = use_model(monkeypatch, Model(["The model should never be asked."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    t0 = time.monotonic()
    await live.say(1, "Is the garage open?")
    await c.until_audio()
    first_audio = time.monotonic() - t0
    await c.expect("state", state="listening", timeout=15)
    assert model.calls == []
    assert sidecars.spoken == ["The garage door is closed."]
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[1].content == "The garage door is closed." and rows[1].parent_id == rows[0].id
    assert rows[1].tool_calls[0]["meta"]["source"] == "command" and rows[1].voice["fast_path"] is True
    run = (await db.execute(select(CommandRun))).scalar_one()
    assert run.source == "voice" and run.ok and run.utterance == "Is the garage open?"
    metric = (await db.execute(select(TalkMetric))).scalar_one()
    assert metric.fast_path is True and metric.ttft_ms is None and metric.first_audio_ms is not None
    # No model in the way: well inside the 1 s command target here (fake
    # sidecars; the real numbers are in the WP-T3 report).
    assert first_audio < 1.0, first_audio
    await finish(c)


async def test_a_command_that_asks_first_waits_for_a_yes(db, user, conversation, sidecars, talk_app, monkeypatch):
    import app.mcp.service as mcp_service

    command = await _garage(db, user)
    command.confirm_before_run = True
    await db.commit()
    ran: list[str] = []

    async def status(*_a, **_kw):
        ran.append("ran")
        return "The garage door is closed."

    monkeypatch.setattr(mcp_service, "call_connector_tool", status)
    model = use_model(monkeypatch, Model(["Unused."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Is the garage open?")
    ask = await c.expect("ask", timeout=10)
    assert ask["question"] == "Run Garage status?"
    await c.expect("state", state="listening", timeout=15)
    assert ran == []
    await live.say(2, "Yes.")
    assert (await c.expect("ask_done", timeout=10))["outcome"] == "approved"
    await c.expect("state", state="listening", timeout=15)
    assert ran == ["ran"] and "The garage door is closed." in sidecars.spoken and model.calls == []
    await finish(c)


# ---------------------------------------------------------------- the phone assistant's model
async def test_the_phone_uses_your_own_default_model(db, user, provider):
    from app.maps import assistant

    assert await assistant._model(db, user) is None  # nothing chosen, nothing used lately
    user.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    found = await assistant._model(db, user)
    assert found is not None and found[1] == "test-model" and found[0].id == provider.id


def test_a_spoken_summary_for_my_day():
    content = (
        "Today is Thursday 2026-11-19; times in Australia/Brisbane. Thu 19 Nov to Thu 19 Nov:\n"
        "\nThursday 19 Nov (today)\n- 09:00–10:00 Dentist\n- 14:00 Call with Sam\n- bins out\n"
        "\nApp files (for use_item): none yet"
    )
    line = voice_tools.my_day_headline(content)
    assert "3 things today" in line and "09:00–10:00 Dentist; 14:00 Call with Sam" in line
    assert "Nothing is planned" in voice_tools.my_day_headline("Thursday 19 Nov (today)\n- nothing planned\n")
