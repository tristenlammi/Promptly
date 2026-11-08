"""Voice channels: who's in which channel right now, joining, leaving and
moving, moderation, the alone timeout, LiveKit's webhooks and the reaper.

Live state is in Redis (nothing depends on this process's memory; the arq
worker runs the timers and the reaper):

* ``voice:r:<room_id>``  hash, user id -> member JSON (see :func:`member_out`
  for what clients get; ``session`` and ``lk_sid`` stay here)
* ``voice:u:<user_id>``  where that person is: room, space, device, session
* ``voice:mod:<space>``  hash, user id -> server-mute / server-deafen; a
  space-wide flag, so leaving and rejoining doesn't lift it (as in Discord)
* ``voice:alone:<room>`` the alone-in-channel countdown
* ``voice:moveto:<user>`` an admin's move: the next join there skips the
  user limit and "admins only"
* ``voice:kicked:<user>:<room>`` someone removed (by an admin, the alone
  timeout, a newer join): their old token mustn't sneak back in
* ``voice:rooms``        set of channel ids with anyone in them (the reaper)

Every change is published on the Rooms per-person stream
(``rooms/core.py::publish``) to the space's members who have voice:
``voice_state {room_id, members}``, ``voice_speaking {room_id, user_id, on}``;
and to the person themselves: ``voice_moved``, ``voice_disconnected``,
``voice_still_there``.

The LiveKit room ``v_<room hex>`` is the media; one identity ``u:<user_id>``
per person, so a second device joining the same channel drops the first,
and :func:`join` removes you from any other channel. Moderation is enforced
by LiveKit (token grants and ``UpdateParticipant``), not just drawn.

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
from app.calls.models import BITRATES, Call, CallParticipant, RoomVoice
from app.config import get_settings
from app.redis_client import redis
from app.rooms import core as rooms_core
from app.rooms.models import Room, RoomSpace, RoomSpaceMember
from app.rtc import config as rtc_config
from app.rtc import names, service, tokens, webhooks

logger = logging.getLogger("promptly.calls.voice")

DEVICES = ("web", "android")
SESSION_TTL = timedelta(hours=12)
MOVE_GRACE = 5  # seconds before a moved person who didn't go is removed
STILL_THERE_SECONDS = 120
KICK_MEMORY = 11 * 60  # > a LiveKit token's 10-minute life
LOST_AFTER = 90  # seconds in our state without being in LiveKit = gone
SPEAKING_LIMIT = (40, 10)  # events per window seconds, per person
CONTROL_TOPIC = "voice.control"

K_ROOM = "voice:r:{}"
K_USER = "voice:u:{}"
K_MOD = "voice:mod:{}"
K_ALONE = "voice:alone:{}"
K_MOVETO = "voice:moveto:{}"
K_KICKED = "voice:kicked:{}:{}"
K_ROOMS = "voice:rooms"
K_SPEAK = "voice:spk:{}:{}"
K_AUDIENCE = "voice:aud:{}"


class VoiceError(Exception):
    """A refusal the API turns into an HTTP error."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def lk_room(room_id: uuid.UUID | str) -> str:
    return names.room_name("v_", uuid.UUID(str(room_id)))


def identity(user_id: uuid.UUID | str) -> str:
    return names.user_identity(uuid.UUID(str(user_id)))


# ================================================================ settings


def settings_out(rv: RoomVoice) -> dict:
    return {
        "user_limit": rv.user_limit,
        "quality": rv.quality,
        "bitrate": BITRATES.get(rv.quality, 64),
        "join_role": rv.join_role,
        "talk_role": rv.talk_role,
        "video": rv.video,
        "alone_minutes": rv.alone_minutes,
    }


async def voice_settings(db: AsyncSession, room: Room) -> RoomVoice:
    """A voice channel's settings row (made with the defaults if missing)."""
    rv = await db.get(RoomVoice, room.id)
    if rv is None:
        rv = RoomVoice(room_id=room.id)
        db.add(rv)
        await db.flush()
    return rv


