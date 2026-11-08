"""Calls in DMs: voice and video calls in 1:1 and group conversations, the
way Messenger does them. Built on phase 1's LiveKit layer (``app.rtc``).

A call is a ``calls`` row (``kind == "dm"``, one live call per conversation:
the partial unique index on ``room_id``) and a ``call_participants`` row for
everyone in the conversation it rang or who joined:

* ``ring``           ringing / answered / declined / missed (the caller is
                     "answered" from the start)
* ``in_call_since``  connected now (NULL: not in it)
* ``session``        the client session in it (a second device replaces the
                     first; the old session's late "leave" is ignored)
* ``lk_sid``         the LiveKit connection we know about

All of it lives in Postgres and every change takes the call row's lock
(``SELECT … FOR UPDATE``), so answer, decline, cancel, the ring timeout and
LiveKit's webhooks can race without two of them both winning. Timers (the
45 s ring timeout, a group call left with one person) are arq jobs.

* **1:1**: the caller rings the other person for 45 s. Answer connects
  them; decline, cancel or no answer ends it ("Missed call"); either
  hanging up ends it for both ("Call · 12 min").
* **Group**: rings everyone; anyone in the conversation can join while it's
  live ("Call in progress · Join"); it ends when the last person leaves, or
  two minutes after only one is left.
* **One live conversation at a time**: starting, answering or joining a call
  takes you out of any other call and any voice channel (and joining a voice
  channel takes you out of a call).
* **Blocks** (D7): a block either way refuses a 1:1 call, both ways, and
  blocking someone ends a 1:1 call with them. In a group nobody is rung by
  someone they blocked or who blocked them.
* Ringing pushes and the conversation's "Missed call" / "Call · 12 min"
  lines are in :mod:`app.calls.ring`.

Live events on the Rooms stream (``rooms/core.py::publish``) to the
conversation's members: ``call_state {call}``, ``call_ended {call}``; to the
people rung: ``call_ring``; to one person's own clients: ``call_ring_stop
{call_id, reason}`` (answered or declined on another device, missed),
``call_disconnected {call_id, session, reason}``.

Nothing said is recorded, transcribed, indexed or remembered.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.calls import access
from app.calls.models import Call, CallParticipant
from app.config import get_settings
from app.redis_client import redis
from app.rooms import core as rooms_core
from app.rooms.models import Room, RoomMember
from app.rtc import config as rtc_config
from app.rtc import names, service, tokens, webhooks

logger = logging.getLogger("promptly.calls.dm")

MEDIA = ("audio", "video")
DEVICES = ("web", "android")
RING_SECONDS = 45
ALONE_SECONDS = 120  # a group call left with one person
LOST_AFTER = 90  # in our state but not in LiveKit for this long = gone
RERING_AFTER = 15  # seconds before the same person can be rung again
SESSION_TTL = timedelta(hours=12)
STALE_SID_TTL = 15 * 60

K_ALONE = "call:alone:{}"
K_STALE = "call:stale:{}:{}"  # LiveKit sids of a replaced device's connection
K_LIVE = "calls:dm:live"  # set of live DM call ids (the reaper)

# What a person in a DM call may publish: everything (no roles in a DM).
SOURCES = [tokens.MICROPHONE, tokens.CAMERA, tokens.SCREEN, tokens.SCREEN_AUDIO]


class CallError(Exception):
    """A refusal the API turns into an HTTP error."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def lk_room(call_id: uuid.UUID | str) -> str:
    return names.room_name("c_", uuid.UUID(str(call_id)))


def identity(user_id: uuid.UUID | str) -> str:
    return names.user_identity(uuid.UUID(str(user_id)))


def not_found() -> CallError:
    return CallError(404, "Call not found")


def is_dm_room(room: Room | None) -> bool:
    return room is not None and room.space_id is None and room.kind in ("dm", "group")


# ================================================================ reading


async def _lock_call(db: AsyncSession, call_id: uuid.UUID) -> Call | None:
    q = select(Call).where(Call.id == call_id, Call.kind == "dm").with_for_update().execution_options(populate_existing=True)
    return (await db.execute(q)).scalar_one_or_none()


async def _parts(db: AsyncSession, call_id: uuid.UUID) -> dict[uuid.UUID, CallParticipant]:
    q = (
        select(CallParticipant)
        .where(CallParticipant.call_id == call_id, CallParticipant.user_id.is_not(None))
        .execution_options(populate_existing=True)
    )
    return {p.user_id: p for p in (await db.execute(q)).scalars()}  # type: ignore[misc]


def _present(parts: dict[uuid.UUID, CallParticipant]) -> list[CallParticipant]:
    ps = [p for p in parts.values() if p.in_call_since is not None]
    ps.sort(key=lambda p: p.in_call_since)  # type: ignore[arg-type,return-value]
    return ps


async def _is_member(db: AsyncSession, room: Room, user_id: uuid.UUID) -> bool:
    return await db.get(RoomMember, (room.id, user_id)) is not None


async def live_call_of_room(db: AsyncSession, room_id: uuid.UUID) -> Call | None:
    q = select(Call).where(Call.room_id == room_id, Call.kind == "dm", Call.ended_at.is_(None)).execution_options(populate_existing=True)
    return (await db.execute(q)).scalar_one_or_none()


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def duration(call: Call, now: datetime | None = None) -> int:
    """Seconds from the first answer to the end (or now): what "Call · 12
    min" says. 0 for a call nobody answered."""
    if call.answered_at is None:
        return 0
    end = call.ended_at or now or _now()
    return max(0, int((end - call.answered_at).total_seconds()))


