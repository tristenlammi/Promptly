"""Rooms uploads: how big a file can be, whose storage it uses, and the
uploader's own list of them (Files → Rooms uploads).

**Where the bytes are.** Still ``rooms/<room_id>/<attachment id>`` under the
upload root, and still *not* a row in ``files``. That is on purpose: what's
said and sent in Rooms is never read by AI, and every AI path in the app
(the Drive index, embeddings, the chat's file tools, AI search) starts from
the ``files`` table. A Rooms upload isn't in it, so none of them can reach
one (``tests/test_rooms_uploads.py`` holds that). The uploader's "Rooms
uploads" folder in Files is a list drawn from ``room_attachments``.

**Storage.** A Rooms upload counts towards the storage of the person who
sent it (``app/files/quota.py``), and is refused when it would go over.

**Size.** Up to :data:`MAX_BYTES` (1 GB). Up to :data:`DIRECT_MAX_BYTES` it
arrives in one request, as before; bigger files come through tusd in pieces
that can resume (``app/files/tus_hooks.py``, the ``room_id`` branch), which
needs resumable uploads on (``TUS_ENABLED``). Without them the limit stays
at the one-request size.

**Removing one.** The uploader can remove a file from the list: the bytes
go, the storage comes back, and the message says "File removed"
(``removed_at``). Deleting the message still wipes its files, as before.
"""
from __future__ import annotations

import asyncio
import mimetypes
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings
from app.files.storage import absolute_path

from . import core, service
from .models import Room, RoomAttachment, RoomMember, RoomMessage, RoomSpace

MAX_BYTES = 1024**3
DIRECT_MAX_BYTES = 50 * 1024 * 1024

TOO_BIG = "Files in Rooms can be up to 1 GB. Put this one in your files, then use Send to… to share it here."
OVER_STORAGE = "This file would push you over your storage limit. Delete some files or ask an admin to raise it."
STORAGE_FULL = "You've reached your storage limit. Delete some files or ask an admin to raise it."
WAITING = "Send or remove the files you've already attached first"


def max_bytes() -> int:
    """The most one file can be on this server."""
    return MAX_BYTES if get_settings().TUS_ENABLED else DIRECT_MAX_BYTES


def policy() -> dict[str, Any]:
    cfg = get_settings()
    return {
        "max_bytes": max_bytes(),
        "direct_max_bytes": DIRECT_MAX_BYTES,
        "tus_endpoint": "/api/files/tus/" if cfg.TUS_ENABLED else None,
    }


def too_big_detail() -> str:
    if get_settings().TUS_ENABLED:
        return TOO_BIG
    return "Files in Rooms can be up to 50 MB on this server. Put this one in your files, then use Send to… to share it here."


# ------------------------------------------------------------------ checks


async def ensure_not_waiting(db: AsyncSession, user: User) -> None:
    waiting = await db.scalar(
        select(func.count()).select_from(RoomAttachment).where(RoomAttachment.uploader_id == user.id, RoomAttachment.message_id.is_(None))
    )
    if (waiting or 0) >= service.MAX_UNSENT:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=WAITING)


async def _reserved(user_id: uuid.UUID, excluding: str | None) -> int:
    """Big uploads of this person's still on their way (Drive's and Rooms')."""
    try:
        from app.files.tus_hooks import _reserved_for

        return await _reserved_for(user_id, excluding=excluding)
    except Exception:  # noqa: BLE001 - Redis away: the exact check at the end still holds
        return 0


async def ensure_storage(db: AsyncSession, user: User, size: int, *, upload_id: str | None = None, lock: bool = False) -> None:
    """413 when ``size`` more bytes won't fit in ``user``'s storage.
    ``size`` 0: only "already full". ``lock``: one upload at a time per
    person from here to the commit, so two finishing together can't both
    squeeze past the limit."""
    from app.files.quota import get_quota

    if lock:
        from app.files.router import lock_owner_quota

        await lock_owner_quota(db, user.id)
    quota = await get_quota(db, user)
    if quota.cap_bytes is None:
        return
    if size <= 0:
        if quota.used_bytes >= quota.cap_bytes:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=STORAGE_FULL)
        return
    if quota.used_bytes + await _reserved(user.id, upload_id) + size > quota.cap_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=OVER_STORAGE)


async def used_bytes(db: AsyncSession, user_id: uuid.UUID) -> int:
    """What this person's Rooms uploads take up (for their storage total)."""
    return int(
        await db.scalar(
            select(func.coalesce(func.sum(RoomAttachment.size), 0)).where(
                RoomAttachment.uploader_id == user_id, RoomAttachment.removed_at.is_(None)
            )
        )
        or 0
    )


# ------------------------------------------------------------------ big uploads (tus)


async def plan_big(db: AsyncSession, user: User, room_id: str, filename: str, size: int) -> uuid.UUID:
    """Before a byte of a big upload is taken: may they send it here, is it
    within the limit, does it fit? Returns the room's id."""
    try:
        rid = uuid.UUID(room_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad room.") from None
    if size > max_bytes():
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=too_big_detail())
    await core.load_room(db, rid, user)  # 404 if it isn't theirs to post in
    await ensure_not_waiting(db, user)
    await ensure_storage(db, user, size)
    return rid