async def settings_map(db: AsyncSession, room_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    if not room_ids:
        return {}
    rows = (await db.execute(select(RoomVoice).where(RoomVoice.room_id.in_(room_ids)))).scalars()
    got = {r.room_id: settings_out(r) for r in rows}
    for rid in room_ids:
        got.setdefault(rid, settings_out(RoomVoice(room_id=rid, user_limit=0, quality="good", join_role="member", talk_role="member", video=True, alone_minutes=15)))
    return got


# ================================================================ state


def _loads(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def member_out(m: dict) -> dict:
    """VoiceMember, as clients see it."""
    return {
        "user_id": m["user_id"],
        "muted": bool(m.get("muted")),
        "deafened": bool(m.get("deafened")),
        "server_muted": bool(m.get("server_muted")),
        "server_deafened": bool(m.get("server_deafened")),
        "video": bool(m.get("video")),
        "live": bool(m.get("live")),
        # Whose Go Live stream they're watching (for "3 watching"), or None.
        "watching": m.get("watching") or None,
        "device": m.get("device", "web"),
        "joined_at": m.get("joined_at"),
    }


async def raw_members(room_id: uuid.UUID | str) -> dict[str, dict]:
    got = await redis.hgetall(K_ROOM.format(room_id))
    out = {}
    for uid, raw in (got or {}).items():
        m = _loads(raw)
        if m:
            out[uid] = m
    return out


async def members(room_id: uuid.UUID | str) -> list[dict]:
    ms = list((await raw_members(room_id)).values())
    ms.sort(key=lambda m: m.get("joined_at") or "")
    return [member_out(m) for m in ms]


async def members_map(room_ids: list[uuid.UUID]) -> dict[str, list[dict]]:
    out = {}
    for rid in room_ids:
        ms = await members(rid)
        if ms:
            out[str(rid)] = ms
    return out


async def where(user_id: uuid.UUID | str) -> dict | None:
    """Where this person is in voice: ``{room_id, space_id, device,
    session, joined_at}``, or None."""
    return _loads(await redis.get(K_USER.format(user_id)))


async def _save_member(m: dict) -> None:
    await redis.hset(K_ROOM.format(m["room_id"]), m["user_id"], json.dumps(m))


async def mod_flags(space_id: uuid.UUID | str, user_id: uuid.UUID | str) -> dict:
    got = _loads(await redis.hget(K_MOD.format(space_id), str(user_id))) or {}
    return {"server_muted": bool(got.get("server_muted")), "server_deafened": bool(got.get("server_deafened"))}


# ================================================================ events


async def audience(db: AsyncSession, space_id: uuid.UUID, *, cached: bool = False) -> list[uuid.UUID]:
    """The space's members who have voice: who sees who's in a channel."""
    key = K_AUDIENCE.format(space_id)
    if cached:
        raw = await redis.get(key)
        if raw is not None:
            return [uuid.UUID(x) for x in json.loads(raw)]
    ids = await rooms_core.space_member_ids(db, space_id)
    allowed = await access.voice_user_ids(db, ids)
    out = [u for u in ids if u in allowed]
    await redis.set(key, json.dumps([str(u) for u in out]), ex=15)
    return out


async def publish_state(db: AsyncSession, room_id: uuid.UUID, space_id: uuid.UUID | None = None) -> None:
    if space_id is None:
        room = await db.get(Room, room_id)
        if room is None or room.space_id is None:
            return
        space_id = room.space_id
    await rooms_core.publish(
        await audience(db, space_id),
        {"type": "voice_state", "room_id": str(room_id), "members": await members(room_id)},
    )


async def tell(user_id: uuid.UUID | str, event: dict) -> None:
    """An event for one person's own clients (all their devices)."""
    await rooms_core.publish([user_id], event)


async def _send_control(room_id: uuid.UUID | str, user_id: uuid.UUID | str, payload: dict) -> bool:
    """A command to that person's LiveKit connection (the Android service
    reads these; a web client may too). Best effort."""
    try:
        await service.send_data(lk_room(room_id), json.dumps(payload).encode(), identities=[identity(user_id)], topic=CONTROL_TOPIC)
        return True
    except Exception:  # noqa: BLE001
        logger.info("voice control %s to %s not delivered", payload.get("action"), user_id, exc_info=True)
        return False


async def _kick(room_id: uuid.UUID | str, user_id: uuid.UUID | str) -> None:
    try:
        await service.remove_participant(lk_room(room_id), identity(user_id))
    except Exception:  # noqa: BLE001 — LiveKit down: the reaper tidies up
        logger.info("couldn't remove %s from %s", user_id, room_id, exc_info=True)


# ================================================================ timers


async def _defer(job: str, *args: Any, seconds: float) -> None:
    """Run an arq job later (the worker owns timers). If the queue can't be
    reached, a best-effort in-process timer instead."""
    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        await pool.enqueue_job(job, *args, _defer_by=timedelta(seconds=seconds), _job_id=f"{job}:{uuid.uuid4().hex}")
        return
    except Exception:  # noqa: BLE001
        logger.warning("voice timer %s: queue unavailable, using an in-process timer", job, exc_info=True)
    from app.background import spawn

    fn = {"voice_alone_check": alone_check, "voice_move_check": move_check}[job]

    async def later() -> None:
        await asyncio.sleep(seconds)
        await fn(*args)

    spawn(later(), name=f"{job}-{uuid.uuid4().hex[:6]}")


# ================================================================ sessions


def _session_token(user_id: uuid.UUID, room_id: uuid.UUID, session: str, device: str) -> str:
    """The voice session: lets the Android service fetch fresh LiveKit
    tokens with no bearer. Scoped to one person, one channel, one session,
    12 hours; ends when the session does (see :func:`refresh`)."""
    now = int(time.time())
    claims = {
        "typ": "voice",
        "sub": str(user_id),
        "room": str(room_id),
        "sid": session,
        "dev": device,
        "iat": now,
        "exp": now + int(SESSION_TTL.total_seconds()),
    }
    return jwt.encode(claims, get_settings().SECRET_KEY, algorithm="HS256")


def read_session(token: str) -> dict | None:
    try:
        claims = jwt.decode(token, get_settings().SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("typ") != "voice":
        return None
    return claims


# ================================================================ grants


def _sources(rv: RoomVoice, sm: RoomSpaceMember | None, flags: dict) -> list[str]:
    if not access.can_talk(rv, sm):
        return []
    out = [] if (flags["server_muted"] or flags["server_deafened"]) else [tokens.MICROPHONE]
    if access.can_video(rv, sm):
        out += [tokens.CAMERA, tokens.SCREEN, tokens.SCREEN_AUDIO]
    return out


def _mint(user: User, room_id: uuid.UUID, rv: RoomVoice, sm: RoomSpaceMember | None, flags: dict) -> str:
    return tokens.mint(
        identity=identity(user.id),
        room=lk_room(room_id),
        name=user.username,
        sources=_sources(rv, sm, flags),
        can_subscribe=not flags["server_deafened"],
        metadata=json.dumps({"user_id": str(user.id)}),
    )


async def _apply_grants(room_id: uuid.UUID, user_id: uuid.UUID, rv: RoomVoice, sm: RoomSpaceMember | None, flags: dict) -> None:
    """Make LiveKit enforce what this person may do right now."""
    try:
        await service.update_permissions(
            lk_room(room_id), identity(user_id), sources=_sources(rv, sm, flags), can_subscribe=not flags["server_deafened"]
        )
    except Exception:  # noqa: BLE001 — their next token carries it anyway
        logger.warning("couldn't update %s's voice permissions", user_id, exc_info=True)


def join_out(user: User, room: Room, rv: RoomVoice, sm: RoomSpaceMember | None, flags: dict, m: dict, cs: access.CallsSettings) -> dict:
    """Join: everything a client needs to connect."""
    return {
        "url": rtc_config.CLIENT_PATH,
        "token": _mint(user, room.id, rv, sm, flags),
        "identity": identity(user.id),
        "room_id": str(room.id),
        "space_id": str(room.space_id),
        # For the Android service's notification ("🔊 Lounge · The Lads").
        "channel_name": room.name,
        "space_name": "",  # filled by the caller
        "lk_room": lk_room(room.id),
        "session": _session_token(user.id, room.id, m["session"], m["device"]),
        "session_id": m["session"],
        "device": m["device"],
        "quality": rv.quality,
        "bitrate": BITRATES.get(rv.quality, 64),
        "can_talk": access.can_talk(rv, sm),
        "can_video": access.can_video(rv, sm),
        "server_muted": flags["server_muted"],
        "server_deafened": flags["server_deafened"],
        "max_stream": cs.max_stream,
        "members": [],  # filled by the caller
    }


# ================================================================ history


async def _open_call(db: AsyncSession, room_id: uuid.UUID) -> Call:
    q = select(Call).where(Call.room_id == room_id, Call.ended_at.is_(None))
    call = (await db.execute(q)).scalar_one_or_none()
    if call is None:
        await db.execute(
            insert(Call)
            .values(id=uuid.uuid4(), kind="voice", room_id=room_id, lk_room=lk_room(room_id))
            .on_conflict_do_nothing(index_elements=["room_id"], index_where=Call.ended_at.is_(None))
        )
        call = (await db.execute(q)).scalar_one()
    return call


async def _history_join(db: AsyncSession, room_id: uuid.UUID, user: User) -> None:
    call = await _open_call(db, room_id)
    await db.execute(
        insert(CallParticipant)
        .values(call_id=call.id, identity=identity(user.id), user_id=user.id, display_name=user.username[:120])
        .on_conflict_do_update(
            index_elements=["call_id", "identity"],
            set_={"last_left_at": None, "display_name": user.username[:120]},
        )
    )


async def _history_leave(db: AsyncSession, m: dict, *, room_empty: bool) -> None:
    joined = m.get("joined_at")
    try:
        secs = max(0, int((_now() - datetime.fromisoformat(joined)).total_seconds())) if joined else 0
    except ValueError:
        secs = 0
    call = (await db.execute(select(Call).where(Call.room_id == uuid.UUID(m["room_id"]), Call.ended_at.is_(None)))).scalar_one_or_none()
    if call is None:
        return
    await db.execute(
        update(CallParticipant)
        .where(CallParticipant.call_id == call.id, CallParticipant.identity == identity(m["user_id"]))
        .values(seconds=CallParticipant.seconds + min(secs, 24 * 3600), last_left_at=_now())
    )
    if room_empty:
        call.ended_at = _now()


async def _close_call(db: AsyncSession, room_id: uuid.UUID) -> None:
    await db.execute(update(Call).where(Call.room_id == room_id, Call.ended_at.is_(None)).values(ended_at=_now()))


# ================================================================ alone timeout


async def _alone_recompute(db: AsyncSession, room_id: uuid.UUID, rv: RoomVoice | None = None) -> None:
    """Start the countdown when one person is left alone in a channel;
    stop it when anyone else is there (or nobody is)."""
    key = K_ALONE.format(room_id)
    ids = list((await raw_members(room_id)).keys())
    if len(ids) != 1:
        await redis.delete(key)
        return
    if rv is None:
        rv = await db.get(RoomVoice, room_id)
    minutes = rv.alone_minutes if rv is not None else None
    if not minutes:
        await redis.delete(key)
        return
    cur = _loads(await redis.get(key))
    if cur and cur.get("user_id") == ids[0]:
        return  # already counting for them
    await _start_alone(room_id, ids[0], minutes)


async def _start_alone(room_id: uuid.UUID | str, user_id: str, minutes: int) -> None:
    token = uuid.uuid4().hex
    await redis.set(
        K_ALONE.format(room_id),
        json.dumps({"user_id": user_id, "token": token, "phase": "wait", "since": _now().isoformat(), "minutes": minutes}),
        ex=minutes * 60 + 3600,
    )
    await _defer("voice_alone_check", str(room_id), token, seconds=minutes * 60)


async def alone_check(room_id: str, token: str) -> str:
    """The arq job: after the channel's alone time, ask "Still there?";
    two minutes later, if nobody answered and they're still alone, leave."""
    key = K_ALONE.format(room_id)
    cur = _loads(await redis.get(key))
    if not cur or cur.get("token") != token:
        return "stale"
    ids = list((await raw_members(room_id)).keys())
    if ids != [cur["user_id"]]:
        await redis.delete(key)
        return "not alone"
    if cur["phase"] == "wait":
        new = uuid.uuid4().hex
        deadline = _now() + timedelta(seconds=STILL_THERE_SECONDS)
        cur.update(token=new, phase="asked", deadline=deadline.isoformat())
        await redis.set(key, json.dumps(cur), ex=STILL_THERE_SECONDS + 3600)
        event = {"type": "voice_still_there", "room_id": room_id, "deadline": deadline.isoformat(), "seconds": STILL_THERE_SECONDS}
        await tell(cur["user_id"], event)
        m = (await raw_members(room_id)).get(cur["user_id"]) or {}
        if m.get("device") == "android":
            await _send_control(room_id, cur["user_id"], {"action": "still_there", "seconds": STILL_THERE_SECONDS})
        await _defer("voice_alone_check", room_id, new, seconds=STILL_THERE_SECONDS)
        return "asked"
    from app.database import SessionLocal

    async with SessionLocal() as db:
        await drop(db, uuid.UUID(cur["user_id"]), reason="alone", only_room=uuid.UUID(room_id))
    return "disconnected"


async def still_here(db: AsyncSession, user: User) -> dict:
    cur = await where(user.id)
    if cur is None:
        raise VoiceError(404, "You're not in a voice channel")
    rid = cur["room_id"]
    alone = _loads(await redis.get(K_ALONE.format(rid)))
    if alone and alone.get("user_id") == str(user.id):
        await _start_alone(rid, str(user.id), int(alone.get("minutes") or 15))
    # Answered on one device (the phone's notification, say): the question
    # goes away on the others.
    await tell(user.id, {"type": "voice_still_here", "room_id": rid})
    return {"ok": True}


# ================================================================ join / leave


async def _lock(user_id: uuid.UUID | str):  # noqa: ANN202
    return redis.lock(f"voice:lock:{user_id}", timeout=20, blocking_timeout=10)


async def join(db: AsyncSession, user: User, room: Room, sm: RoomSpaceMember, cs: access.CallsSettings, device: str) -> dict:
    """Join (or move to) a voice channel. Removes you from any other
    channel, and replaces this channel's connection on another device."""
    rv = await voice_settings(db, room)
    # One live conversation at a time: joining a channel hangs up a DM call.
    from app.calls import dm

    await dm.leave_elsewhere(db, user, voice_too=False)
    async with await _lock(user.id):
        return await _join_locked(db, user, room, sm, rv, cs, device)


async def _join_locked(
    db: AsyncSession,
    user: User,
    room: Room,
    sm: RoomSpaceMember,
    rv: RoomVoice,
    cs: access.CallsSettings,
    device: str,
    *,
    kick_old: bool = True,
    notify_old: bool = True,
) -> dict:
    moved_here = await redis.get(K_MOVETO.format(user.id)) == str(room.id)
    if not moved_here:
        if not access.can_join(rv, sm):
            raise VoiceError(403, f"Only admins can join {room.name}")
        others = [u for u in (await raw_members(room.id)) if u != str(user.id)]
        if access.over_limit(rv, sm, len(others), cs.max_participants):
            raise VoiceError(409, f"{room.name} is full")

    cur = await where(user.id)
    if cur is not None:
        # Your other channel, or this one on another device (or a reload).
        await _drop_locked(
            db, user.id, cur, reason="replaced", kick=kick_old, notify=notify_old, remember=cur["room_id"] != str(room.id)
        )
    await redis.delete(K_MOVETO.format(user.id), K_KICKED.format(user.id, room.id))

    flags = await mod_flags(room.space_id, user.id)
    session = uuid.uuid4().hex
    m = {
        "user_id": str(user.id),
        "room_id": str(room.id),
        "space_id": str(room.space_id),
        "muted": False,
        "deafened": False,
        **flags,
        "video": False,
        "live": False,
        "device": device,
        "joined_at": _now().isoformat(),
        "session": session,
        "lk_sid": "",
    }
    await _save_member(m)
    await redis.set(
        K_USER.format(user.id),
        json.dumps({k: m[k] for k in ("room_id", "space_id", "device", "session", "joined_at")}),
    )
    await redis.sadd(K_ROOMS, str(room.id))
    await _history_join(db, room.id, user)
    await db.commit()
    await _alone_recompute(db, room.id, rv)
    await publish_state(db, room.id, room.space_id)
    out = join_out(user, room, rv, sm, flags, m, cs)
    out["members"] = await members(room.id)
    out["space_name"] = await _space_name(db, room)
    return out


async def _space_name(db: AsyncSession, room: Room) -> str:
    space = await db.get(RoomSpace, room.space_id) if room.space_id else None
    return space.name if space is not None else ""


async def drop(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    reason: str,
    only_room: uuid.UUID | None = None,
    only_session: str | None = None,
    kick: bool = True,
    notify: bool = True,
    by: uuid.UUID | None = None,
) -> bool:
    """Take someone out of voice. ``only_room`` / ``only_session``: only if
    that's still where they are (a late timer or webhook mustn't remove a
    newer session). True when they were removed."""
    async with await _lock(user_id):
        cur = await where(user_id)
        if cur is None:
            return False
        if only_room is not None and cur["room_id"] != str(only_room):
            return False
        if only_session is not None and cur["session"] != only_session:
            return False
        await _drop_locked(db, user_id, cur, reason=reason, kick=kick, notify=notify, by=by)
        return True


async def _drop_locked(
    db: AsyncSession,
    user_id: uuid.UUID | str,
    cur: dict,
    *,
    reason: str,
    kick: bool,
    notify: bool,
    by: uuid.UUID | None = None,
    remember: bool = True,
) -> None:
    rid = cur["room_id"]
    raw = await redis.hget(K_ROOM.format(rid), str(user_id))
    await redis.hdel(K_ROOM.format(rid), str(user_id))
    await redis.delete(K_USER.format(user_id))
    left = await redis.hlen(K_ROOM.format(rid))
    if not left:
        await redis.srem(K_ROOMS, rid)
    m = _loads(raw) or {**cur, "user_id": str(user_id)}
    try:
        await _history_leave(db, {**m, "room_id": rid, "user_id": str(user_id)}, room_empty=not left)
        await db.commit()
    except Exception:  # noqa: BLE001 — history must never block leaving
        logger.warning("voice history not written", exc_info=True)
        await db.rollback()
    if remember and reason in ("admin", "alone", "replaced", "moved", "access", "voice_off"):
        # Their LiveKit token is still good for a few minutes: don't let it
        # sneak back in (see on_webhook).
        await redis.set(K_KICKED.format(user_id, rid), cur.get("session", ""), ex=KICK_MEMORY)
    if kick:
        await _kick(rid, user_id)
    if notify:
        event = {"type": "voice_disconnected", "room_id": rid, "session": cur.get("session"), "reason": reason}
        if by is not None:
            event["by"] = str(by)
        await tell(user_id, event)
        if cur.get("device") == "android" and not kick:
            await _send_control(rid, user_id, {"action": "leave", "reason": reason})
    await _stop_watching(rid, str(user_id))
    space_id = uuid.UUID(cur["space_id"]) if cur.get("space_id") else None
    await publish_state(db, uuid.UUID(rid), space_id)
    await _alone_recompute(db, uuid.UUID(rid))


async def leave(db: AsyncSession, user: User, session: str | None = None) -> bool:
    """You leave (from any of your devices, or the page as the Android
    service's remote). With ``session``: only that session."""
    return await drop(db, user.id, reason="left", only_session=session, notify=True)


async def refresh(db: AsyncSession, token: str) -> dict:
    """A fresh LiveKit token for a voice session (the Android service).
    The session is the key: it must still be your current one, and you
    must still be allowed in the channel."""
    claims = read_session(token)
    if claims is None:
        raise VoiceError(404, "Voice session not found")
    uid = uuid.UUID(claims["sub"])
    cur = await where(uid)
    if cur is None or cur["session"] != claims["sid"] or cur["room_id"] != claims["room"]:
        raise VoiceError(404, "Voice session not found")
    user = await db.get(User, uid)
    room = await db.get(Room, uuid.UUID(claims["room"]))
    if user is None or user.disabled or room is None or room.kind != "voice" or room.space_id is None:
        await drop(db, uid, reason="access", only_session=claims["sid"])
        raise VoiceError(404, "Voice session not found")
    sm = await rooms_core.space_member(db, room.space_id, uid)
    cs = await access.load_settings(db)
    rv = await voice_settings(db, room)
    if sm is None or not await access.voice_allowed(db, user, cs) or not access.can_join(rv, sm):
        await drop(db, uid, reason="access", only_session=claims["sid"])
        raise VoiceError(404, "Voice session not found")
    m = (await raw_members(room.id)).get(str(uid)) or {"session": cur["session"], "device": cur["device"]}
    flags = await mod_flags(room.space_id, uid)
    out = join_out(user, room, rv, sm, flags, {**m, "session": cur["session"], "device": cur["device"]}, cs)
    out["session"] = token  # unchanged: it's the same session
    out["members"] = await members(room.id)
    out["space_name"] = await _space_name(db, room)
    return out


async def view_token(db: AsyncSession, user: User, room: Room) -> dict:
    """A second, listen-only connection (``u:<id>:view``) for a page that
    shows cameras and streams while the Android service holds the audio."""
    cur = await where(user.id)
    if cur is None or cur["room_id"] != str(room.id):
        raise VoiceError(404, "You're not in this voice channel")
    flags = await mod_flags(room.space_id, user.id)
    ident = names.user_identity(user.id, "view")
    return {
        "url": rtc_config.CLIENT_PATH,
        "identity": ident,
        "lk_room": lk_room(room.id),
        "token": tokens.mint(identity=ident, room=lk_room(room.id), name=user.username, sources=[], can_subscribe=not flags["server_deafened"]),
    }


# ================================================================ reports


async def _mine(db: AsyncSession, user: User, session: str | None) -> tuple[dict, Room, RoomSpaceMember, RoomVoice]:
    cur = await where(user.id)
    if cur is None or (session and cur["session"] != session):
        raise VoiceError(404, "You're not in a voice channel")
    room = await db.get(Room, uuid.UUID(cur["room_id"]))
    sm = await rooms_core.space_member(db, room.space_id, user.id) if room is not None and room.space_id else None
    if room is None or sm is None:
        await drop(db, user.id, reason="access")
        raise VoiceError(404, "You're not in a voice channel")
    rv = await voice_settings(db, room)
    return cur, room, sm, rv


async def report_state(
    db: AsyncSession,
    user: User,
    *,
    session: str | None,
    muted: bool | None,
    deafened: bool | None,
    video: bool | None,
    live: bool | None,
    watching: str | None = None,
) -> dict:
    """Your client says what it's doing. Server-mute/deafen are the admins'
    and aren't touched; video and Go Live only where allowed. ``watching``:
    the user id whose stream you're watching, "" to stop."""
    cur, room, sm, rv = await _mine(db, user, session)
    everyone = await raw_members(room.id)
    m = everyone.get(str(user.id))
    if m is None:
        raise VoiceError(404, "You're not in a voice channel")
    if watching is not None:
        target = everyone.get(watching)
        ok = target is not None and target.get("live") and watching != str(user.id)
        m["watching"] = watching if ok else None
    if muted is not None:
        m["muted"] = muted
    if deafened is not None:
        m["deafened"] = deafened
    if m["deafened"]:
        m["muted"] = True  # deafen mutes you too
    allowed_video = access.can_video(rv, sm)
    if video is not None:
        m["video"] = bool(video) and allowed_video
    if live is not None:
        m["live"] = bool(live) and allowed_video
    await _save_member(m)
    if not m["live"]:
        await _stop_watching(room.id, str(user.id))
    await publish_state(db, room.id, room.space_id)
    return member_out(m)


async def _stop_watching(room_id: uuid.UUID | str, streamer: str) -> None:
    """A stream ended (or its streamer left): nobody's watching it."""
    for _uid, m in (await raw_members(room_id)).items():
        if m.get("watching") == streamer:
            m["watching"] = None
            await _save_member(m)


async def speaking(db: AsyncSession, user: User, on: bool) -> bool:
    """Your speaking edge, fanned out for the rings. False when dropped
    (muted, or over the rate limit is an error)."""
    window = int(time.time()) // SPEAKING_LIMIT[1]
    key = K_SPEAK.format(user.id, window)
    n = await redis.incr(key)
    if n == 1:
        await redis.expire(key, SPEAKING_LIMIT[1] * 2)
    if n > SPEAKING_LIMIT[0]:
        raise VoiceError(429, "Too many speaking updates")
    cur = await where(user.id)
    if cur is None:
        raise VoiceError(404, "You're not in a voice channel")
    m = (await raw_members(cur["room_id"])).get(str(user.id)) or {}
    if on and (m.get("muted") or m.get("deafened") or m.get("server_muted") or m.get("server_deafened")):
        return False
    space_id = uuid.UUID(cur["space_id"])
    await rooms_core.publish(
        await audience(db, space_id, cached=True),
        {"type": "voice_speaking", "room_id": cur["room_id"], "user_id": str(user.id), "on": bool(on)},
    )
    return True


async def control(db: AsyncSession, user: User, action: str) -> dict:
    """Remote control of your own connection (the page driving the Android
    service): mute, unmute, deafen, undeafen, leave."""
    cur = await where(user.id)
    if cur is None:
        raise VoiceError(404, "You're not in a voice channel")
    if action == "leave":
        await leave(db, user)
        return {"ok": True, "delivered": True}
    delivered = await _send_control(cur["room_id"], user.id, {"action": action})
    return {"ok": True, "delivered": delivered}


# ================================================================ moderation


async def moderate(db: AsyncSession, room: Room, target: uuid.UUID, *, server_mute: bool | None, server_deafen: bool | None) -> dict:
    """Server-mute / server-deafen someone in this space. Space-wide, like
    Discord: it stays when they leave and come back, until an admin lifts
    it. Enforced in LiveKit at once if they're connected."""
    key = K_MOD.format(room.space_id)
    flags = await mod_flags(room.space_id, target)
    if server_mute is not None:
        flags["server_muted"] = server_mute
    if server_deafen is not None:
        flags["server_deafened"] = server_deafen
    if flags["server_muted"] or flags["server_deafened"]:
        await redis.hset(key, str(target), json.dumps(flags))
    else:
        await redis.hdel(key, str(target))
    cur = await where(target)
    if cur is not None and cur.get("space_id") == str(room.space_id):
        rid = uuid.UUID(cur["room_id"])
        m = (await raw_members(rid)).get(str(target))
        if m is not None:
            m.update(flags)
            await _save_member(m)
        in_room = await db.get(Room, rid)
        if in_room is not None:
            tsm = await rooms_core.space_member(db, room.space_id, target)
            await _apply_grants(rid, target, await voice_settings(db, in_room), tsm, flags)
        await publish_state(db, rid, room.space_id)
    return flags


async def move(db: AsyncSession, room: Room, target: uuid.UUID, to_room: Room, by: User) -> dict:
    """Move someone to another voice channel of the space. A web client
    gets ``voice_moved`` and rejoins there (skipping the user limit); the
    Android service is moved by the server. Anyone who doesn't go within
    five seconds is removed from the old channel."""
    cur = await where(target)
    if cur is None or cur["room_id"] != str(room.id):
        raise VoiceError(404, "They're not in this channel")
    await redis.set(K_MOVETO.format(target), str(to_room.id), ex=60)
    event = {"type": "voice_moved", "from_room_id": str(room.id), "to_room_id": str(to_room.id), "by": str(by.id), "session": cur["session"]}
    if cur.get("device") == "android":
        tuser = await db.get(User, target)
        tsm = await rooms_core.space_member(db, to_room.space_id, target)
        cs = await access.load_settings(db)
        rv = await voice_settings(db, to_room)
        async with await _lock(target):
            j = await _join_locked(db, tuser, to_room, tsm, rv, cs, "android", kick_old=False, notify_old=False)
        # The service is still connected to the old room: tell it there.
        await _send_control(room.id, target, {"action": "move", "room_id": str(to_room.id), "lk_room": j["lk_room"], "token": j["token"], "session": j["session"]})
        event["handled"] = True
        event["session"] = j["session_id"]
    await tell(target, event)
    await _defer("voice_move_check", str(target), str(room.id), cur["session"], seconds=MOVE_GRACE)
    return {"ok": True}


async def move_check(user_id: str, from_room: str, session: str) -> str:
    """The arq job after a move: anyone still in the old channel (the
    same session) is removed; a stale old connection is kicked."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        if await drop(db, uuid.UUID(user_id), reason="moved", only_room=uuid.UUID(from_room), only_session=session, notify=True):
            return "removed"
    cur = await where(user_id)
    if cur is None or cur["room_id"] != from_room:
        # They're elsewhere (or gone): make sure the old connection is too.
        await _kick(from_room, user_id)
    return "moved"


async def disconnect(db: AsyncSession, room: Room, target: uuid.UUID, by: User) -> None:
    cur = await where(target)
    if cur is None or cur["room_id"] != str(room.id):
        raise VoiceError(404, "They're not in this channel")
    await drop(db, target, reason="admin", only_room=room.id, by=by.id)


# ================================================================ Rooms hooks


async def space_member_removed(db: AsyncSession, space_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Leaving or being removed from a space takes you out of its voice."""
    await redis.delete(K_AUDIENCE.format(space_id))
    cur = await where(user_id)
    if cur is not None and cur.get("space_id") == str(space_id):
        await drop(db, user_id, reason="access")


async def rooms_gone(db: AsyncSession, room_ids: list[uuid.UUID], space_id: uuid.UUID | None = None) -> None:
    """Channels deleted (or their space): everyone in them is disconnected."""
    for rid in room_ids:
        for uid, m in (await raw_members(rid)).items():
            await drop(db, uuid.UUID(uid), reason="deleted", only_room=rid)
        await redis.delete(K_ALONE.format(rid))
        await redis.srem(K_ROOMS, str(rid))
    if space_id is not None:
        await redis.delete(K_MOD.format(space_id), K_AUDIENCE.format(space_id))


async def regrant(db: AsyncSession, space_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """A role change: what they may do in the channel they're in now."""
    await redis.delete(K_AUDIENCE.format(space_id))
    cur = await where(user_id)
    if cur is None or cur.get("space_id") != str(space_id):
        return
    room = await db.get(Room, uuid.UUID(cur["room_id"]))
    sm = await rooms_core.space_member(db, space_id, user_id)
    if room is None or sm is None:
        return
    rv = await voice_settings(db, room)
    if not access.can_join(rv, sm):
        await drop(db, user_id, reason="access")
        return
    await _apply_grants(room.id, user_id, rv, sm, await mod_flags(space_id, user_id))
    await _restrict(db, room, rv)


async def settings_changed(db: AsyncSession, room: Room, rv: RoomVoice) -> None:
    """Channel settings changed: re-grant everyone in it, remove anyone no
    longer allowed in, and restart the alone countdown."""
    for uid in list((await raw_members(room.id)).keys()):
        sm = await rooms_core.space_member(db, room.space_id, uuid.UUID(uid))
        if sm is None or not access.can_join(rv, sm):
            await drop(db, uuid.UUID(uid), reason="access", only_room=room.id)
            continue
        await _apply_grants(room.id, uuid.UUID(uid), rv, sm, await mod_flags(room.space_id, uid))
    await _restrict(db, room, rv)
    await redis.delete(K_ALONE.format(room.id))
    await _alone_recompute(db, room.id, rv)


async def _restrict(db: AsyncSession, room: Room, rv: RoomVoice) -> None:
    """Video turned off, or someone can't talk any more: clear their
    camera / LIVE flags so the list doesn't show what LiveKit stopped."""
    changed = False
    for uid, m in (await raw_members(room.id)).items():
        sm = await rooms_core.space_member(db, room.space_id, uuid.UUID(uid))
        if not access.can_video(rv, sm) and (m.get("video") or m.get("live")):
            m["video"] = m["live"] = False
            await _save_member(m)
            await _stop_watching(room.id, uid)
            changed = True
    if changed:
        await publish_state(db, room.id, room.space_id)


# ================================================================ webhooks


_CAMERA = 1  # livekit TrackSource
_SCREEN = 3


@webhooks.on("v_")
async def on_webhook(event) -> None:  # noqa: ANN001 — livekit.api.WebhookEvent
    """LiveKit's view of a voice channel: who's really connected, cameras
    and streams. Our state is the truth for who *may* be there; LiveKit's
    for who *is*."""
    parsed = names.parse(event.room.name)
    if parsed is None:
        return
    try:
        room_id = uuid.UUID(hex=parsed[1])
    except ValueError:
        return
    from app.database import SessionLocal

    async with SessionLocal() as db:
        if event.event == "room_finished":
            for uid in list((await raw_members(room_id)).keys()):
                await drop(db, uuid.UUID(uid), reason="left", only_room=room_id, kick=False, notify=False)
            await _close_call(db, room_id)
            await db.commit()
            return
        if not event.HasField("participant"):
            return
        p = event.participant
        uid = names.identity_user(p.identity)
        if uid is None:
            return
        suffix = p.identity[len(identity(uid)):]
        cur = await where(uid)
        here = cur is not None and cur["room_id"] == str(room_id)
        if suffix:
            # A second connection (the Android page's ``:view``): only
            # while its person is in this channel.
            if event.event == "participant_joined" and not here:
                await _kick_identity(room_id, p.identity)
            return
        if event.event == "participant_joined":
            await _on_joined(db, room_id, uid, p.sid, cur)
        elif event.event == "participant_left":
            if here:
                m = (await raw_members(room_id)).get(str(uid)) or {}
                # Only the connection we know about: a reconnect's or a newer
                # device's join may arrive before the old one's leave.
                if m.get("lk_sid") in ("", p.sid):
                    await drop(db, uid, reason="left", only_room=room_id, only_session=cur["session"], kick=False, notify=False)
        elif event.event in ("track_published", "track_unpublished") and here and event.HasField("track"):
            src = event.track.source
            field = "video" if src == _CAMERA else "live" if src == _SCREEN else None
            if field is None:
                return
            m = (await raw_members(room_id)).get(str(uid))
            if m is None:
                return
            on = event.event == "track_published"
            if on:
                room = await db.get(Room, room_id)
                sm = await rooms_core.space_member(db, room.space_id, uid) if room is not None else None
                if room is None or not access.can_video(await voice_settings(db, room), sm):
                    on = False
            if bool(m.get(field)) != on:
                m[field] = on
                await _save_member(m)
                if field == "live" and not on:
                    await _stop_watching(room_id, str(uid))
                await publish_state(db, room_id)


async def _kick_identity(room_id: uuid.UUID, ident: str) -> None:
    try:
        await service.remove_participant(lk_room(room_id), ident)
    except Exception:  # noqa: BLE001
        logger.info("couldn't remove %s", ident, exc_info=True)


async def _on_joined(db: AsyncSession, room_id: uuid.UUID, uid: uuid.UUID, sid: str, cur: dict | None) -> None:
    if cur is not None and cur["room_id"] == str(room_id):
        m = (await raw_members(room_id)).get(str(uid))
        if m is not None:
            m["lk_sid"] = sid
            await _save_member(m)
            flags = {"server_muted": bool(m.get("server_muted")), "server_deafened": bool(m.get("server_deafened"))}
            if flags["server_muted"] or flags["server_deafened"]:
                # A reconnect with an older token mustn't lift a server-mute.
                room = await db.get(Room, room_id)
                sm = await rooms_core.space_member(db, room.space_id, uid) if room else None
                if room is not None:
                    await _apply_grants(room_id, uid, await voice_settings(db, room), sm, flags)
        return
    if cur is not None or await redis.exists(K_KICKED.format(uid, room_id)):
        # In another channel now, or removed from this one: the old token
        # doesn't get them back in.
        await _kick(room_id, uid)
        return
    # Not in our state (a reconnect after a missed leave, or state lost):
    # let them stay if they're still allowed in.
    room = await db.get(Room, room_id)
    user = await db.get(User, uid)
    sm = await rooms_core.space_member(db, room.space_id, uid) if room is not None and room.space_id else None
    cs = await access.load_settings(db)
    if room is None or room.kind != "voice" or user is None or sm is None or not await access.voice_allowed(db, user, cs):
        await _kick(room_id, uid)
        return
    rv = await voice_settings(db, room)
    if not access.can_join(rv, sm):
        await _kick(room_id, uid)
        return
    async with await _lock(uid):
        if await where(uid) is not None:
            return
        flags = await mod_flags(room.space_id, uid)
        m = {
            "user_id": str(uid), "room_id": str(room_id), "space_id": str(room.space_id),
            "muted": False, "deafened": False, **flags, "video": False, "live": False,
            "device": "web", "joined_at": _now().isoformat(), "session": uuid.uuid4().hex, "lk_sid": sid,
        }
        await _save_member(m)
        await redis.set(K_USER.format(uid), json.dumps({k: m[k] for k in ("room_id", "space_id", "device", "session", "joined_at")}))
        await redis.sadd(K_ROOMS, str(room_id))
        await _history_join(db, room_id, user)
        await db.commit()
    await _apply_grants(room_id, uid, rv, sm, flags)
    await _alone_recompute(db, room_id, rv)
    await publish_state(db, room_id, room.space_id)


# ================================================================ reaper


async def reap() -> dict:
    """Every few minutes (arq cron): match our state with LiveKit's (a
    missed webhook), drop people who lost access, close finished sessions.
    If LiveKit can't be reached, nothing is changed."""
    from app.database import SessionLocal

    stats = {"rooms": 0, "dropped": 0, "kicked": 0, "closed": 0}
    async with SessionLocal() as db:
        cs = await access.load_settings(db)
        enabled = cs.enabled and rtc_config.configured()
        ids = set(await redis.smembers(K_ROOMS))
        open_calls = (await db.execute(select(Call.room_id).where(Call.kind == "voice", Call.ended_at.is_(None)))).scalars().all()
        ids |= {str(r) for r in open_calls if r}
        for rid_s in ids:
            rid = uuid.UUID(rid_s)
            stats["rooms"] += 1
            state = await raw_members(rid)
            room = await db.get(Room, rid)
            if room is None or room.kind != "voice" or not enabled:
                for uid in state:
                    if await drop(db, uuid.UUID(uid), reason="voice_off" if room is not None else "deleted", only_room=rid):
                        stats["dropped"] += 1
                if not await redis.hlen(K_ROOM.format(rid)):
                    await redis.srem(K_ROOMS, rid_s)
                await _close_call(db, rid)
                await db.commit()
                continue
            try:
                lk = await service.list_participants(lk_room(rid))
            except Exception:  # noqa: BLE001 — LiveKit down: change nothing
                logger.info("voice reaper: LiveKit unavailable for %s", rid_s, exc_info=True)
                continue
            in_lk = {}
            for p in lk:
                u = names.identity_user(p.identity)
                if u is not None and p.identity == identity(u):
                    in_lk[str(u)] = p
            now = _now()
            for uid, m in state.items():
                user = await db.get(User, uuid.UUID(uid))
                sm = await rooms_core.space_member(db, room.space_id, uuid.UUID(uid))
                rv = await voice_settings(db, room)
                if user is None or user.disabled or sm is None or not await access.voice_allowed(db, user, cs) or not access.can_join(rv, sm):
                    if await drop(db, uuid.UUID(uid), reason="access", only_room=rid):
                        stats["dropped"] += 1
                    continue
                try:
                    age = (now - datetime.fromisoformat(m.get("joined_at"))).total_seconds()
                except (TypeError, ValueError):
                    age = LOST_AFTER + 1
                if uid not in in_lk and age > LOST_AFTER:
                    if await drop(db, uuid.UUID(uid), reason="lost", only_room=rid, only_session=m.get("session"), kick=False):
                        stats["dropped"] += 1
            state = await raw_members(rid)
            for uid in in_lk:
                if uid not in state:
                    await _kick(rid, uid)
                    stats["kicked"] += 1
            if not state:
                await redis.srem(K_ROOMS, rid_s)
                n = (await db.execute(update(Call).where(Call.room_id == rid, Call.ended_at.is_(None)).values(ended_at=now))).rowcount
                stats["closed"] += n or 0
                await db.commit()
    return stats
