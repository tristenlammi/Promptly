"""Rooms media API (under ``/api/rooms``): saved GIFs, a space's emoji and
link-preview pictures. The logic is in ``media.py``."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.storage import absolute_path

from . import core, media
from . import settings as rooms_settings
from .models import RoomEmoji, RoomMessage, RoomSavedGif

router = APIRouter()

_MEDIA_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    "Cache-Control": "private, max-age=3600",
}
_IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif")


class GifIn(BaseModel):
    """A GIF from the library, as the picker hands it over. Checked again
    by ``media.clean_gif``: only the library's own https addresses pass."""

    provider: str = Field(max_length=16)
    id: str = Field(default="", max_length=64)
    url: str = Field(max_length=600)
    preview_url: str | None = Field(default=None, max_length=600)
    page_url: str | None = Field(default=None, max_length=600)
    width: int | None = None
    height: int | None = None
    title: str | None = Field(default=None, max_length=300)


async def gif_for_message(db: AsyncSession, gif: GifIn | None) -> dict | None:
    """``meta.gif`` for a message being sent, or None."""
    if gif is None:
        return None
    on = await rooms_settings.gif_search(db)
    return media.clean_gif(gif.model_dump(), on["provider"] if on else None)


# ================================================================== saved GIFs


@router.get("/saved-gifs")
async def saved_gifs(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    return await media.list_saved(db, user)


class SaveGifIn(BaseModel):
    attachment_id: uuid.UUID | None = None
    gif: GifIn | None = None


@router.post("/saved-gifs", status_code=201)
async def save_gif(body: SaveGifIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Save a GIF to send again: one someone sent (your own copy of the
    file), or one from the library (a reference to it)."""
    if body.attachment_id is not None:
        g = await media.save_attachment(db, user, body.attachment_id)
    elif body.gif is not None:
        g = await media.save_provider_gif(db, user, await gif_for_message(db, body.gif))
    else:
        raise media._bad("Nothing to save")
    await db.commit()
    return media.saved_out(g)


@router.delete("/saved-gifs/{saved_id}", status_code=204)
async def unsave_gif(saved_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    g = await media.my_saved(db, user, saved_id)
    await db.delete(g)
    await db.commit()
    media.remove_saved_file(g)


@router.get("/saved-gifs/{saved_id}/file")
async def saved_gif_file(saved_id: uuid.UUID, exp: int, sig: str, db: AsyncSession = Depends(get_db)) -> FileResponse:
    """Signed (for ``<img src>``): the link is only ever given to its owner."""
    if not core.verify("roomsaved", saved_id, exp, sig):
        raise core.not_found("GIF")
    g = await db.get(RoomSavedGif, saved_id)
    if g is None or g.source != "own":
        raise core.not_found("GIF")
    path = absolute_path(media.saved_path(g))
    if not path.exists():
        raise core.not_found("GIF")
    mime = g.mime if g.mime in _IMAGE_TYPES else "application/octet-stream"
    return FileResponse(path, media_type=mime, headers=_MEDIA_HEADERS)


@router.post("/rooms/{room_id}/attachments/saved/{saved_id}", status_code=201)
async def attach_saved_gif(room_id: uuid.UUID, saved_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """One of your saved GIFs as an attachment in this room, ready to send."""
    room, _sm = await core.load_room(db, room_id, user)
    g = await media.my_saved(db, user, saved_id)
    att = await media.attach_saved(db, room, user, g)
    await db.commit()
    return core.attachment_out(att)


# ================================================================== custom emoji


async def _space_changed(db: AsyncSession, space_id: uuid.UUID) -> None:
    await core.publish(await core.space_member_ids(db, space_id), {"type": "space", "space_id": str(space_id)})


@router.post("/spaces/{space_id}/emojis", status_code=201)
async def add_emoji(
    space_id: uuid.UUID,
    name: str = Form(..., max_length=40),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    space, me = await core.load_space(db, space_id, user)
    if not core.is_admin(me):
        raise core.forbidden("Only the space's admins can add emoji")
    e = await media.add_emoji(db, space.id, user, name, file)
    await db.commit()
    await _space_changed(db, space.id)
    return media.emoji_out(e)


async def _load_emoji(db: AsyncSession, emoji_id: uuid.UUID, user: User) -> RoomEmoji:
    e = await db.get(RoomEmoji, emoji_id)
    if e is None:
        raise core.not_found("Emoji")
    try:
        _space, me = await core.load_space(db, e.space_id, user)
    except Exception as err:  # not in the space: it doesn't exist for you
        raise core.not_found("Emoji") from err
    if not core.is_admin(me):
        raise core.forbidden("Only the space's admins can change its emoji")
    return e


class EmojiPatch(BaseModel):
    name: str = Field(min_length=1, max_length=40)


@router.patch("/emojis/{emoji_id}")
async def rename_emoji(emoji_id: uuid.UUID, body: EmojiPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    e = await _load_emoji(db, emoji_id, user)
    await media.rename_emoji(db, e, body.name)
    await db.commit()
    await _space_changed(db, e.space_id)
    return media.emoji_out(e)


@router.delete("/emojis/{emoji_id}", status_code=204)
async def delete_emoji(emoji_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    e = await _load_emoji(db, emoji_id, user)
    space_id = e.space_id
    await db.delete(e)
    await db.commit()
    media.remove_emoji_file(e)
    await _space_changed(db, space_id)


@router.get("/emojis/{emoji_id}/file")
async def emoji_file(emoji_id: uuid.UUID, exp: int, sig: str, db: AsyncSession = Depends(get_db)) -> FileResponse:
    if not core.verify("roomemoji", emoji_id, exp, sig):
        raise core.not_found("Emoji")
    e = await db.get(RoomEmoji, emoji_id)
    if e is None:
        raise core.not_found("Emoji")
    path = absolute_path(media.emoji_path(e))
    if not path.exists():
        raise core.not_found("Emoji")
    mime = e.mime if e.mime in _IMAGE_TYPES else "application/octet-stream"
    return FileResponse(path, media_type=mime, headers=_MEDIA_HEADERS)


# ================================================================== link previews


@router.delete("/messages/{message_id}/preview")
async def remove_preview(message_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Take the link preview off your own message. It stays off."""
    msg = await db.get(RoomMessage, message_id)
    if msg is None or msg.deleted_at is not None:
        raise core.not_found("Message")
    room, _sm = await core.load_room(db, msg.room_id, user)
    if msg.author_id != user.id or msg.kind != "user":
        raise core.forbidden("You can only change your own messages")
    await media.remove_preview(db, msg)
    await db.commit()
    out = await core.message_out(db, msg)
    await core.publish(await core.member_ids(db, room), {"type": "message_edit", "message": out})
    return out


@router.get("/previews/{message_id}/image")
async def preview_image(message_id: uuid.UUID, exp: int, sig: str, db: AsyncSession = Depends(get_db)) -> FileResponse:
    """A link preview's picture: this server's own small copy, so nobody's
    browser calls the linked site."""
    if not core.verify("roomprev", message_id, exp, sig):
        raise core.not_found("Picture")
    msg = await db.get(RoomMessage, message_id)
    if msg is None or msg.deleted_at is not None or not ((msg.meta or {}).get("preview") or {}).get("image"):
        raise core.not_found("Picture")
    path = absolute_path(media.preview_path(msg.room_id, msg.id))
    if not path.exists():
        raise core.not_found("Picture")
    return FileResponse(path, media_type="image/webp", headers=_MEDIA_HEADERS)