def call_out(call: Call, parts: dict[uuid.UUID, CallParticipant], room: Room | None = None) -> dict:
    """A DM call, as every member of its conversation sees it."""
    ringing = [p for p in parts.values() if p.ring == "ringing"]
    ring_until = None
    if ringing and call.ended_at is None:
        last = max((p.rung_at for p in ringing if p.rung_at), default=None)
        ring_until = _iso(last + timedelta(seconds=RING_SECONDS)) if last else None
    order = sorted(parts.values(), key=lambda p: (p.first_joined_at is None, p.first_joined_at or p.rung_at or call.started_at))
    return {
        "id": str(call.id),
        "kind": "dm",
        "room_id": str(call.room_id) if call.room_id else None,
        "group": room.kind == "group" if room is not None else None,
        "media": call.media or "audio",
        "started_by": str(call.started_by) if call.started_by else None,
        "started_at": _iso(call.started_at),
        "answered_at": _iso(call.answered_at),
        "ended_at": _iso(call.ended_at),
        "ended_reason": call.ended_reason,
        "live": call.ended_at is None,
        "in_call": [str(p.user_id) for p in _present(parts)],
        "ringing": [str(p.user_id) for p in ringing] if call.ended_at is None else [],
        "ring_until": ring_until,
        "duration": duration(call),
        "participants": [
            {
                "user_id": str(p.user_id),
                "ring": p.ring,
                "in_call": p.in_call_since is not None,
                "device": p.device if p.in_call_since is not None else None,
                "joined_at": _iso(p.first_joined_at),
            }
            for p in order
        ],
    }


async def describe(db: AsyncSession, call: Call) -> dict:
    room = await db.get(Room, call.room_id) if call.room_id else None
    return call_out(call, await _parts(db, call.id), room)


async def visible_call(db: AsyncSession, user: User, call_id: uuid.UUID) -> tuple[Call, Room]:
    """A DM call of a conversation you're in; else 404."""
    call = await db.get(Call, call_id)
    if call is None or call.kind != "dm" or call.room_id is None:
        raise not_found()
    room = await db.get(Room, call.room_id)
    if not is_dm_room(room) or not await _is_member(db, room, user.id):  # type: ignore[arg-type]
        raise not_found()
    return call, room  # type: ignore[return-value]


async def live_for(db: AsyncSession, user: User) -> list[dict]:
    """Live calls in your conversations (ringing you, or on with a Join)."""
    mine = select(RoomMember.room_id).where(RoomMember.user_id == user.id)
    calls = (
        await db.execute(select(Call).where(Call.kind == "dm", Call.ended_at.is_(None), Call.room_id.in_(mine)).order_by(Call.started_at))
    ).scalars().all()
    out = []
    for c in calls:
        out.append(await describe(db, c))
    return out


async def current_call(db: AsyncSession, user_id: uuid.UUID) -> uuid.UUID | None:
    """The live call you're connected to, if any."""
    q = (
        select(CallParticipant.call_id)
        .join(Call, Call.id == CallParticipant.call_id)
        .where(CallParticipant.user_id == user_id, CallParticipant.in_call_since.is_not(None), Call.ended_at.is_(None), Call.kind == "dm")
        .limit(1)
    )
    return (await db.execute(q)).scalar_one_or_none()


# ================================================================ events


async def _members(db: AsyncSession, room: Room) -> list[uuid.UUID]:
    return await rooms_core.member_ids(db, room)


async def _publish_state(db: AsyncSession, call: Call, room: Room, kind: str = "call_state") -> dict:
    out = call_out(call, await _parts(db, call.id), room)
    await rooms_core.publish(await _members(db, room), {"type": kind, "call": out})
    return out


async def tell(user_id: uuid.UUID | str, event: dict) -> None:
    await rooms_core.publish([user_id], event)


async def _kick(call_id: uuid.UUID, user_id: uuid.UUID | str) -> None:
    try:
        await service.remove_participant(lk_room(call_id), identity(user_id))
    except Exception:  # noqa: BLE001 — LiveKit down: the reaper tidies up
        logger.info("couldn't remove %s from call %s", user_id, call_id, exc_info=True)


async def _close_room(call_id: uuid.UUID) -> None:
    try:
        await service.delete_room(lk_room(call_id))
    except Exception:  # noqa: BLE001
        logger.info("couldn't close the LiveKit room of call %s", call_id, exc_info=True)


# ================================================================ timers


async def _defer(job: str, *args: Any, seconds: float) -> None:
    """Run an arq job later. If the queue can't be reached, a best-effort
    in-process timer instead (the reaper is the backstop)."""
    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        await pool.enqueue_job(job, *args, _defer_by=timedelta(seconds=seconds), _job_id=f"{job}:{uuid.uuid4().hex}")
        return
    except Exception:  # noqa: BLE001
        logger.warning("call timer %s: queue unavailable, using an in-process timer", job, exc_info=True)
    from app.background import spawn

    fn = {"call_ring_timeout": ring_timeout, "call_alone_check": alone_check}[job]

    async def later() -> None:
        await asyncio.sleep(seconds)
        await fn(*args)

    spawn(later(), name=f"{job}-{uuid.uuid4().hex[:6]}")


# ================================================================ sessions and tokens


