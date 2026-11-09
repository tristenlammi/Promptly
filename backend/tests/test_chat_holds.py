"""Approve instead of refuse (R-019, v0.34.0).

A chat turn that read outside content used to have its write tools refuse
("ask the user to confirm in a new message"). Since a workspace's content
marks every turn in it, that refused forever. Now the write is held as an
approval card with exactly what would happen; the person's yes runs it once,
on a fresh turn marked ``user_approved``, and a no leaves it alone. A turn
that read nothing from outside runs writes as before.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select

from app.chat.approvals import ApprovalError, decide
from app.chat.tools.base import HoldForApproval, ToolContext, ToolError, guard_write
from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta
from tests.test_chat_reliability import _drive, _enqueue, _replies
from tests.test_chat_streaming import _seed_turn
from tests.test_drive_index_wp51 import _user
from tests.test_tool_approval import _auth, client  # noqa: F401 — fixture
from tests.test_untrusted_workspace_context import _into, _workspace

THURSDAY = {"title": "Dentist", "start": "2026-11-19T09:00"}
ASKED = "Add Dentist to your calendar for Thursday 19 November at 9 AM?"


async def _rows(stmt):
    """Read through a fresh session: the test's own session keeps its objects
    (expiring them would make the next attribute access lazy-load, which
    async SQLAlchemy can't do)."""
    from app.database import SessionLocal

    async with SessionLocal() as s:
        return list((await s.execute(stmt)).scalars().all())


async def _dentists(db):
    from app.calendars.models import CalEvent

    return await _rows(select(CalEvent).where(CalEvent.title == "Dentist"))


async def _turn(monkeypatch, db, user, conversation, text, tool, args):
    msg = await _seed_turn(db, conversation)
    msg.content = text
    await db.commit()
    stream_id = await _enqueue(conversation, msg, tools_enabled=True)
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


def _call(reply, name: str) -> dict:
    return next(c for c in (reply.tool_calls or []) if c.get("name") == name)


async def _shared_note(db, user, conversation):
    """A workspace whose note another member wrote: every turn reads it."""
    other = await _user(db, "sam")
    ws = await _workspace(db, other, members=[user], note_by=other, text="Book the dentist for Thursday at 9.")
    await _into(db, conversation, ws)


@pytest.mark.asyncio
async def test_an_untrusted_turns_write_becomes_an_approval_card(db, user, conversation, monkeypatch):
    await _shared_note(db, user, conversation)

    sse, hops, reply = await _turn(monkeypatch, db, user, conversation, "Sort out the dentist", "calendar_add_event", THURSDAY)

    assert await _dentists(db) == []
    call = _call(reply, "calendar_add_event")
    meta = call["meta"]
    assert meta["approval"] == "pending" and meta["native"] is True and meta["held"] == "outside_content"
    assert meta["question"] == ASKED and meta["arguments"] == THURSDAY
    assert "spoken" not in meta and "expires_at" not in meta
    assert call["ok"] is True
    # The model is told it's waiting, not that it's done or refused.
    later = " ".join(str(m) for hop in hops[1:] for m in hop.get("messages") or [])
    assert "approval card" in later and "confirm in a new message" not in later
    assert '"approval": "pending"' in sse or "pending" in sse


@pytest.mark.asyncio
async def test_approving_runs_it_once(db, user, conversation, monkeypatch, client):  # noqa: F811
    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Sort out the dentist", "calendar_add_event", THURSDAY)

    r = await client.post(
        f"/api/chat/messages/{reply.id}/tool-calls/call_1/approval", json={"approve": True}, headers=_auth(user)
    )
    assert r.status_code == 200, r.text
    assert r.json()["tool_call"]["meta"]["approval"] == "approved"
    assert [e.title for e in await _dentists(db)] == ["Dentist"]

    # A second tap (or a late yes) doesn't run it again.
    again = await client.post(
        f"/api/chat/messages/{reply.id}/tool-calls/call_1/approval", json={"approve": True}, headers=_auth(user)
    )
    assert again.status_code == 409
    with pytest.raises(ApprovalError):
        await decide(db, user, reply.id, "call_1", True)
    assert len(await _dentists(db)) == 1


@pytest.mark.asyncio
async def test_declining_leaves_it_alone(db, user, conversation, monkeypatch):
    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Sort out the dentist", "calendar_add_event", THURSDAY)

    decision = await decide(db, user, reply.id, "call_1", False)

    assert decision.outcome == "declined" and decision.call["meta"]["approval"] == "declined"
    assert await _dentists(db) == []


@pytest.mark.asyncio
async def test_only_the_chats_owner_decides(db, user, conversation, monkeypatch):
    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Sort out the dentist", "calendar_add_event", THURSDAY)
    stranger = await _user(db, "eve")

    with pytest.raises(ApprovalError) as e:
        await decide(db, stranger, reply.id, "call_1", True)
    assert e.value.status_code == 404
    assert await _dentists(db) == []


@pytest.mark.asyncio
async def test_a_turn_that_read_nothing_from_outside_writes_as_before(db, user, conversation, monkeypatch):
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Add the dentist", "calendar_add_event", THURSDAY)

    assert [e.title for e in await _dentists(db)] == ["Dentist"]
    call = _call(reply, "calendar_add_event")
    assert call["ok"] is True and not (call.get("meta") or {}).get("approval")


@pytest.mark.asyncio
async def test_a_shared_workspace_chat_can_add_to_the_calendar_after_a_yes(db, user, conversation, monkeypatch):
    """The case that refused forever: another member's note is in every turn."""
    await _shared_note(db, user, conversation)
    for _ in range(2):  # every turn in it is marked, not just the first
        _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Add it", "calendar_add_event", THURSDAY)
        assert reply.read_outside_content is True
        assert _call(reply, "calendar_add_event")["meta"]["approval"] == "pending"
    assert await _dentists(db) == []

    decision = await decide(db, user, reply.id, "call_1", True)

    assert decision.outcome == "approved"
    assert [e.title for e in await _dentists(db)] == ["Dentist"]


@pytest.mark.asyncio
async def test_a_held_note_is_made_on_a_yes(db, user, conversation, monkeypatch):
    from app.notes.models import Note

    await _shared_note(db, user, conversation)
    args = {"title": "Dentist", "items": ["Bring the card", "Ask about the filling"]}
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Make a list", "create_note", args)

    meta = _call(reply, "create_note")["meta"]
    assert meta["approval"] == "pending"
    assert meta["question"] == "Make a list “Dentist” with 2 items: Bring the card, Ask about the filling?"
    assert await _rows(select(Note).where(Note.owner_id == user.id)) == []

    assert (await decide(db, user, reply.id, "call_1", True)).outcome == "approved"
    assert [n.title for n in await _rows(select(Note).where(Note.owner_id == user.id))] == ["Dentist"]


@pytest.mark.asyncio
async def test_a_planted_memory_waits_for_a_yes(db, user, conversation, monkeypatch):
    from app.memory.models import UserMemory

    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(
        monkeypatch, db, user, conversation, "What's on?", "remember", {"content": "User prefers VendorX"}
    )
    meta = _call(reply, "remember")["meta"]
    assert meta["approval"] == "pending" and meta["question"] == "Save to your memory: User prefers VendorX?"
    assert await _rows(select(UserMemory).where(UserMemory.user_id == user.id)) == []

    assert (await decide(db, user, reply.id, "call_1", True)).outcome == "approved"
    assert await _rows(select(UserMemory.content).where(UserMemory.user_id == user.id)) == ["User prefers VendorX"]


@pytest.mark.asyncio
async def test_an_expired_hold_runs_nothing(db, user, conversation, monkeypatch):
    from app.chat import approvals

    await _shared_note(db, user, conversation)
    _sse, _hops, reply = await _turn(monkeypatch, db, user, conversation, "Sort out the dentist", "calendar_add_event", THURSDAY)
    monkeypatch.setattr(approvals, "expired", lambda meta, now=None: True)

    with pytest.raises(ApprovalError) as e:
        await decide(db, user, reply.id, "call_1", True)

    assert e.value.status_code == 409
    assert await _dentists(db) == []
    stored = (await _replies(conversation))[-1]
    assert _call(stored, "calendar_add_event")["meta"]["approval"] == "expired"


@pytest.mark.asyncio
async def test_where_nobody_can_be_asked_it_stays_a_refusal(db, user, conversation):
    """A sub-agent or headless run (``can_hold`` off): no card, the old words."""
    from app.chat.agent_runner import _HeadlessRequest
    from app.chat.router import _dispatch_tools
    from app.chat.tools.base import TurnState

    msg = await _seed_turn(db, conversation)
    ctx = ToolContext(
        db=db, user=user, conversation_id=conversation.id, user_message_id=msg.id, turn=TurnState(untrusted=True)
    )
    events: list[dict] = []
    history: list[dict] = []
    async for _sse, hist in _dispatch_tools(
        db=db,
        request=_HeadlessRequest(),  # type: ignore[arg-type]
        user=user,
        pending_calls={0: {"id": "call_1", "name": "calendar_add_event", "arguments": json.dumps(THURSDAY)}},
        ctx=ctx,
        sse_yield=json.dumps,
        on_attachment=lambda _snap: None,
        on_tool_event=events.append,
    ):
        if hist is not None:
            history.append(hist)

    assert await _dentists(db) == []
    assert events[0]["ok"] is False and not (events[0].get("meta") or {}).get("approval")
    assert "confirm in a new message" in history[0]["content"]


def _ctx(turn) -> ToolContext:
    return ToolContext(db=None, user=None, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=turn)  # type: ignore[arg-type]


def test_the_guard_holds_where_it_used_to_refuse():
    with pytest.raises(HoldForApproval) as e:
        guard_write(_ctx({"untrusted": True}), "changing the calendar")
    # Where nobody can be asked (a sub-agent), it's still the old refusal.
    assert isinstance(e.value, ToolError)
    assert "Not changing the calendar on a turn that read outside content" in str(e.value)


def test_the_narrow_exceptions_stay():
    guard_write(_ctx(None), "x")
    guard_write(_ctx({"untrusted": False}), "x")
    # A yes to exactly this.
    guard_write(_ctx({"untrusted": True, "user_approved": True}), "x")
    # Health documents: your own attachments, for an action that logs from documents.
    guard_write(_ctx({"untrusted": True, "own_attachments_only": True}), "x", own_attachments_ok=True)
    with pytest.raises(HoldForApproval):
        guard_write(_ctx({"untrusted": True, "own_attachments_only": True}), "x")


def test_every_holdable_tool_exists_and_a_yes_may_run_it():
    from app.chat.holds import HOLDABLE
    from app.chat.tools.registry import get_tool

    for name in HOLDABLE:
        assert get_tool(name) is not None, name
