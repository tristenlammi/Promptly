"""Rooms' shared pieces: who can see what, turning rows into JSON, and
the live feed (one Redis channel per person, read over SSE).

Access: a space room is visible to the space's members; a DM to the people
in its ``room_members``. Anything you can't see is a 404, never a 403 —
a room's existence isn't leaked."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings

from .models import Room, RoomAttachment, RoomMember, RoomMessage, RoomReaction, RoomSpace, RoomSpaceMember

logger = logging.getLogger("promptly.rooms")

MAX_BODY = 8000
ATTACHMENT_TTL = 12 * 3600
ROLES = ("owner", "admin", "member")
NOTIFY = ("all", "mentions", "none")


def not_found(what: str = "Room") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


# ------------------------------------------------------------------ access


async def space_member(db: AsyncSession, space_id: uuid.UUID, user_id: uuid.UUID) -> RoomSpaceMember | None:
    return await db.get(RoomSpaceMember, (space_id, user_id))


async def load_space(db: AsyncSession, space_id: uuid.UUID, user: User) -> tuple[RoomSpace, RoomSpaceMember]:
    space = await db.get(RoomSpace, space_id)
    me = await space_member(db, space_id, user.id) if space else None
    if space is None or me is None:
        raise not_found("Space")
    return space, me


def is_admin(m: RoomSpaceMember | None) -> bool:
    return m is not None and m.role in ("owner", "admin")


async def load_room(db: AsyncSession, room_id: uuid.UUID, user: User, *, lock: bool = False) -> tuple[Room, RoomSpaceMember | None]:
    """The room and, for a space room, your membership of its space."""
    q = select(Room).where(Room.id == room_id)
    if lock:
        q = q.with_for_update()
    room = (await db.execute(q)).scalar_one_or_none()
    if room is None:
        raise not_found()
    if room.space_id is not None:
        sm = await space_member(db, room.space_id, user.id)
        if sm is None:
            raise not_found()
        return room, sm
    if await db.get(RoomMember, (room.id, user.id)) is None:
        raise not_found()
    return room, None


async def member_ids(db: AsyncSession, room: Room) -> list[uuid.UUID]:
    """Everyone who can see ``room``."""
    if room.space_id is not None:
        q = select(RoomSpaceMember.user_id).where(RoomSpaceMember.space_id == room.space_id)
    else:
        q = select(RoomMember.user_id).where(RoomMember.room_id == room.id)
    return list((await db.execute(q)).scalars().all())


async def space_member_ids(db: AsyncSession, space_id: uuid.UUID) -> list[uuid.UUID]:
    return list((await db.execute(select(RoomSpaceMember.user_id).where(RoomSpaceMember.space_id == space_id))).scalars().all())


async def my_state(db: AsyncSession, room_id: uuid.UUID, user_id: uuid.UUID) -> RoomMember:
    """Your read state / settings row in a room (made on first need)."""
    row = await db.get(RoomMember, (room_id, user_id))
    if row is None:
        row = RoomMember(room_id=room_id, user_id=user_id, last_read_seq=0)
        db.add(row)
        await db.flush()
    return row


async def visible_room_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    spaces = select(RoomSpaceMember.space_id).where(RoomSpaceMember.user_id == user_id)
    a = select(Room.id).where(Room.space_id.in_(spaces))
    b = select(Room.id).join(RoomMember, RoomMember.room_id == Room.id).where(Room.space_id.is_(None), RoomMember.user_id == user_id)
    return list((await db.execute(a.union(b))).scalars().all())


# ------------------------------------------------------------------ people


def user_out(u: User) -> dict:
    from app.auth.avatars import effective_color

    return {"id": str(u.id), "username": u.username, "avatar_url": u.avatar_url, "color": effective_color(u)}


async def users_map(db: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[str, dict]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()
    return {str(u.id): user_out(u) for u in rows}


_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_.\-]{0,63})")


async def parse_mentions(db: AsyncSession, body: str, members: list[uuid.UUID]) -> list[str]:
    """``@username`` of people who can see the room → their ids; plus
    ``everyone`` and ``promptly``."""
    names = {m.group(1).rstrip(".-").lower() for m in _MENTION.finditer(body or "")}
    if not names:
        return []
    out: list[str] = []
    if "everyone" in names or "here" in names:
        out.append("everyone")
    if "promptly" in names:
        out.append("promptly")
    if members:
        rows = (await db.execute(select(User.id, User.username).where(User.id.in_(members)))).all()
        out += [str(uid) for uid, uname in rows if uname.lower() in names]
    return out


# ------------------------------------------------------------------ attachments


def _sig(att_id: uuid.UUID | str, exp: int) -> str:
    msg = f"roomatt:{att_id}:{exp}".encode()
    return hmac.new(get_settings().SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()


def verify_attachment_sig(att_id: uuid.UUID, exp: int, sig: str) -> bool:
    return exp >= int(time.time()) and hmac.compare_digest(_sig(att_id, exp), sig or "")


def signed_exp() -> int:
    """Rounded expiry: the same URL for a while, so the browser can cache it."""
    return (int(time.time()) // 3600 + 1) * 3600 + ATTACHMENT_TTL


def sign(kind: str, obj_id: uuid.UUID | str, exp: int) -> str:
    """The signature on a Rooms media link (saved GIFs, emoji, link-preview
    pictures): ``<img src>`` can't send a bearer, so the link is the pass."""
    msg = f"{kind}:{obj_id}:{exp}".encode()
    return hmac.new(get_settings().SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()


def verify(kind: str, obj_id: uuid.UUID | str, exp: int, sig: str) -> bool:
    return exp >= int(time.time()) and hmac.compare_digest(sign(kind, obj_id, exp), sig or "")


def signed_url(kind: str, obj_id: uuid.UUID | str, path: str) -> str:
    exp = signed_exp()
    return f"{path}?exp={exp}&sig={sign(kind, obj_id, exp)}"


def attachment_out(a: RoomAttachment) -> dict:
    exp = signed_exp()
    base = f"/api/rooms/attachments/{a.id}?exp={exp}&sig={_sig(a.id, exp)}"
    return {
        "id": str(a.id),
        "filename": a.filename,
        "mime": a.mime,
        "size": a.size,
        "width": a.width,
        "height": a.height,
        "url": base,
        "thumb_url": f"{base}&thumb=1" if a.has_thumb else None,
        # A GIF or animated WebP: the chat plays ``url`` in place.
        "animated": bool(a.animated),
    }


# ------------------------------------------------------------------ messages


def _meta_out(m: RoomMessage) -> dict:
    """A message's ``meta`` as sent to pages: a link preview's picture gets
    its signed address (the file is served by this server, never the site)."""
    meta = m.meta or {}
    p = meta.get("preview")
    if isinstance(p, dict) and p.get("image"):
        url = signed_url("roomprev", m.id, f"/api/rooms/previews/{m.id}/image")
        meta = {**meta, "preview": {**p, "image_url": f"{url}&v={p.get('v', 0)}"}}
    return meta


def _snippet(m: RoomMessage) -> str:
    return "" if m.deleted_at else (m.body or "")[:200]


async def messages_out(db: AsyncSession, msgs: list[RoomMessage], viewer_id: uuid.UUID | None = None) -> list[dict]:
    """Messages with their reactions, attachments and quoted replies, and a
    poll's live count (with ``viewer_id``'s own vote, when one is given: a
    message sent out to a whole room is given none)."""
    if not msgs:
        return []
    ids = [m.id for m in msgs]
    from . import polls

    poll_states = await polls.states(db, msgs, viewer_id)
    reacts: dict[uuid.UUID, dict[str, list[str]]] = {}
    for r in (await db.execute(select(RoomReaction).where(RoomReaction.message_id.in_(ids)).order_by(RoomReaction.created_at))).scalars():
        reacts.setdefault(r.message_id, {}).setdefault(r.emoji, []).append(str(r.user_id))
    atts: dict[uuid.UUID, list[dict]] = {}
    # Files their sender has since removed (Files → Rooms uploads): a name
    # to show as "File removed", nothing to open.
    gone: dict[uuid.UUID, list[dict]] = {}
    for a in (await db.execute(select(RoomAttachment).where(RoomAttachment.message_id.in_(ids)).order_by(RoomAttachment.created_at))).scalars():
        if a.removed_at is not None:
            gone.setdefault(a.message_id, []).append({"id": str(a.id), "filename": a.filename, "mime": a.mime})  # type: ignore[arg-type]
            continue
        atts.setdefault(a.message_id, []).append(attachment_out(a))  # type: ignore[arg-type]
    reply_ids = {m.reply_to_id for m in msgs if m.reply_to_id}
    replies = {}
    if reply_ids:
        replies = {r.id: r for r in (await db.execute(select(RoomMessage).where(RoomMessage.id.in_(reply_ids)))).scalars()}
    out = []
    for m in msgs:
        rt = replies.get(m.reply_to_id) if m.reply_to_id else None
        deleted = m.deleted_at is not None
        out.append(
            {
                "id": str(m.id),
                "room_id": str(m.room_id),
                "seq": m.seq,
                "author_id": str(m.author_id) if m.author_id else None,
                "kind": m.kind,
                "body": "" if deleted else m.body,
                "reply_to": (
                    {"id": str(rt.id), "seq": rt.seq, "author_id": str(rt.author_id) if rt.author_id else None, "kind": rt.kind, "body": _snippet(rt), "deleted": rt.deleted_at is not None}
                    if rt
                    else None
                ),
                "mentions": m.mentions or [],
                "reactions": [] if deleted else [{"emoji": e, "user_ids": u} for e, u in reacts.get(m.id, {}).items()],
                "attachments": [] if deleted else atts.get(m.id, []),
                "removed_attachments": [] if deleted else gone.get(m.id, []),
                "pinned": m.pinned_at is not None and not deleted,
                "edited_at": m.edited_at.isoformat() if m.edited_at else None,
                "deleted": deleted,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "meta": {} if deleted else _meta_out(m),
            }
        )
        if m.id in poll_states:
            out[-1]["poll"] = poll_states[m.id]
    return out


async def message_out(db: AsyncSession, m: RoomMessage, viewer_id: uuid.UUID | None = None) -> dict:
    return (await messages_out(db, [m], viewer_id))[0]


async def reactions_of(db: AsyncSession, message_id: uuid.UUID) -> list[dict]:
    out: dict[str, list[str]] = {}
    for r in (await db.execute(select(RoomReaction).where(RoomReaction.message_id == message_id).order_by(RoomReaction.created_at))).scalars():
        out.setdefault(r.emoji, []).append(str(r.user_id))
    return [{"emoji": e, "user_ids": u} for e, u in out.items()]


# ------------------------------------------------------------------ rooms


async def rooms_out(db: AsyncSession, rooms: list[Room], user: User) -> list[dict]:
    """Rooms as one person sees them: unread, mentions, their settings, and
    (DMs) the members, AI consent and a preview of the last message."""
    if not rooms:
        return []
    ids = [r.id for r in rooms]
    mine = {m.room_id: m for m in (await db.execute(select(RoomMember).where(RoomMember.room_id.in_(ids), RoomMember.user_id == user.id))).scalars()}
    # Mentions of you after your read point (not your own messages).
    mention_q = (
        select(RoomMessage.room_id, func.count())
        .outerjoin(RoomMember, (RoomMember.room_id == RoomMessage.room_id) & (RoomMember.user_id == user.id))
        .where(
            RoomMessage.room_id.in_(ids),
            RoomMessage.seq > func.coalesce(RoomMember.last_read_seq, 0),
            RoomMessage.deleted_at.is_(None),
            (RoomMessage.author_id.is_(None)) | (RoomMessage.author_id != user.id),
            RoomMessage.mentions.op("?|")(_mention_keys(user.id)),
        )
        .group_by(RoomMessage.room_id)
    )
    mentions = dict((await db.execute(mention_q)).all())
    dm_ids = [r.id for r in rooms if r.space_id is None]
    dm_members: dict[uuid.UUID, list[RoomMember]] = {}
    previews: dict[uuid.UUID, RoomMessage] = {}
    if dm_ids:
        for m in (await db.execute(select(RoomMember).where(RoomMember.room_id.in_(dm_ids)).order_by(RoomMember.joined_at))).scalars():
            dm_members.setdefault(m.room_id, []).append(m)
        last = (
            select(RoomMessage)
            .join(Room, (Room.id == RoomMessage.room_id) & (Room.last_seq == RoomMessage.seq))
            .where(RoomMessage.room_id.in_(dm_ids))
        )
        previews = {m.room_id: m for m in (await db.execute(last)).scalars()}
    # 1:1 conversations closed by a block (D7): who I blocked, and who
    # blocked me (that one only ever shows as "can't send").
    i_blocked: set[uuid.UUID] = set()
    blocked_me: set[uuid.UUID] = set()
    if any(r.kind == "dm" for r in rooms if r.space_id is None):
        from app.people.blocks import UserBlock

        for b in (await db.execute(select(UserBlock).where((UserBlock.blocker_id == user.id) | (UserBlock.blocked_id == user.id)))).scalars():
            if b.blocker_id == user.id:
                i_blocked.add(b.blocked_id)
            else:
                blocked_me.add(b.blocker_id)
    # Voice channels (Calls): their settings ride along with the room.
    voice_ids = [r.id for r in rooms if r.kind == "voice"]
    voice_settings: dict = {}
    if voice_ids:
        from app.calls.voice import settings_map

        voice_settings = await settings_map(db, voice_ids)
    from . import receipts

    show_receipts = bool(dm_ids) and (await receipts.server(db))[0]
    out = []
    for r in rooms:
        st = mine.get(r.id)
        read = st.last_read_seq if st else 0
        d: dict[str, Any] = {
            "id": str(r.id),
            "space_id": str(r.space_id) if r.space_id else None,
            "kind": r.kind,
            "name": r.name,
            "topic": r.topic,
            "position": r.position,
            "last_seq": r.last_seq,
            "last_message_at": r.last_message_at.isoformat() if r.last_message_at else None,
            "last_read_seq": read,
            "unread": max(0, r.last_seq - read),
            "mentions": int(mentions.get(r.id, 0)),
            "notify": st.notify if st else None,
            # Quiet until then (None: not muted for a while).
            "muted_until": receipts.iso(st.muted_until) if st else None,
        }
        if r.kind == "voice":
            d["voice"] = voice_settings.get(r.id)
        if r.space_id is None:
            members = dm_members.get(r.id, [])
            d["members"] = [str(m.user_id) for m in members]
            d["hidden"] = st.hidden if st else False
            if show_receipts:
                # How far the others have got: Delivered / Seen under your messages.
                d["receipts"] = receipts.receipts_out(members, user.id)
            if r.kind == "dm":
                others = {m.user_id for m in members} - {user.id}
                d["blocked"] = bool(others & i_blocked)
                d["can_send"] = not (others & (i_blocked | blocked_me))
            p = previews.get(r.id)
            if p is not None:
                d["preview"] = {
                    "author_id": str(p.author_id) if p.author_id else None,
                    "kind": p.kind,
                    "body": "" if p.deleted_at else (p.body or "")[:140],
                    "deleted": p.deleted_at is not None,
                }
        out.append(d)
    return out


def _mention_keys(user_id: uuid.UUID):  # noqa: ANN202
    """``ARRAY['<you>', 'everyone']`` for the jsonb ``?|`` operator."""
    from sqlalchemy import String, literal
    from sqlalchemy.dialects.postgresql import ARRAY

    return literal([str(user_id), "everyone"], ARRAY(String))


async def room_out(db: AsyncSession, room: Room, user: User) -> dict:
    return (await rooms_out(db, [room], user))[0]




# ------------------------------------------------------------------ live


def channel(user_id: uuid.UUID | str) -> str:
    return f"rooms:u:{user_id}"


async def publish(user_ids: Iterable[uuid.UUID | str], event: dict) -> None:
    """Best-effort: a dead Redis never fails a write."""
    from app.redis_client import redis

    data = json.dumps(event, default=str)
    for uid in set(str(u) for u in user_ids):
        try:
            await redis.publish(channel(uid), data)
        except Exception:  # noqa: BLE001
            logger.debug("rooms publish failed", exc_info=True)


# "Looking at a room" is per device (a browser tab, the phone app) and short:
# the page says so every 10 seconds while it's on screen, focused and being
# used, and each word lasts PRESENCE_S. So a phone that locks without getting
# to say "gone", or a tab left open on a desk, stops holding back that
# person's notifications within seconds, not a minute (or for ever).
PRESENCE_S = 25
# A page from before devices were named says it every 30 seconds.
PRESENCE_OLD_S = 60


def _presence_key(user_id: uuid.UUID | str) -> str:
    return f"rooms:looking:{user_id}"


async def set_presence(user_id: uuid.UUID, room_id: uuid.UUID | None, device: str | None = None) -> None:
    """This device is looking at ``room_id`` (None: at no room)."""
    from app.redis_client import redis

    field = re.sub(r"[^A-Za-z0-9_-]", "", device or "")[:40] or "-"
    try:
        key = _presence_key(user_id)
        if room_id is None:
            await redis.hdel(key, field)
        else:
            lasts = PRESENCE_S if field != "-" else PRESENCE_OLD_S
            await redis.hset(key, field, f"{room_id}|{int(time.time()) + lasts}")
            await redis.expire(key, PRESENCE_OLD_S)
    except Exception:  # noqa: BLE001
        logger.debug("rooms presence failed", exc_info=True)


async def viewing(user_ids: list[uuid.UUID]) -> dict[str, set[str]]:
    """The rooms each person is looking at right now, on any of their devices."""
    from app.redis_client import redis

    if not user_ids:
        return {}
    try:
        pipe = redis.pipeline()
        for u in user_ids:
            pipe.hgetall(_presence_key(u))
        found = await pipe.execute()
    except Exception:  # noqa: BLE001
        return {}
    now = time.time()
    out: dict[str, set[str]] = {}
    for u, devices in zip(user_ids, found):
        rooms = set()
        for value in (devices or {}).values():
            room, _, until = str(value).partition("|")
            if room and until.isdigit() and int(until) > now:
                rooms.add(room)
        if rooms:
            out[str(u)] = rooms
    return out


async def unread_total(db: AsyncSession, user_id: uuid.UUID) -> int:
    """The Rooms number: the app icon's badge (push ``app_badge``), the
    sidebar's Rooms badge and the Rooms tab title all show this one count.

    It is exactly ``totals(b).total`` in ``frontend/src/rooms/cache.ts``:
    a space room you hear everything from counts its unread messages, one
    set to mentions counts only its unread mentions of you, muted ones
    count nothing; a DM (not hidden, not muted) counts its unread messages.
    Keep the two in step."""
    from . import receipts

    levels = {
        sm.space_id: sm
        for sm in (await db.execute(select(RoomSpaceMember).where(RoomSpaceMember.user_id == user_id))).scalars()
    }
    states = {m.room_id: m for m in (await db.execute(select(RoomMember).where(RoomMember.user_id == user_id))).scalars()}
    q = select(Room.id, Room.space_id, Room.last_seq).where(
        Room.space_id.in_(list(levels)) | (Room.space_id.is_(None) & Room.id.in_([rid for rid, m in states.items() if not m.hidden]))
    )
    total = 0
    mentions_only: list[uuid.UUID] = []
    for rid, sid, last in (await db.execute(q)).all():
        st = states.get(rid)
        level = receipts.level(st, levels.get(sid) if sid else None)
        if level == "none":
            continue
        unread = max(0, last - (st.last_read_seq if st else 0))
        if sid is not None and level == "mentions":
            if unread:
                mentions_only.append(rid)
            continue
        total += unread
    if mentions_only:
        # Unread mentions of you (not your own messages), as rooms_out counts them.
        mq = (
            select(func.count())
            .select_from(RoomMessage)
            .outerjoin(RoomMember, (RoomMember.room_id == RoomMessage.room_id) & (RoomMember.user_id == user_id))
            .where(
                RoomMessage.room_id.in_(mentions_only),
                RoomMessage.seq > func.coalesce(RoomMember.last_read_seq, 0),
                RoomMessage.deleted_at.is_(None),
                (RoomMessage.author_id.is_(None)) | (RoomMessage.author_id != user_id),
                RoomMessage.mentions.op("?|")(_mention_keys(user_id)),
            )
        )
        total += int(await db.scalar(mq) or 0)
    return total
