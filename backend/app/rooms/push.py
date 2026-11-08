"""Pushes for new room messages. Push only — no inbox row (the app is its
own inbox). Per person: nothing for your own message or for the room
you're looking at; then the room's notification level (your room
override › your space setting › "all"; DMs "all"), where "mentions" means
an @you, an @everyone, or a reply to you."""
from __future__ import annotations

import logging
import re
import uuid

from sqlalchemy import select

from app.database import SessionLocal

from . import core
from .models import Room, RoomAttachment, RoomMember, RoomMessage, RoomSpace, RoomSpaceMember

logger = logging.getLogger("promptly.rooms.push")


def _plain(body: str) -> str:
    s = re.sub(r"```.*?```", "[code]", body or "", flags=re.S)
    s = re.sub(r"[*_`>#~]+", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:160] + ("…" if len(s) > 160 else "")


def wants(level: str, uid: str, msg: RoomMessage, reply_author: str | None) -> bool:
    if level == "none":
        return False
    if level == "mentions":
        ms = msg.mentions or []
        return uid in ms or "everyone" in ms or reply_author == uid
    return True


async def fan_out(message_id: uuid.UUID) -> int:
    """Send the pushes for one new message; returns how many people got one."""
    from app.auth.models import User
    from app.notifications.dispatch import notify_user

    async with SessionLocal() as db:
        msg = await db.get(RoomMessage, message_id)
        if msg is None or msg.deleted_at is not None:
            return 0
        room = await db.get(Room, msg.room_id)
        if room is None:
            return 0
        members = await core.member_ids(db, room)
        recipients = [u for u in members if u != msg.author_id]
        if not recipients:
            return 0
        looking = await core.viewing(recipients)
        overrides = {
            m.user_id: m
            for m in (await db.execute(select(RoomMember).where(RoomMember.room_id == room.id, RoomMember.user_id.in_(recipients)))).scalars()
        }
        space_levels: dict[uuid.UUID, str] = {}
        space = None
        if room.space_id is not None:
            space = await db.get(RoomSpace, room.space_id)
            space_levels = {
                m.user_id: m.notify
                for m in (await db.execute(select(RoomSpaceMember).where(RoomSpaceMember.space_id == room.space_id))).scalars()
            }
        reply_author = None
        if msg.reply_to_id:
            parent = await db.get(RoomMessage, msg.reply_to_id)
            reply_author = str(parent.author_id) if parent and parent.author_id else None
        author = await db.get(User, msg.author_id) if msg.author_id else None
        who = "Promptly" if msg.kind == "promptly" else (author.username if author else "Someone")
        text = _plain(msg.body)
        if not text:
            atts = (await db.execute(select(RoomAttachment.mime).where(RoomAttachment.message_id == msg.id))).scalars().all()
            if atts:
                photos = sum(1 for m in atts if m.startswith("image/"))
                text = (
                    f"sent {'a photo' if photos == 1 else f'{photos} photos'}"
                    if photos == len(atts)
                    else f"sent {'a file' if len(atts) == 1 else f'{len(atts)} files'}"
                )
        if space is not None:
            title = f"{space.name} · {'🔊 ' if room.kind == 'voice' else '#'}{room.name}"
            body = f"{who}: {text}"
        elif room.kind == "dm":
            title, body = who, text
        else:
            names = (await db.execute(select(User.username).where(User.id.in_(members)))).scalars().all()
            title = room.name or ", ".join(sorted(names))[:80]
            body = f"{who}: {text}"
        # The service worker stacks a room's messages in one notification
        # (``line`` each), shows the sender's picture, and sets the app
        # icon's badge to ``app_badge``.
        icon = (author.avatar_url if author is not None else None) or "/item-icons/rooms-192.png"
        sent = 0
        for uid in recipients:
            if looking.get(str(uid)) == str(room.id):
                continue
            o = overrides.get(uid)
            level = (o.notify if o and o.notify else None) or space_levels.get(uid) or "all"
            if not wants(level, str(uid), msg, reply_author):
                continue
            await notify_user(
                user_id=uid,
                category="room_message",
                title=title[:120],
                body=body[:300],
                url=f"/rooms/r/{room.id}",
                tag=f"room:{room.id}",
                actor_user_id=msg.author_id,
                inbox=False,
                extra={
                    "icon": icon,
                    "line": body[:200],
                    "stack": True,
                    "app_badge": await core.unread_total(db, uid),
                },
            )
            sent += 1
        return sent
