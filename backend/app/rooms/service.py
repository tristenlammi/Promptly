"""Posting messages and storing attachments."""
from __future__ import annotations

import io
import logging
import mimetypes
import re
import shutil
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.storage import absolute_path

from . import core
from .models import Room, RoomAttachment, RoomMember, RoomMessage

logger = logging.getLogger("promptly.rooms.service")

MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_ATTACHMENTS = 10
THUMB_EDGE = 720


def next_seq(room: Room) -> int:
    """The room's next message number (the room row must be locked)."""
    room.last_seq = (room.last_seq or 0) + 1
    room.last_message_at = datetime.now(timezone.utc)
    return room.last_seq


async def post_message(
    db: AsyncSession,
    room: Room,
    user: User,
    body: str,
    *,
    reply_to_id: uuid.UUID | None = None,
    attachment_ids: list[uuid.UUID] | None = None,
    client_id: str | None = None,
) -> RoomMessage:
    """Add a message to ``room`` (locked by the caller), attach uploads, and
    move your read point to it. The caller commits and publishes."""
    body = (body or "").strip()
    attachment_ids = list(dict.fromkeys(attachment_ids or []))[:MAX_ATTACHMENTS]
    if not body and not attachment_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty message")
    if len(body) > core.MAX_BODY:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Messages are at most {core.MAX_BODY} characters")
    if reply_to_id is not None:
        parent = await db.get(RoomMessage, reply_to_id)
        if parent is None or parent.room_id != room.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Can't reply to that message")
    atts: list[RoomAttachment] = []
    if attachment_ids:
        atts = list(
            (
                await db.execute(
                    select(RoomAttachment).where(
                        RoomAttachment.id.in_(attachment_ids),
                        RoomAttachment.room_id == room.id,
                        RoomAttachment.uploader_id == user.id,
                        RoomAttachment.message_id.is_(None),
                    )
                )
            ).scalars()
        )
        if len(atts) != len(attachment_ids):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="An attachment is missing or already sent")
    members = await core.member_ids(db, room)
    seq = next_seq(room)
    msg = RoomMessage(
        room_id=room.id,
        seq=seq,
        author_id=user.id,
        kind="user",
        body=body,
        reply_to_id=reply_to_id,
        mentions=await core.parse_mentions(db, body, members),
        meta={"client_id": client_id[:64]} if client_id else {},
    )
    db.add(msg)
    await db.flush()
    for a in atts:
        a.message_id = msg.id
    me = await core.my_state(db, room.id, user.id)
    me.last_read_seq = seq
    if room.space_id is None:
        # A new message re-opens a closed conversation for everyone.
        await db.execute(update(RoomMember).where(RoomMember.room_id == room.id, RoomMember.hidden.is_(True)).values(hidden=False))
    return msg


# ------------------------------------------------------------------ attachments


def room_dir(room_id: uuid.UUID) -> str:
    return f"rooms/{room_id}"


def att_path(a: RoomAttachment, thumb: bool = False) -> str:
    return f"{room_dir(a.room_id)}/{a.id}{'.thumb.webp' if thumb else ''}"


def _clean_name(name: str | None) -> str:
    s = re.sub(r"[\x00-\x1f/\\]+", "_", (name or "").strip()) or "file"
    return s[-200:]


async def store_attachment(db: AsyncSession, room: Room, user: User, upload: UploadFile) -> RoomAttachment:
    att = RoomAttachment(id=uuid.uuid4(), room_id=room.id, uploader_id=user.id, filename=_clean_name(upload.filename))
    att.mime = (upload.content_type or mimetypes.guess_type(att.filename)[0] or "application/octet-stream")[:127]
    path = absolute_path(att_path(att))
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Files can be up to 50 MB")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file is empty")
    att.size = size
    if att.mime.startswith("image/") and att.mime != "image/svg+xml":
        _thumbnail(att, path)
    db.add(att)
    await db.flush()
    return att


def _thumbnail(att: RoomAttachment, path) -> None:  # noqa: ANN001
    """Size + a WEBP thumbnail for images Pillow can read (HEIC too, when
    pillow-heif is there). Anything unreadable stays a plain file."""
    try:
        from PIL import Image, ImageOps

        try:
            import pillow_heif  # type: ignore[import-not-found]

            pillow_heif.register_heif_opener()
        except Exception:  # noqa: BLE001
            pass
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            att.width, att.height = img.size
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")
            img.thumbnail((THUMB_EDGE, THUMB_EDGE))
            buf = io.BytesIO()
            img.save(buf, format="WEBP", quality=80, method=4)
        absolute_path(att_path(att, thumb=True)).write_bytes(buf.getvalue())
        att.has_thumb = True
    except Exception:  # noqa: BLE001
        logger.debug("no thumbnail for %s", att.id, exc_info=True)


def remove_attachment_files(a: RoomAttachment) -> None:
    for thumb in (False, True):
        try:
            absolute_path(att_path(a, thumb)).unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


def remove_room_files(room_id: uuid.UUID) -> None:
    try:
        shutil.rmtree(absolute_path(room_dir(room_id)), ignore_errors=True)
    except ValueError:
        pass
