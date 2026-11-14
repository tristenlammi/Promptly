"""Posting messages and storing attachments."""
from __future__ import annotations

import io
import logging
import mimetypes
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.storage import absolute_path

from . import core
from .models import Room, RoomAttachment, RoomMember, RoomMessage, RoomReaction

logger = logging.getLogger("promptly.rooms.service")

MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_ATTACHMENTS = 10
THUMB_EDGE = 720


async def dm_refusal(db: AsyncSession, room: Room, user_id: uuid.UUID) -> str | None:
    """In a 1:1 conversation, why ``user_id`` can't post (a block either
    way, decision D7), or None. Spaces and group conversations: always
    None. The wording for the blocked person never mentions a block."""
    if room.space_id is not None or room.kind != "dm":
        return None
    from app.people.blocks import dm_refusal as refusal

    others = [u for u in await core.member_ids(db, room) if u != user_id]
    for other in others:
        why = await refusal(db, user_id, other)
        if why:
            return why
    return None


async def open_dm(db: AsyncSession, user: User, other_ids: list[uuid.UUID]) -> Room:
    """Make or reuse a conversation with ``other_ids`` (one person: the same
    1:1 every time). The others see it once there's a message in it. A block
    either way refuses a *new* 1:1 conversation (decision D7); an existing
    one opens, read-only (:func:`dm_refusal` stops new messages). Commits.

    Used by ``POST /api/rooms/dms`` and by other apps' "Message" buttons
    (Porch's "Reply privately")."""
    others = set(other_ids) - {user.id}
    if not others:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Pick someone to message")
    found = set((await db.execute(select(User.id).where(User.id.in_(others), User.disabled.is_(False)))).scalars().all())
    if found != others:
        raise core.not_found("Person")
    if len(others) == 1:
        other = next(iter(others))
        mine = select(RoomMember.room_id).where(RoomMember.user_id == user.id)
        theirs = select(RoomMember.room_id).where(RoomMember.user_id == other)
        existing = (
            await db.execute(select(Room).where(Room.space_id.is_(None), Room.kind == "dm", Room.id.in_(mine), Room.id.in_(theirs)))
        ).scalars().first()
        if existing is not None:
            st = await core.my_state(db, existing.id, user.id)
            st.hidden = False
            await db.commit()
            return existing
        # The blocked person's wording never mentions the block.
        from app.people.blocks import dm_refusal as refusal

        why = await refusal(db, user.id, other)
        if why:
            raise core.forbidden(why)
    room = Room(space_id=None, kind="dm" if len(others) == 1 else "group", created_by=user.id)
    db.add(room)
    await db.flush()
    for uid in others | {user.id}:
        db.add(RoomMember(room_id=room.id, user_id=uid, hidden=uid != user.id))
    await db.commit()
    return room


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
    place: dict | None = None,
) -> RoomMessage:
    """Add a message to ``room`` (locked by the caller), attach uploads, and
    move your read point to it. The caller commits and publishes."""
    body = (body or "").strip()
    meta: dict = {"client_id": client_id[:64]} if client_id else {}
    if place:
        # A place from P Maps (``meta.place``), drawn as a card. With no words
        # of your own, its name stands in for them in lists and notifications.
        name = " ".join(str(place.get("name") or "").split())[:120] or "A place"
        address = " ".join(str(place.get("address") or "").split())[:240]
        meta["place"] = {
            "name": name,
            "address": address or None,
            "lat": round(float(place["lat"]), 6),
            "lon": round(float(place["lon"]), 6),
            "has_note": bool(body),
        }
        body = body or f"\U0001F4CD {name}"
    attachment_ids = list(dict.fromkeys(attachment_ids or []))[:MAX_ATTACHMENTS]
    if not body and not attachment_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty message")
    why = await dm_refusal(db, room, user.id)
    if why:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=why)
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
        meta=meta,
    )
    db.add(msg)
    await db.flush()
    if body:
        from app.links.service import sync_text

        await sync_text(db, "room_msg", msg.id, body, user_id=user.id)
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