async def adopt_big(db: AsyncSession, user: User, room_id: str, filename: str, mime: str | None, path: Path, *, upload_id: str) -> RoomAttachment:
    """A finished big upload becomes an attachment, ready to send. The file
    is moved into the room's folder (same disk: a rename)."""
    size = path.stat().st_size
    rid = await plan_big_at_finish(db, user, room_id, size, upload_id)
    room = await db.get(Room, rid)
    assert room is not None
    att = RoomAttachment(id=uuid.uuid4(), room_id=room.id, uploader_id=user.id, filename=service._clean_name(filename))
    att.mime = (mime or mimetypes.guess_type(att.filename)[0] or "application/octet-stream")[:127]
    att.size = size
    dst = absolute_path(service.att_path(att))
    dst.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(os.replace, path, dst)
    try:
        if att.mime.startswith("image/") and att.mime != "image/svg+xml":
            await asyncio.to_thread(service._thumbnail, att, dst)
        db.add(att)
        await db.commit()
    except BaseException:
        service.remove_attachment_files(att)
        raise
    return att


async def plan_big_at_finish(db: AsyncSession, user: User, room_id: str, size: int, upload_id: str) -> uuid.UUID:
    try:
        rid = uuid.UUID(room_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad room.") from None
    if size <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file is empty")
    if size > max_bytes():
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=too_big_detail())
    await core.load_room(db, rid, user)
    await ensure_not_waiting(db, user)
    await ensure_storage(db, user, size, upload_id=upload_id, lock=True)
    return rid


# ------------------------------------------------------------------ your Rooms uploads


def _mine(user_id: uuid.UUID):
    """Your uploads that still hold a file: sent (and the message not
    deleted) or waiting to be sent."""
    return and_(
        RoomAttachment.uploader_id == user_id,
        RoomAttachment.removed_at.is_(None),
        or_(RoomAttachment.message_id.is_(None), RoomMessage.deleted_at.is_(None)),
    )


async def _room_labels(db: AsyncSession, user: User, room_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """What to call each room in the list: "space · room", or who a
    conversation is with."""
    if not room_ids:
        return {}
    rooms = list((await db.execute(select(Room).where(Room.id.in_(room_ids)))).scalars())
    space_ids = {r.space_id for r in rooms if r.space_id}
    spaces = {s.id: s.name for s in (await db.execute(select(RoomSpace).where(RoomSpace.id.in_(space_ids)))).scalars()} if space_ids else {}
    dm_ids = [r.id for r in rooms if r.space_id is None]
    with_whom: dict[uuid.UUID, list[str]] = {}
    if dm_ids:
        rows = await db.execute(
            select(RoomMember.room_id, User.username)
            .join(User, User.id == RoomMember.user_id)
            .where(RoomMember.room_id.in_(dm_ids), RoomMember.user_id != user.id)
            .order_by(User.username)
        )
        for rid, name in rows.all():
            with_whom.setdefault(rid, []).append(name)
    out: dict[uuid.UUID, str] = {}
    for r in rooms:
        if r.space_id is not None:
            space = spaces.get(r.space_id) or ""
            out[r.id] = f"{space} · {r.name}" if space and r.name else (r.name or space or "A room")
        else:
            names = with_whom.get(r.id) or []
            out[r.id] = r.name or (", ".join(names[:4]) + ("…" if len(names) > 4 else "") if names else "A conversation")
    return out


async def list_mine(db: AsyncSession, user: User, *, before: datetime | None, limit: int) -> dict[str, Any]:
    base = select(RoomAttachment, RoomMessage).outerjoin(RoomMessage, RoomMessage.id == RoomAttachment.message_id).where(_mine(user.id))
    q = base
    if before is not None:
        q = q.where(RoomAttachment.created_at < before)
    rows = (await db.execute(q.order_by(RoomAttachment.created_at.desc(), RoomAttachment.id.desc()).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    labels = await _room_labels(db, user, {a.room_id for a, _m in rows})
    items = []
    for a, m in rows:
        voice = bool(m is not None and isinstance((m.meta or {}).get("voice"), dict) and str(m.meta["voice"].get("att")) == str(a.id))
        items.append(
            {
                **core.attachment_out(a),
                "room_id": str(a.room_id),
                "room": labels.get(a.room_id, "A room"),
                "message_id": str(a.message_id) if a.message_id else None,
                "sent": a.message_id is not None,
                "voice": voice,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
        )
    count, total = (
        await db.execute(
            select(func.count(RoomAttachment.id), func.coalesce(func.sum(RoomAttachment.size), 0))
            .select_from(RoomAttachment)
            .outerjoin(RoomMessage, RoomMessage.id == RoomAttachment.message_id)
            .where(_mine(user.id))
        )
    ).one()
    return {
        "items": items,
        "next_before": rows[-1][0].created_at.isoformat() if more and rows else None,
        "count": int(count or 0),
        "bytes": int(total or 0),
    }


async def mine(db: AsyncSession, user: User, att_id: uuid.UUID) -> RoomAttachment:
    att = await db.get(RoomAttachment, att_id)
    if att is None or att.uploader_id != user.id or att.removed_at is not None:
        raise core.not_found("File")
    return att


async def remove(db: AsyncSession, user: User, att_id: uuid.UUID) -> RoomMessage | None:
    """Take one of your own files out of Rooms. Its bytes go at once. A
    sent one leaves "File removed" on its message (returned, so the caller
    can tell open pages); one never sent just goes."""
    att = await mine(db, user, att_id)
    service.remove_attachment_files(att)
    if att.message_id is None:
        await db.delete(att)
        await db.commit()
        return None
    att.removed_at = datetime.now(timezone.utc)
    att.has_thumb = False
    msg = await db.get(RoomMessage, att.message_id)
    await db.commit()
    return msg if msg is not None and msg.deleted_at is None else None


def removed_out(a: RoomAttachment) -> dict:
    """A removed file as a message carries it: a name, nothing to open."""
    return {"id": str(a.id), "filename": a.filename, "mime": a.mime}