def _session_token(user_id: uuid.UUID, call_id: uuid.UUID, session: str, device: str) -> str:
    """Lets the Android service fetch fresh LiveKit tokens and leave with no
    bearer: one person, one call, one session, 12 hours, and only while
    that session is the one in the call."""
    now = int(time.time())
    claims = {"typ": "call", "sub": str(user_id), "call": str(call_id), "sid": session, "dev": device, "iat": now, "exp": now + int(SESSION_TTL.total_seconds())}
    return jwt.encode(claims, get_settings().SECRET_KEY, algorithm="HS256")


def read_session(token: str) -> dict | None:
    try:
        claims = jwt.decode(token, get_settings().SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return claims if claims.get("typ") == "call" else None


def _mint(user: User, call: Call) -> str:
    return tokens.mint(
        identity=identity(user.id),
        room=lk_room(call.id),
        name=user.username,
        sources=SOURCES,
        metadata=json.dumps({"user_id": str(user.id), "call_id": str(call.id)}),
    )


def join_out(user: User, call: Call, room: Room, parts: dict[uuid.UUID, CallParticipant], cs: access.CallsSettings) -> dict:
    """Join: everything a client needs to connect, and the call."""
    me = parts[user.id]
    return {
        "call": call_out(call, parts, room),
        "url": rtc_config.CLIENT_PATH,
        "token": _mint(user, call),
        "identity": identity(user.id),
        "lk_room": lk_room(call.id),
        "room_id": str(room.id),
        "session": _session_token(user.id, call.id, me.session or "", me.device or "web"),
        "session_id": me.session,
        "device": me.device,
        "max_stream": cs.max_stream,
    }


# ================================================================ who may call whom


async def refusal(db: AsyncSession, room: Room, user_id: uuid.UUID) -> str | None:
    """In a 1:1 conversation, why ``user_id`` can't call (or be in a call
    with) the other person: a block either way (D7). The blocked person's
    wording never mentions a block. Group conversations: None."""
    if room.kind != "dm":
        return None
    from app.people.blocks import has_blocked

    for other in await _members(db, room):
        if other == user_id:
            continue
        if await has_blocked(db, user_id, other):
            return "You've blocked this person. Unblock them to call."
        if await has_blocked(db, other, user_id):
            return "Calls can't be made in this conversation."
    return None


async def _ringable(db: AsyncSession, room: Room, caller: User, cs: access.CallsSettings) -> tuple[list[User], list[User]]:
    """(who to ring, who can't be rung) among the conversation's other
    members: calls on for them, not disabled, no block with the caller."""
    from app.people.blocks import either

    ids = [u for u in await _members(db, room) if u != caller.id]
    users = (await db.execute(select(User).where(User.id.in_(ids)).order_by(User.username))).scalars().all() if ids else []
    allowed = await access.voice_user_ids(db, list(ids), cs)
    ring, skip = [], []
    for u in users:
        if u.disabled or u.id not in allowed or await either(db, caller.id, u.id):
            skip.append(u)
        else:
            ring.append(u)
    return ring, skip


async def _busy(db: AsyncSession, user_ids: list[uuid.UUID], except_call: uuid.UUID) -> set[uuid.UUID]:
    """Who's already talking: in another call, or a voice channel."""
    from app.calls import voice

    out: set[uuid.UUID] = set()
    if user_ids:
        q = (
            select(CallParticipant.user_id)
            .join(Call, Call.id == CallParticipant.call_id)
            .where(
                CallParticipant.user_id.in_(user_ids),
                CallParticipant.in_call_since.is_not(None),
                Call.ended_at.is_(None),
                Call.id != except_call,
            )
        )
        out |= set((await db.execute(q)).scalars().all())  # type: ignore[arg-type]
    for uid in user_ids:
        if uid not in out and await voice.where(uid) is not None:
            out.add(uid)
    return out


# ================================================================ start / join


async def leave_elsewhere(db: AsyncSession, user: User, *, keep_call: uuid.UUID | None = None, voice_too: bool = True) -> None:
    """One live conversation at a time: out of any other call (and, with
    ``voice_too``, any voice channel). Runs before the new call's lock is
    taken, so two people swapping calls can't deadlock."""
    q = (
        select(CallParticipant.call_id)
        .join(Call, Call.id == CallParticipant.call_id)
        .where(CallParticipant.user_id == user.id, CallParticipant.in_call_since.is_not(None), Call.ended_at.is_(None), Call.kind == "dm")
    )
    for cid in (await db.execute(q)).scalars().all():
        if cid != keep_call:
            await leave(db, user, cid, reason="elsewhere", notify=True)
    if voice_too:
        from app.calls import voice

        if await voice.where(user.id) is not None:
            await voice.drop(db, user.id, reason="call")


async def start(db: AsyncSession, user: User, room: Room, cs: access.CallsSettings, media: str, device: str) -> dict:
    """Call the conversation: rings everyone else for 45 s and connects
    you. If the conversation already has a live call (they called you at
    the same moment, or a group call is on), you join that one instead."""
    if not is_dm_room(room):
        raise not_found()
    why = await refusal(db, room, user.id)
    if why:
        raise CallError(403, why)
    targets, skipped = await _ringable(db, room, user, cs)
    existing = await live_call_of_room(db, room.id)
    if existing is None and not targets:
        if room.kind == "dm":
            name = skipped[0].username if skipped else "They"
            raise CallError(409, f"{name} can't take calls right now")
        raise CallError(409, "Nobody in this conversation can take a call right now")
    await leave_elsewhere(db, user, keep_call=existing.id if existing else None)
    # The room's row lock makes two people calling at once meet in one call.
    await db.execute(select(Room.id).where(Room.id == room.id).with_for_update())
    existing = await live_call_of_room(db, room.id)
    if existing is not None:
        await db.commit()
        return await join(db, user, existing.id, cs, device)
    now = _now()
    call = Call(id=uuid.uuid4(), kind="dm", room_id=room.id, started_by=user.id, media=media if media in MEDIA else "audio", started_at=now)
    call.lk_room = lk_room(call.id)
    db.add(call)
    await db.flush()
    # Same keys in every row, through the table (not the ORM's bulk insert,
    # which would let the server default fill a NULL first_joined_at).
    rows = [
        {
            "call_id": call.id, "identity": identity(user.id), "user_id": user.id, "display_name": user.username[:120],
            "ring": "answered", "rung_at": None, "first_joined_at": now, "in_call_since": now, "session": uuid.uuid4().hex,
            "device": device if device in DEVICES else "web",
        }
    ]
    for t in targets:
        rows.append(
            {
                "call_id": call.id, "identity": identity(t.id), "user_id": t.id, "display_name": t.username[:120],
                "ring": "ringing", "rung_at": now, "first_joined_at": None, "in_call_since": None, "session": None, "device": None,
            }
        )
    await db.execute(insert(CallParticipant.__table__), rows)
    # A call re-opens a closed conversation for everyone, like a message.
    await db.execute(update(RoomMember).where(RoomMember.room_id == room.id, RoomMember.hidden.is_(True)).values(hidden=False))
    await db.commit()
    await redis.sadd(K_LIVE, str(call.id))
    parts = await _parts(db, call.id)
    from app.calls import ring

    busy = await _busy(db, [t.id for t in targets], call.id)
    await ring.ring(db, call, room, user, targets, busy=busy, parts=parts)
    await _defer("call_ring_timeout", str(call.id), now.isoformat(), seconds=RING_SECONDS)
    await _publish_state(db, call, room)
    return join_out(user, call, room, parts, cs)


async def join(db: AsyncSession, user: User, call_id: uuid.UUID, cs: access.CallsSettings, device: str) -> dict:
    """Answer a call ringing you, join a live group call, or move a call
    you're in to this device."""
    call, room = await visible_call(db, user, call_id)
    if call.ended_at is not None:
        raise CallError(409, "This call has ended")
    why = await refusal(db, room, user.id)
    if why:
        raise CallError(403, why)
    await leave_elsewhere(db, user, keep_call=call.id)
    call = await _lock_call(db, call_id)
    if call is None:
        raise not_found()
    if call.ended_at is not None:
        await db.commit()
        raise CallError(409, "This call has ended")
    parts = await _parts(db, call.id)
    me = parts.get(user.id)
    others_in = [p for p in _present(parts) if p.user_id != user.id]
    if len(others_in) + 1 > cs.max_participants:
        await db.commit()
        raise CallError(409, "This call is full")
    now = _now()
    was_ringing = me is not None and me.ring == "ringing"
    old_session = me.session if me is not None and me.in_call_since is not None else None
    old_sid = me.lk_sid if me is not None and me.in_call_since is not None else None
    if me is None:
        # Someone who wasn't rung (joined later, or added to the group).
        await db.execute(
            insert(CallParticipant).values(
                call_id=call.id, identity=identity(user.id), user_id=user.id, display_name=user.username[:120], first_joined_at=now
            )
        )
        parts = await _parts(db, call.id)
        me = parts[user.id]
    me.ring = "answered"
    me.first_joined_at = me.first_joined_at or now
    me.in_call_since = me.in_call_since or now
    me.last_left_at = None
    me.session = uuid.uuid4().hex
    me.device = device if device in DEVICES else "web"
    me.lk_sid = None
    me.display_name = user.username[:120]
    if call.answered_at is None and user.id != call.started_by:
        call.answered_at = now
    await db.commit()
    if len(_present(parts)) >= 2:
        await redis.delete(K_ALONE.format(call.id))
    if was_ringing:
        from app.calls import ring

        await ring.stop(user, call, reason="answered")
    if old_session:
        # This call moved to another device: the old one hangs up quietly.
        if old_sid:
            await redis.sadd(K_STALE.format(call.id, user.id), old_sid)
            await redis.expire(K_STALE.format(call.id, user.id), STALE_SID_TTL)
        await tell(user.id, {"type": "call_disconnected", "call_id": str(call.id), "session": old_session, "reason": "replaced"})
    await _publish_state(db, call, room)
    return join_out(user, call, room, parts, cs)


# ================================================================ decline / leave / end


async def decline_by_id(db: AsyncSession, user: User, call_id: uuid.UUID) -> dict:
    """Decline a call ringing you. A 1:1 call ends ("Missed call"); a
    group call ends when nobody answered and everyone declined."""
    call, room = await visible_call(db, user, call_id)
    call = await _lock_call(db, call_id)
    if call is None:
        raise not_found()
    if call.ended_at is not None:
        await db.commit()
        raise CallError(409, "This call has ended")
    parts = await _parts(db, call.id)
    me = parts.get(user.id)
    if me is None or me.ring != "ringing":
        await db.commit()
        raise CallError(409, "This call isn't ringing you")
    me.ring = "declined"
    still_ringing = any(p.ring == "ringing" for p in parts.values())
    from app.calls import ring

    if room.kind == "dm" or (call.answered_at is None and not still_ringing):
        await _end_locked(db, call, room, parts, "declined")
        await ring.stop(user, call, reason="declined")
        return call_out(call, await _parts(db, call.id), room)
    await db.commit()
    await ring.stop(user, call, reason="declined")
    return await _publish_state(db, call, room)


async def leave(
    db: AsyncSession,
    user: User | uuid.UUID,
    call_id: uuid.UUID,
    *,
    session: str | None = None,
    reason: str = "left",
    kick: bool = True,
    notify: bool = False,
) -> bool:
    """You hang up (or your connection went). A 1:1 call ends for both; a
    group call ends with its last person (or two minutes after only one is
    left). The caller hanging up before anyone answered cancels it.
    ``session``: only if that's still your session in it. True when you
    were taken out."""
    uid = user.id if isinstance(user, User) else user
    call = await _lock_call(db, call_id)
    if call is None or call.ended_at is not None:
        await db.commit()
        return False
    parts = await _parts(db, call.id)
    me = parts.get(uid)
    if me is None or me.in_call_since is None or (session is not None and me.session != session):
        await db.commit()
        return False
    old_session = me.session
    _mark_left(me, _now())
    room = await db.get(Room, call.room_id) if call.room_id else None
    left = _present(parts)
    if call.answered_at is None:
        if not left:
            await _end_locked(db, call, room, parts, "cancelled" if uid == call.started_by else "missed", kick_out=kick)
            await _after_leave(call, uid, old_session, reason, kick, notify)
            return True
    elif room is None or room.kind == "dm" or not left:
        await _end_locked(db, call, room, parts, "completed", kick_out=kick)
        await _after_leave(call, uid, old_session, reason, kick, notify)
        return True
    await db.commit()
    await _after_leave(call, uid, old_session, reason, kick, notify)
    if len(left) == 1 and call.answered_at is not None:
        await _start_alone(call.id)
    if room is not None:
        await _publish_state(db, call, room)
    return True


async def _after_leave(call: Call, uid: uuid.UUID, session: str | None, reason: str, kick: bool, notify: bool) -> None:
    if kick:
        await _kick(call.id, uid)
    if notify:
        await tell(uid, {"type": "call_disconnected", "call_id": str(call.id), "session": session, "reason": reason})


def _mark_left(p: CallParticipant, now: datetime) -> None:
    if p.in_call_since is not None:
        p.seconds = (p.seconds or 0) + min(24 * 3600, max(0, int((now - p.in_call_since).total_seconds())))
    p.in_call_since = None
    p.last_left_at = now
    p.lk_sid = None


async def end(db: AsyncSession, user: User, call_id: uuid.UUID) -> dict:
    """End the call for everyone: anyone in a 1:1 call, or whoever started
    a group call. (Others in a group call leave instead.)"""
    call, room = await visible_call(db, user, call_id)
    call = await _lock_call(db, call_id)
    if call is None:
        raise not_found()
    if call.ended_at is not None:
        await db.commit()
        raise CallError(409, "This call has ended")
    parts = await _parts(db, call.id)
    me = parts.get(user.id)
    if room.kind == "dm":
        if me is not None and me.ring == "ringing":
            await db.commit()
            return await decline_by_id(db, user, call_id)
        if me is None or me.in_call_since is None:
            await db.commit()
            raise CallError(409, "You're not in this call")
    elif call.started_by != user.id:
        await db.commit()
        raise CallError(403, "Only the person who started the call can end it for everyone")
    reason = "completed" if call.answered_at is not None else "cancelled"
    await _end_locked(db, call, room, parts, reason)
    return call_out(call, await _parts(db, call.id), room)


async def _end_locked(
    db: AsyncSession,
    call: Call,
    room: Room | None,
    parts: dict[uuid.UUID, CallParticipant],
    reason: str,
    *,
    kick_out: bool = True,
    newly_missed: list[CallParticipant] | None = None,
) -> None:
    """End the call (its row is locked): everyone still in it is out, anyone
    still ringing missed it. Commits, then tells everyone, posts the line
    in the conversation and sends the missed-call pushes."""
    now = _now()
    call.ended_at = now
    call.ended_reason = reason
    missed = list(newly_missed or [])
    for p in parts.values():
        if p.in_call_since is not None:
            _mark_left(p, now)
        if p.ring == "ringing":
            p.ring = "missed"
            missed.append(p)
    await db.commit()
    await redis.srem(K_LIVE, str(call.id))
    await redis.delete(K_ALONE.format(call.id))
    if kick_out:
        await _close_room(call.id)
    if room is None:
        return
    from app.calls import ring

    try:
        await ring.post_line(db, call, room, parts)
    except Exception:  # noqa: BLE001 — the line must never block ending
        logger.warning("call line not posted for %s", call.id, exc_info=True)
        await db.rollback()
    await ring.missed(db, call, room, [p.user_id for p in missed if p.user_id])
    await _publish_state(db, call, room, kind="call_ended")


# ================================================================ ring again (group)


async def ring_again(db: AsyncSession, user: User, call_id: uuid.UUID, user_ids: list[uuid.UUID] | None, cs: access.CallsSettings) -> dict:
    """Ring people in the conversation who aren't in the call (a group
    call's "Ring" button). You must be in the call."""
    call, room = await visible_call(db, user, call_id)
    call = await _lock_call(db, call_id)
    if call is None:
        raise not_found()
    if call.ended_at is not None:
        await db.commit()
        raise CallError(409, "This call has ended")
    parts = await _parts(db, call.id)
    me = parts.get(user.id)
    if me is None or me.in_call_since is None:
        await db.commit()
        raise CallError(409, "Join the call to ring people")
    targets, _skip = await _ringable(db, room, user, cs)
    wanted = set(user_ids) if user_ids else None
    now = _now()
    rung: list[User] = []
    for t in targets:
        if wanted is not None and t.id not in wanted:
            continue
        p = parts.get(t.id)
        if p is not None and p.in_call_since is not None:
            continue
        if p is not None and p.ring == "ringing" and p.rung_at and (now - p.rung_at).total_seconds() < RERING_AFTER:
            continue
        if p is None:
            await db.execute(
                insert(CallParticipant).values(
                    call_id=call.id, identity=identity(t.id), user_id=t.id, display_name=t.username[:120],
                    ring="ringing", rung_at=now, first_joined_at=None,
                )
            )
        else:
            p.ring = "ringing"
            p.rung_at = now
        rung.append(t)
    await db.commit()
    parts = await _parts(db, call.id)
    if rung:
        from app.calls import ring

        busy = await _busy(db, [t.id for t in rung], call.id)
        await ring.ring(db, call, room, user, rung, busy=busy, parts=parts)
        await _defer("call_ring_timeout", str(call.id), now.isoformat(), seconds=RING_SECONDS)
    out = await _publish_state(db, call, room)
    out["rang"] = [str(t.id) for t in rung]
    return out


# ================================================================ timers (arq jobs)


async def ring_timeout(call_id: str, marker: str) -> str:
    """45 s after a ring: anyone it rang who's still ringing missed it. A
    call nobody answered ends ("Missed call")."""
    from app.database import SessionLocal

    try:
        cid = uuid.UUID(call_id)
        at = datetime.fromisoformat(marker)
    except ValueError:
        return "bad args"
    async with SessionLocal() as db:
        call = await _lock_call(db, cid)
        if call is None or call.ended_at is not None:
            await db.commit()
            return "stale"
        parts = await _parts(db, call.id)
        due = [p for p in parts.values() if p.ring == "ringing" and p.rung_at is not None and p.rung_at <= at + timedelta(milliseconds=1)]
        if not due:
            await db.commit()
            return "nothing"
        for p in due:
            p.ring = "missed"
        room = await db.get(Room, call.room_id) if call.room_id else None
        still = any(p.ring == "ringing" for p in parts.values())
        if call.answered_at is None and not still:
            await _end_locked(db, call, room, parts, "missed", newly_missed=due)
            return "missed"
        await db.commit()
        if room is not None:
            from app.calls import ring

            await ring.missed(db, call, room, [p.user_id for p in due if p.user_id])
            await _publish_state(db, call, room)
        return "missed some"


async def _start_alone(call_id: uuid.UUID) -> None:
    token = uuid.uuid4().hex
    await redis.set(K_ALONE.format(call_id), token, ex=ALONE_SECONDS + 3600)
    await _defer("call_alone_check", str(call_id), token, seconds=ALONE_SECONDS)


async def alone_check(call_id: str, token: str) -> str:
    """Two minutes after a group call was left with one person: still
    alone, the call ends."""
    from app.database import SessionLocal

    if await redis.get(K_ALONE.format(call_id)) != token:
        return "stale"
    async with SessionLocal() as db:
        call = await _lock_call(db, uuid.UUID(call_id))
        if call is None or call.ended_at is not None:
            await db.commit()
            return "stale"
        parts = await _parts(db, call.id)
        if len(_present(parts)) > 1:
            await db.commit()
            return "not alone"
        room = await db.get(Room, call.room_id) if call.room_id else None
        await _end_locked(db, call, room, parts, "completed")
        return "ended"


# ================================================================ Android (session) and the push's Answer


async def refresh(db: AsyncSession, token: str) -> dict:
    """A fresh LiveKit token for a call session (the Android service)."""
    claims = read_session(token)
    if claims is None:
        raise not_found()
    uid, cid = uuid.UUID(claims["sub"]), uuid.UUID(claims["call"])
    user = await db.get(User, uid)
    call = await db.get(Call, cid)
    if user is None or user.disabled or call is None or call.ended_at is not None:
        raise not_found()
    room = await db.get(Room, call.room_id) if call.room_id else None
    parts = await _parts(db, cid)
    me = parts.get(uid)
    cs = await access.load_settings(db)
    if (
        me is None or me.in_call_since is None or me.session != claims["sid"] or room is None
        or not await _is_member(db, room, uid) or not await access.voice_allowed(db, user, cs) or await refusal(db, room, uid)
    ):
        raise not_found()
    out = join_out(user, call, room, parts, cs)
    out["session"] = token
    return out


async def session_leave(db: AsyncSession, token: str) -> bool:
    claims = read_session(token)
    if claims is None:
        raise not_found()
    return await leave(db, uuid.UUID(claims["sub"]), uuid.UUID(claims["call"]), session=claims["sid"])


async def answer_with_token(db: AsyncSession, token: str, device: str) -> dict:
    """Answer from the ringing push's own token (the Android incoming-call
    screen, or a page opened from the push), with no bearer."""
    from app.notifications import actions

    try:
        claims = actions.verify(token)
    except actions.ActionRefused as exc:
        raise not_found() from exc
    if claims.get("a") != "call_answer":
        raise not_found()
    user = await db.get(User, uuid.UUID(str(claims["u"])))
    if user is None or user.disabled or int(user.token_version or 0) != int(claims.get("v") or 0):
        raise not_found()
    cs = await access.load_settings(db)
    if not await access.voice_allowed(db, user, cs):
        raise not_found()
    try:
        cid = uuid.UUID(str(claims.get("t")))
    except ValueError as exc:
        raise not_found() from exc
    return await join(db, user, cid, cs, device)


async def view_token(db: AsyncSession, user: User, call_id: uuid.UUID) -> dict:
    """A listen-only second connection (``u:<id>:view``) for a page that
    shows cameras and screens while the Android service holds the audio."""
    call, _room = await visible_call(db, user, call_id)
    parts = await _parts(db, call.id)
    me = parts.get(user.id)
    if call.ended_at is not None or me is None or me.in_call_since is None:
        raise CallError(409, "You're not in this call")
    ident = names.user_identity(user.id, "view")
    return {
        "url": rtc_config.CLIENT_PATH,
        "identity": ident,
        "lk_room": lk_room(call.id),
        "token": tokens.mint(identity=ident, room=lk_room(call.id), name=user.username, sources=[]),
    }


# ================================================================ history


async def history(db: AsyncSession, user: User, *, before: datetime | None, limit: int) -> dict:
    """Your DM calls, newest first: who, incoming or outgoing, answered or
    missed, how long. ``next`` pages on (``before``)."""
    q = (
        select(CallParticipant, Call, Room)
        .join(Call, Call.id == CallParticipant.call_id)
        .join(Room, Room.id == Call.room_id)
        .where(CallParticipant.user_id == user.id, CallParticipant.hidden.is_(False), Call.kind == "dm")
        .order_by(Call.started_at.desc())
        .limit(limit + 1)
    )
    if before is not None:
        q = q.where(Call.started_at < before)
    rows = (await db.execute(q)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    room_ids = list({r.id for _p, _c, r in rows})
    members: dict[uuid.UUID, list[str]] = {}
    if room_ids:
        for rid, uid in (await db.execute(select(RoomMember.room_id, RoomMember.user_id).where(RoomMember.room_id.in_(room_ids)))).all():
            members.setdefault(rid, []).append(str(uid))
    out = []
    people: set[uuid.UUID] = set()
    for p, call, room in rows:
        outgoing = call.started_by == user.id
        if outgoing:
            outcome = "answered" if call.answered_at is not None else ("cancelled" if call.ended_reason == "cancelled" else "no_answer")
        else:
            outcome = {"answered": "answered", "declined": "declined", "missed": "missed", "ringing": "ringing"}.get(p.ring or "", "missed")
        if call.ended_at is None and outcome in ("no_answer", "missed"):
            outcome = "ringing" if p.ring == "ringing" or outgoing else "live"
        if call.started_by:
            people.add(call.started_by)
        for m in members.get(room.id, []):
            people.add(uuid.UUID(m))
        out.append(
            {
                "id": str(call.id),
                "room_id": str(room.id),
                "group": room.kind == "group",
                "name": room.name,
                "members": members.get(room.id, []),
                "media": call.media or "audio",
                "direction": "outgoing" if outgoing else "incoming",
                "outcome": outcome,
                "started_by": str(call.started_by) if call.started_by else None,
                "started_at": _iso(call.started_at),
                "ended_at": _iso(call.ended_at),
                "live": call.ended_at is None,
                "duration": duration(call),
                "my_seconds": p.seconds or 0,
            }
        )
    return {
        "calls": out,
        "users": await rooms_core.users_map(db, people),
        "next": out[-1]["started_at"] if more and out else None,
    }


async def hide(db: AsyncSession, user: User, call_id: uuid.UUID) -> None:
    """Remove a call from your history (not anyone else's)."""
    await visible_call(db, user, call_id)
    await db.execute(
        update(CallParticipant).where(CallParticipant.call_id == call_id, CallParticipant.user_id == user.id).values(hidden=True)
    )
    await db.commit()


# ================================================================ hooks from elsewhere


async def block_started(db: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> None:
    """A block between two people ends a live 1:1 call between them (and
    stops it ringing). Nobody is told why."""
    mine = select(RoomMember.room_id).where(RoomMember.user_id == a)
    theirs = select(RoomMember.room_id).where(RoomMember.user_id == b)
    rooms = select(Room.id).where(Room.space_id.is_(None), Room.kind == "dm", Room.id.in_(mine), Room.id.in_(theirs))
    calls = (await db.execute(select(Call.id).where(Call.kind == "dm", Call.ended_at.is_(None), Call.room_id.in_(rooms)))).scalars().all()
    for cid in calls:
        call = await _lock_call(db, cid)
        if call is None or call.ended_at is not None:
            await db.commit()
            continue
        room = await db.get(Room, call.room_id) if call.room_id else None
        parts = await _parts(db, cid)
        reason = "completed" if call.answered_at is not None else "cancelled"
        await _end_locked(db, call, room, parts, reason)


async def user_gone(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Out of every call (access lost, disabled)."""
    for cid in (
        await db.execute(
            select(CallParticipant.call_id)
            .join(Call, Call.id == CallParticipant.call_id)
            .where(CallParticipant.user_id == user_id, CallParticipant.in_call_since.is_not(None), Call.ended_at.is_(None), Call.kind == "dm")
        )
    ).scalars().all():
        await leave(db, user_id, cid, reason="access", notify=True)


# ================================================================ webhooks


@webhooks.on("c_")
async def on_webhook(event) -> None:  # noqa: ANN001 — livekit.api.WebhookEvent
    """LiveKit's view of a DM call: who's really connected. Our rows say who
    *may* be there; LiveKit says who *is*."""
    parsed = names.parse(event.room.name)
    if parsed is None:
        return
    try:
        cid = uuid.UUID(hex=parsed[1])
    except ValueError:
        return
    from app.database import SessionLocal

    async with SessionLocal() as db:
        call = await db.get(Call, cid)
        if event.event == "room_finished":
            return  # we close rooms ourselves; leaves arrive one by one
        if not event.HasField("participant"):
            return
        p = event.participant
        uid = names.identity_user(p.identity)
        if uid is None:
            return
        suffix = p.identity[len(identity(uid)):]
        live = call is not None and call.kind == "dm" and call.ended_at is None
        parts = await _parts(db, cid) if call is not None else {}
        me = parts.get(uid)
        present = live and me is not None and me.in_call_since is not None
        if suffix:
            # A second connection (the Android page's ``:view``): only while
            # its person is in the call.
            if event.event == "participant_joined" and not present:
                await _remove_identity(cid, p.identity)
            return
        if event.event == "participant_joined":
            if not present:
                await _kick(cid, uid)
                return
            locked = await _lock_call(db, cid)
            parts = await _parts(db, cid)
            me = parts.get(uid)
            if locked is not None and locked.ended_at is None and me is not None and me.in_call_since is not None:
                me.lk_sid = p.sid
            await db.commit()
        elif event.event == "participant_left" and present and me is not None:
            if await redis.sismember(K_STALE.format(cid, uid), p.sid):
                return  # the device this call moved away from
            if me.lk_sid in (None, p.sid):
                await leave(db, uid, cid, session=me.session, reason="lost", kick=False)


async def _remove_identity(call_id: uuid.UUID, ident: str) -> None:
    try:
        await service.remove_participant(lk_room(call_id), ident)
    except Exception:  # noqa: BLE001
        logger.info("couldn't remove %s", ident, exc_info=True)


# ================================================================ reaper


async def reap() -> dict:
    """Every few minutes (with the voice reaper): end calls whose timers
    were lost, take out people LiveKit says aren't there, and anyone who
    lost access. If LiveKit can't be reached, presence isn't touched."""
    from app.database import SessionLocal

    stats = {"calls": 0, "ended": 0, "missed": 0, "left": 0, "kicked": 0}
    async with SessionLocal() as db:
        cs = await access.load_settings(db)
        enabled = cs.enabled and rtc_config.configured()
        ids = {uuid.UUID(x) for x in await redis.smembers(K_LIVE)}
        ids |= set((await db.execute(select(Call.id).where(Call.kind == "dm", Call.ended_at.is_(None)))).scalars().all())
        now = _now()
        for cid in ids:
            call = await db.get(Call, cid)
            if call is not None:
                await db.refresh(call)
            if call is None or call.ended_at is not None:
                await redis.srem(K_LIVE, str(cid))
                continue
            stats["calls"] += 1
            room = await db.get(Room, call.room_id) if call.room_id else None
            if not enabled or room is None:
                locked = await _lock_call(db, cid)
                if locked is not None and locked.ended_at is None:
                    await _end_locked(db, locked, room, await _parts(db, cid), "ended")
                    stats["ended"] += 1
                else:
                    await db.commit()
                continue
            parts = await _parts(db, cid)
            # A ring timeout that never ran.
            late = [p for p in parts.values() if p.ring == "ringing" and p.rung_at and (now - p.rung_at).total_seconds() > RING_SECONDS + 30]
            if late:
                marker = max(p.rung_at for p in late)  # type: ignore[type-var]
                if await ring_timeout(str(cid), marker.isoformat()) in ("missed", "missed some"):  # type: ignore[union-attr]
                    stats["missed"] += 1
                await db.refresh(call)
                if call.ended_at is not None:
                    continue
                parts = await _parts(db, cid)
            # People who lost access.
            for uid, p in list(parts.items()):
                if p.in_call_since is None:
                    continue
                user = await db.get(User, uid)
                if (
                    user is None or user.disabled or not await _is_member(db, room, uid)
                    or not await access.voice_allowed(db, user, cs) or await refusal(db, room, uid)
                ):
                    if await leave(db, uid, cid, reason="access", notify=True):
                        stats["left"] += 1
            await db.refresh(call)
            if call.ended_at is not None:
                continue
            try:
                lk = await service.list_participants(lk_room(cid))
            except Exception:  # noqa: BLE001 — LiveKit down: change nothing
                logger.info("call reaper: LiveKit unavailable for %s", cid, exc_info=True)
                continue
            in_lk = {}
            for lp in lk:
                u = names.identity_user(lp.identity)
                if u is not None and lp.identity == identity(u):
                    in_lk[u] = lp
            parts = await _parts(db, cid)
            for uid, p in list(parts.items()):
                if p.in_call_since is None or uid in in_lk:
                    continue
                if (now - p.in_call_since).total_seconds() > LOST_AFTER:
                    if await leave(db, uid, cid, session=p.session, reason="lost", kick=False):
                        stats["left"] += 1
            await db.refresh(call)
            if call.ended_at is not None:
                continue
            parts = await _parts(db, cid)
            for uid in in_lk:
                p = parts.get(uid)
                if p is None or p.in_call_since is None:
                    await _kick(cid, uid)
                    stats["kicked"] += 1
    return stats
