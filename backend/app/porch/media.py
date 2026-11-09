"""A post's photos and videos: checking what's posted, links to them, and
serving them (plan "Who can see what" → Photo bytes; build §1, §4).

* **What can be posted** (decision D1): only your own photos and videos,
  in your Photos library (inside the Photos folder, not in a folder hidden
  from Photos, not in the trash). New ones come in through Files' upload
  with ``route=camera``, so a photo already there is the same file, never
  a second copy. Videos within the admin's length and size limits.
* **Links**: every post comes back with signed ``/m/`` links for the viewer,
  with their own claim kinds (``porch_thumb``, ``porch_preview``,
  ``porch_poster``, ``porch_video``, ``porch_full``; ``porch_cover`` for a
  group's cover). The link's id is the ``porch_post_media`` row, so serving
  checks :func:`app.porch.access.can_see_post` now, and that the file is
  still in that post and not in the trash. The poster's file itself is
  never readable by anyone else.
* **This post's own crop / filter** (decision D3): ``porch_post_media.edit``
  holds ``photos/edits.py`` ops; the tile and preview are rendered with them
  on first ask to ``derived/<file_id>/porch-<media_id>.{thumb,preview}.webp``
  (cache, gone with the photo's other renditions). Without one, the post
  shows what the library shows (a Photos edit included). ``porch_full`` is
  the original, or the edited picture rendered on demand (decision D2).
"""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files import media_urls
from app.files.models import FileMedia, UserFile

from . import core
from .models import PorchGroup, PorchPostMedia

logger = logging.getLogger("promptly.porch.media")

MAX_MEDIA = 20
PLAYABLE = frozenset({"video/mp4", "video/webm"})

_locks: dict[uuid.UUID, asyncio.Lock] = {}


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link expired or not found")


def is_video(row: UserFile, fm: FileMedia | None) -> bool:
    if fm is not None and fm.kind in ("image", "raw", "video"):
        return fm.kind == "video"
    return (row.mime_type or "").lower().startswith("video/")


# ------------------------------------------------------------------ edits


def clean_edit(raw: Any, video: bool) -> dict[str, Any] | None:
    """A post's crop / filter ops, normalised; None when there's nothing
    to do (and always for a video). Markup stays a Photos feature."""
    if video or not raw or not isinstance(raw, dict):
        return None
    from app.photos import edits

    try:
        ops = edits.normalise({k: v for k, v in raw.items() if k != "markup"})
    except (TypeError, ValueError, KeyError):
        raise core.bad("That photo edit isn't valid") from None
    ops["markup"] = []
    return None if edits.is_identity(ops) else ops


def edit_tag(edit: dict[str, Any] | None) -> int:
    return media_urls.version_tag(json.dumps(edit or {}, sort_keys=True))


def porch_files(media_id: uuid.UUID) -> tuple[str, str]:
    """This post's own (tile, preview) under ``derived/<file_id>/``."""
    return f"porch-{media_id}.thumb.webp", f"porch-{media_id}.preview.webp"


def forget_renders(file_id: uuid.UUID, media_id: uuid.UUID) -> None:
    """Drop a post's own renders (its edit changed, or it left the post)."""
    from app.files.derivatives import derived_dir

    for name in porch_files(media_id):
        (derived_dir(file_id) / name).unlink(missing_ok=True)


def _upright(fm: FileMedia | None) -> tuple[int, int] | None:
    if fm is None or not fm.width or not fm.height:
        return None
    if fm.orientation in (5, 6, 7, 8):
        return fm.height, fm.width
    return fm.width, fm.height


async def _ensure_render(pm: PorchPostMedia, row: UserFile, fm: FileMedia | None, which: str):  # noqa: ANN202 — Path | None
    """This post's edited tile or preview, made if missing."""
    from app.files.derivatives import derived_dir
    from app.files.storage import absolute_path
    from app.photos import edits

    thumb, preview = porch_files(pm.id)
    path = derived_dir(row.id) / (thumb if which == "thumb" else preview)
    if path.is_file():
        return path
    lock = _locks.setdefault(pm.id, asyncio.Lock())
    async with lock:
        if path.is_file():
            return path
        kind = fm.kind if fm is not None and fm.kind in ("image", "raw") else "image"
        try:
            await asyncio.to_thread(edits.render, absolute_path(row.storage_path), row.id, kind, pm.edit or {}, _upright(fm), (thumb, preview))
        except Exception:  # noqa: BLE001 — a picture that won't open: no tile, not a 500
            logger.warning("porch render failed for %s", pm.id, exc_info=True)
            return None
        finally:
            _locks.pop(pm.id, None)
    return path if path.is_file() else None


