"""A note's pictures and recordings, by signed link (``/m/<token>``).

A collaborator can't read the Drive file of whoever added a picture, and a
note isn't a Drive share — so a note's attachments are served by their own
signed claim, ``note`` (``files/media_urls.py``, code 19). The token names
the **attachment row** (so the note and the file), the person it was issued
to and which rendition:

* ``original`` — the bytes as uploaded (a recording; a GIF);
* ``thumb`` / ``preview`` — a picture's tile and larger view, once the media
  worker has made them (an edited library photo shows edited);
* ``play`` — a recording's seekable playback copy (``transcription.py``).

Serving checks, now: the person can open the note (``access.can_open`` —
removed members, strangers and Trash all get 404), the file is still
attached to that note, and it isn't in its owner's trash. Notes are *not*
added to ``files/access.py::readable_predicate``: other people's recordings
never appear in your Drive or your file tools.
"""
from __future__ import annotations

import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files import media_urls

# Which rendition, in the low bits of the token's ``ver``.
RENDITIONS = ("original", "thumb", "preview", "play")
_BITS = 0x3


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link expired or not found")


def _ver(rendition: str, *parts: object) -> int:
    return (media_urls.version_tag(*parts) & ~_BITS) | RENDITIONS.index(rendition)


def sign(attachment_id: uuid.UUID, user: User, rendition: str, *parts: object) -> str:
    return media_urls.sign(attachment_id, user.id, user.token_version, "note", _ver(rendition, rendition, *parts))


def urls_for(att: Any, file: Any, media: Any, user: User) -> dict[str, str | None]:
    """Links for one attachment as ``user`` sees it (``file``: its
    UserFile; ``media``: its FileMedia row, or None)."""
    from .transcription import PLAY_NAME

    out: dict[str, str | None] = {"original": None, "thumb": None, "preview": None, "play": None}
    if file is None or not file.storage_path:
        return out
    out["original"] = sign(att.id, user, "original", file.storage_path, file.size_bytes)
    if att.kind == "image" and media is not None and media.derivative_state == "ready":
        for r in ("thumb", "preview"):
            got = media_urls.shown(media.renditions, r)
            if got:
                _code, name, info = got
                out[r] = sign(att.id, user, r, name, info.get("bytes"))
    if att.kind == "audio":
        from app.files.derivatives import derived_dir

        for name in PLAY_NAME.values():
            p = derived_dir(file.id) / name
            if p.is_file():
                out["play"] = sign(att.id, user, "play", name, p.stat().st_size)
                break
    return out


async def serve(db: AsyncSession, claim: media_urls.MediaClaim, user: User, request: Request) -> Response:
    from app.files import storage
    from app.files.derivatives import derived_dir
    from app.files.models import UserFile
    from app.files.router import _content_disposition, _safe_download_mime

    from . import access
    from .models import Note, NoteAttachment
    from .transcription import PLAY_NAME

    att = await db.get(NoteAttachment, claim.file_id)
    if att is None or att.file_id is None:
        raise _not_found()
    note = await db.get(Note, att.note_id)
    if not await access.can_open(db, user, note):
        raise _not_found()
    file = await db.get(UserFile, att.file_id)
    if file is None or file.trashed_at is not None or not file.storage_path:
        raise _not_found()
    idx = claim.ver & _BITS
    rendition = RENDITIONS[idx] if idx < len(RENDITIONS) else "original"

    left = max(claim.exp - int(datetime.now(timezone.utc).timestamp()), 0)
    headers = {
        "Cache-Control": f"private, max-age={left}, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    accel_prefix = "/_renditions/"
    if rendition == "original":
        path = storage.absolute_path(file.storage_path)
        media_type = _safe_download_mime(file.mime_type, file.filename)
        headers["Content-Disposition"] = _content_disposition(file.filename)
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        accel_prefix = "/_blobs/"
        root = storage.UPLOAD_ROOT
    elif rendition == "play":
        path = None
        for name in PLAY_NAME.values():
            p = derived_dir(file.id) / name
            if p.is_file():
                path = p
                break
        if path is None:
            raise _not_found()
        media_type = "audio/webm" if path.suffix == ".webm" else "audio/mp4"
        root = storage.UPLOAD_ROOT / "derived"
    else:
        from app.files.models import FileMedia

        media = await db.get(FileMedia, file.id)
        got = media_urls.shown(media.renditions if media else None, rendition)
        if got is None:
            raise _not_found()
        path = derived_dir(file.id) / got[1]
        media_type = "image/webp"
        root = storage.UPLOAD_ROOT / "derived"
    if not path.is_file():
        raise _not_found()
    if request.headers.get("x-promptly-accel") == "1":
        rel = path.resolve().relative_to(root.resolve()).as_posix()
        headers["X-Accel-Redirect"] = urllib.parse.quote(accel_prefix + rel, safe="/")
        return Response(status_code=status.HTTP_200_OK, media_type=media_type, headers=headers)
    return FileResponse(path=str(path), media_type=media_type, headers=headers)


__all__ = ["RENDITIONS", "serve", "sign", "urls_for"]