# A deleted message can be brought back (Undo) for this long…
RESTORE_WINDOW = timedelta(seconds=60)
# …and what it held is wiped for good once this has passed.
PURGE_AFTER = timedelta(minutes=2)


async def purge_deleted(db: AsyncSession, *, older_than: timedelta = PURGE_AFTER) -> int:
    """Wipe what deleted messages still hold — their words, files, reactions,
    pin and links — once Undo has run out. The empty row stays, so replies
    to it and the room's numbering still make sense."""
    from app.links.service import purge_sources

    cutoff = datetime.now(timezone.utc) - older_than
    rows = (
        (
            await db.execute(
                select(RoomMessage)
                .where(
                    RoomMessage.deleted_at.is_not(None),
                    RoomMessage.deleted_at < cutoff,
                    or_(
                        RoomMessage.body != "",
                        RoomMessage.pinned_at.is_not(None),
                        exists().where(RoomAttachment.message_id == RoomMessage.id),
                        exists().where(RoomReaction.message_id == RoomMessage.id),
                    ),
                )
                .limit(500)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return 0
    ids = [m.id for m in rows]
    for m in rows:
        m.body = ""
        m.pinned_at = None
        m.mentions = []
    atts = (await db.execute(select(RoomAttachment).where(RoomAttachment.message_id.in_(ids)))).scalars().all()
    for a in atts:
        remove_attachment_files(a)
        await db.delete(a)
    await db.execute(delete(RoomReaction).where(RoomReaction.message_id.in_(ids)))
    await purge_sources(db, "room_msg", ids)
    await db.commit()
    return len(rows)


def remove_room_files(room_id: uuid.UUID) -> None:
    try:
        shutil.rmtree(absolute_path(room_dir(room_id)), ignore_errors=True)
    except ValueError:
        pass


# ------------------------------------------------------------------ remind me


def remind_time(now_local: datetime, when: str) -> tuple[str | None, str | None]:
    """(due day, due time) in the person's own time for a "Remind me" choice.
    "evening" after 5 pm is tomorrow evening: a reminder is never in the past."""
    if when == "hour":
        at = (now_local + timedelta(hours=1)).replace(second=0, microsecond=0)
        return at.date().isoformat(), at.strftime("%H:%M")
    if when == "evening":
        day = now_local.date() if now_local.hour < 17 else now_local.date() + timedelta(days=1)
        return day.isoformat(), "18:00"
    if when == "tomorrow":
        return (now_local.date() + timedelta(days=1)).isoformat(), "09:00"
    return None, None


async def remind_me(db: AsyncSession, user: User, room: Room, msg: RoomMessage, author: str | None, when: str) -> dict:
    """Add a task to ``user``'s Tasks about this message, due at ``when``."""
    import copy

    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    words = re.sub(r"\s+", " ", re.sub(r"[*_`>#~]+", "", msg.body or "")).strip()
    who = author or "Promptly"
    title = (f"{who}: {words}" if words else f"Reply to {who}")[:200]
    link = f"/rooms/r/{room.id}?m={msg.seq}"
    due, at = remind_time(datetime.now(items.zone_for(user)), when)
    task: dict = {"title": title, "notes": f"From a message in Rooms.\n{link}"}
    if due:
        task.update({"due": due, "time": at, "alerts": [0]})
    try:
        row, _ = await items.open_app(db, user, "tasks")
        row, doc, _access = await items.load(db, user, row.id, lock=True)
        spec = get_spec("tasks")
        data = copy.deepcopy(doc.data)
        ctx = items.make_context(db, user, row.id, spec)
        await items.run_action(ctx, spec, data, "add_tasks", {"tasks": [task]})
        await items.save_data(db, user, row, doc, data, base_revision=None)
    except (ActionError, items.ItemError, items.ItemNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc) or "Couldn't add that to Tasks.") from exc
    file_id = row.id
    await db.commit()
    return {"title": title, "due": due, "time": at, "href": "/app/open/tasks", "file_id": str(file_id)}