# ------------------------------------------------------------------ what can be posted


async def check_files(db: AsyncSession, user: User, file_ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[UserFile, FileMedia | None]]:
    """Your own photos and videos in your Photos library, within the video
    limits — or a 400 saying which rule failed."""
    from app.photos.library import hidden_folders, photos_folders

    from . import deps

    if not file_ids:
        return {}
    if len(file_ids) > MAX_MEDIA:
        raise core.bad(f"A post can have up to {MAX_MEDIA} photos and videos")
    tree, hidden = photos_folders(user.id), hidden_folders(user.id)
    q = (
        select(UserFile, FileMedia)
        .outerjoin(FileMedia, FileMedia.file_id == UserFile.id)
        .where(
            UserFile.id.in_(file_ids),
            UserFile.user_id == user.id,
            UserFile.trashed_at.is_(None),
            UserFile.folder_id.in_(select(tree.c.id)),
            UserFile.folder_id.not_in(select(hidden.c.id)),
        )
    )
    found = {row.id: (row, fm) for row, fm in (await db.execute(q)).all()}
    if set(file_ids) - set(found):
        raise core.bad("You can post only photos and videos from your own Photos library")
    s = await deps.settings(db)
    max_s = s.porch_video_max_seconds if s is not None else 300
    max_mb = s.porch_video_max_mb if s is not None else 1024
    for row, fm in found.values():
        mime = (row.mime_type or "").lower()
        if fm is not None and fm.kind not in ("image", "raw", "video"):
            raise core.bad("Only photos and videos can be posted")
        if fm is None and not (mime.startswith("image/") or mime.startswith("video/")):
            raise core.bad("Only photos and videos can be posted")
        if is_video(row, fm):
            too_long = fm is not None and fm.duration_ms is not None and fm.duration_ms > max_s * 1000
            if too_long or row.size_bytes > max_mb * 1024 * 1024:
                raise core.bad(f"Videos can be up to {_minutes(max_s)} and {_size(max_mb)} here")
    return found


def _minutes(seconds: int) -> str:
    if seconds % 60 == 0:
        m = seconds // 60
        return f"{m} minute{'s' if m != 1 else ''}"
    return f"{seconds} seconds"


def _size(mb: int) -> str:
    return f"{mb // 1024} GB" if mb % 1024 == 0 else f"{mb} MB"


# ------------------------------------------------------------------ reading


async def live_media(db: AsyncSession, post_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[tuple[PorchPostMedia, UserFile, FileMedia | None]]]:
    """Each post's photos in order, less any its owner has since trashed."""
    out: dict[uuid.UUID, list[tuple[PorchPostMedia, UserFile, FileMedia | None]]] = {pid: [] for pid in post_ids}
    if not post_ids:
        return out
    q = (
        select(PorchPostMedia, UserFile, FileMedia)
        .join(UserFile, UserFile.id == PorchPostMedia.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == UserFile.id)
        .where(PorchPostMedia.post_id.in_(post_ids), UserFile.trashed_at.is_(None))
        .order_by(PorchPostMedia.post_id, PorchPostMedia.position)
    )
    for pm, row, fm in (await db.execute(q)).all():
        out[pm.post_id].append((pm, row, fm))
    return out


def media_out(viewer: User, pm: PorchPostMedia, row: UserFile, fm: FileMedia | None, *, author: bool) -> dict[str, Any]:
    """One photo or video with links signed for ``viewer``."""
    from app.photos import edits

    def sign(code: str, ver: int) -> str:
        return media_urls.sign(pm.id, viewer.id, viewer.token_version, code, ver)

    video = is_video(row, fm)
    r = (fm.renditions or {}) if fm is not None else {}
    ready = fm is not None and fm.derivative_state == "ready"
    size = _upright(fm)
    thumbhash = fm.thumbhash if fm is not None else None
    width, height = size if size else (None, None)
    original_tag = media_urls.version_tag(row.storage_path, row.size_bytes)
    out: dict[str, Any] = {
        "id": str(pm.id),
        "position": pm.position,
        "kind": "video" if video else "image",
        "alt_text": pm.alt_text,
        "edit": pm.edit if author else None,
        "edited": bool(pm.edit),
        "thumb": None,
        "preview": None,
        "poster": None,
        "video": None,
        "full": None,
        "state": fm.derivative_state if fm is not None else "pending",
        "duration_ms": fm.duration_ms if fm is not None else None,
    }
    if author:
        out["file_id"] = str(row.id)
    if video:
        if ready and r.get("poster.webp"):
            out["poster"] = sign("porch_poster", media_urls.rendition_tag("poster.webp", r["poster.webp"]))
        if ready and r.get("video.mp4"):
            out["video"] = sign("porch_video", media_urls.rendition_tag("video.mp4", r["video.mp4"]))
        elif (row.mime_type or "").lower() in PLAYABLE:
            out["video"] = sign("porch_video", original_tag)
        out["full"] = sign("porch_full", original_tag)
    elif pm.edit:
        tag = media_urls.version_tag(original_tag, edit_tag(pm.edit))
        out["thumb"] = sign("porch_thumb", tag)
        out["preview"] = sign("porch_preview", tag)
        out["full"] = sign("porch_full", tag)
        if size:
            width, height = edits.edited_size(size[0], size[1], pm.edit)
    else:
        for code, rendition in (("porch_thumb", "thumb"), ("porch_preview", "preview")):
            got = media_urls.shown(r, rendition) if ready else None
            if got is not None:
                out[rendition] = sign(code, media_urls.rendition_tag(got[1], got[2]))
        photos_edit = r.get("edit") if isinstance(r.get("edit"), dict) else None
        if photos_edit:
            width, height = photos_edit.get("width") or width, photos_edit.get("height") or height
            thumbhash = photos_edit.get("thumbhash") or thumbhash
        out["full"] = sign("porch_full", media_urls.version_tag(original_tag, bool(photos_edit)))
    out["width"], out["height"], out["thumbhash"] = width, height, thumbhash
    return out


def cover_url(viewer: User, group: PorchGroup, fm: FileMedia | None) -> str | None:
    if group.cover_file_id is None or fm is None or fm.derivative_state != "ready":
        return None
    got = media_urls.shown(fm.renditions, "preview")
    if got is None:
        return None
    return media_urls.sign(group.id, viewer.id, viewer.token_version, "porch_cover", media_urls.rendition_tag(got[1], got[2]))


async def cover_urls(db: AsyncSession, viewer: User, groups: list[PorchGroup]) -> dict[uuid.UUID, str | None]:
    ids = [g.cover_file_id for g in groups if g.cover_file_id]
    fms: dict[uuid.UUID, FileMedia] = {}
    if ids:
        q = select(FileMedia).join(UserFile, UserFile.id == FileMedia.file_id).where(FileMedia.file_id.in_(ids), UserFile.trashed_at.is_(None))
        fms = {fm.file_id: fm for fm in (await db.execute(q)).scalars()}
    return {g.id: cover_url(viewer, g, fms.get(g.cover_file_id)) if g.cover_file_id else None for g in groups}


# ------------------------------------------------------------------ serving


def _headers(claim: media_urls.MediaClaim) -> dict[str, str]:
    left = max(claim.exp - int(datetime.now(timezone.utc).timestamp()), 0)
    return {
        "Cache-Control": f"private, max-age={left}, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }


def _send(path: Any, media_type: str, headers: dict[str, str], request: Request, *, blob: bool = False) -> Response:
    from app.files import storage

    if request.headers.get("x-promptly-accel") == "1":
        if blob:
            rel = path.resolve().relative_to(storage.UPLOAD_ROOT.resolve()).as_posix()
            target = "/_blobs/" + rel
        else:
            rel = path.resolve().relative_to((storage.UPLOAD_ROOT / "derived").resolve()).as_posix()
            target = "/_renditions/" + rel
        headers["X-Accel-Redirect"] = urllib.parse.quote(target, safe="/")
        return Response(status_code=status.HTTP_200_OK, media_type=media_type, headers=headers)
    return FileResponse(path=str(path), media_type=media_type, headers=headers)


async def serve(db: AsyncSession, claim: media_urls.MediaClaim, user: User, request: Request) -> Response:
    """The bytes behind a ``porch_*`` link, if ``user`` may see them now."""
    from app.files import storage
    from app.files.derivatives import rendition_path
    from app.files.router import _content_disposition, _safe_download_mime

    from . import access

    if claim.rendition == "porch_cover":
        return await _serve_cover(db, claim, user, request)
    pm = await db.get(PorchPostMedia, claim.file_id)
    if pm is None:
        raise _not_found()
    # The one rule, for everyone (server admins too: a reported post's
    # photos load only for someone who can see the post).
    if not await access.can_see_post(db, user, pm.post_id):
        raise _not_found()
    row = await db.get(UserFile, pm.file_id)
    if row is None or row.trashed_at is not None or not row.storage_path:
        raise _not_found()
    fm = await db.get(FileMedia, row.id)
    headers = _headers(claim)
    video = is_video(row, fm)
    r = (fm.renditions or {}) if fm is not None else {}

    if claim.rendition == "porch_full":
        ops = None if video else (pm.edit or await _photos_edit(db, row.id))
        if ops:
            from app.photos import edits

            kind = fm.kind if fm is not None and fm.kind in ("image", "raw") else "image"
            try:
                data = await asyncio.to_thread(edits.export_jpeg, storage.absolute_path(row.storage_path), kind, ops)
            except Exception:  # noqa: BLE001
                logger.warning("porch full render failed for %s", pm.id, exc_info=True)
                raise _not_found() from None
            stem = (row.filename or "photo").rsplit(".", 1)[0] or "photo"
            headers["Content-Disposition"] = _content_disposition(f"{stem}.jpg")
            return Response(content=data, media_type="image/jpeg", headers=headers)
        path = storage.absolute_path(row.storage_path)
        if not path.is_file():
            raise _not_found()
        headers["Content-Disposition"] = _content_disposition(row.filename)
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return _send(path, _safe_download_mime(row.mime_type, row.filename), headers, request, blob=True)

    if claim.rendition == "porch_video":
        if not video:
            raise _not_found()
        if r.get("video.mp4"):
            path = rendition_path(row.id, "video.mp4")
            if path.is_file():
                return _send(path, "video/mp4", headers, request)
        mime = (row.mime_type or "").lower()
        if mime in PLAYABLE:
            path = storage.absolute_path(row.storage_path)
            if path.is_file():
                return _send(path, mime, headers, request, blob=True)
        raise _not_found()

    if claim.rendition == "porch_poster":
        path = rendition_path(row.id, "poster.webp")
        if not video or not path.is_file():
            raise _not_found()
        return _send(path, "image/webp", headers, request)

    # porch_thumb / porch_preview
    which = "thumb" if claim.rendition == "porch_thumb" else "preview"
    if video:
        raise _not_found()
    if pm.edit:
        path = await _ensure_render(pm, row, fm, which)
    else:
        got = media_urls.shown(r, which) if fm is not None and fm.derivative_state == "ready" else None
        path = rendition_path(row.id, got[1]) if got else None
    if path is None or not path.is_file():
        raise _not_found()
    return _send(path, "image/webp", headers, request)


async def _photos_edit(db: AsyncSession, file_id: uuid.UUID) -> dict[str, Any] | None:
    """The library's own edit of the photo (Photos), if any."""
    from app.photos import edits

    ops = await db.scalar(text("SELECT ops FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    return None if not ops or edits.is_identity(ops) else ops


async def _serve_cover(db: AsyncSession, claim: media_urls.MediaClaim, user: User, request: Request) -> Response:
    from app.files.derivatives import rendition_path

    from . import access

    group = await db.get(PorchGroup, claim.file_id)
    if group is None or group.cover_file_id is None or await access.can_see_group(db, user, group) is None:
        raise _not_found()
    row = await db.get(UserFile, group.cover_file_id)
    fm = await db.get(FileMedia, group.cover_file_id)
    if row is None or row.trashed_at is not None or fm is None or fm.derivative_state != "ready":
        raise _not_found()
    got = media_urls.shown(fm.renditions, "preview")
    path = rendition_path(row.id, got[1]) if got else None
    if path is None or not path.is_file():
        raise _not_found()
    return _send(path, "image/webp", _headers(claim), request)


__all__ = ["MAX_MEDIA", "check_files", "clean_edit", "cover_urls", "forget_renders", "live_media", "media_out", "porch_files", "serve"]
