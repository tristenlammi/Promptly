"""Signed media links: minting and serving (WP-7.5, Part C §4.6).

    GET       /api/files/{id}/signed-urls   links to a file's bytes and renditions
    GET|HEAD  /api/m/{token}                the bytes (nginx: /m/{token})

See :mod:`app.files.media_urls` for the token.
"""
from __future__ import annotations

import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files import media_urls

router = APIRouter()
urls_router = APIRouter()

# Video the browser plays as uploaded, while the web copy is being made.
_PLAYABLE_ORIGINALS = frozenset({"video/mp4", "video/webm"})


def _not_found() -> HTTPException:
    # Expired, forged, revoked or no longer shared all look the same.
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link expired or not found")


def _has_blob(row: Any) -> bool:
    """Bytes of its own to hand out. Sheets and whiteboards are exported
    from their live content, and a Document downloads as Word — their
    stored files are internal."""
    from app.files.office import is_shell

    return bool(row.storage_path) and not is_shell(row) and row.source_kind != "document"


@urls_router.get("/{file_id:uuid}/signed-urls")
async def signed_urls(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Links that work in ``<img>``, ``<video>`` and ``<a download>`` for a
    few hours: the original (always as an attachment) and, once the media
    worker has made them, the tile, the preview, a video's poster and its
    web-playable copy. A link is ``null`` when there's nothing to serve."""
    from app.files.models import FileMedia
    from app.files.router import _load_readable_file

    row = await _load_readable_file(db, file_id, user)

    def sign(rendition: str, ver: int) -> str:
        return media_urls.sign(row.id, user.id, user.token_version, rendition, ver)

    out: dict[str, Any] = {name: None for name in media_urls.RENDITIONS}
    out["original"] = sign("original", media_urls.version_tag(row.storage_path, row.size_bytes)) if _has_blob(row) else None
    media = await db.get(FileMedia, row.id)
    state = media.derivative_state if media is not None else None
    if media is not None and state == "ready":
        for rendition in media_urls.RENDITIONS:
            if rendition in media_urls.RENDITION_FILE:
                out[rendition] = media_urls.sign_shown(row.id, user.id, user.token_version, media.renditions, rendition)
        # An edited photo (PH-7): the preview before the edit, for the editor.
        info = (media.renditions or {}).get("preview.webp")
        out["edited"] = bool((media.renditions or {}).get("edit"))
        out["source"] = sign("preview", media_urls.rendition_tag("preview.webp", info)) if info else None
    mime = (row.mime_type or "").lower()
    if out["video"] is None and mime in _PLAYABLE_ORIGINALS and out["original"]:
        out["video"] = out["original"]
    out["state"] = state
    out["expires_at"] = datetime.fromtimestamp(media_urls.expiry(), tz=timezone.utc).isoformat()
    return out


@router.api_route("/{token}", methods=["GET", "HEAD"])
async def serve(token: str, request: Request, db: AsyncSession = Depends(get_db)) -> Response:
    """The bytes behind a signed link. The link proves who it was issued
    to; whether they may *still* read the file is checked now."""
    from app.files import storage
    from app.files.derivatives import rendition_path
    from app.files.router import _content_disposition, _load_readable_file, _safe_download_mime

    claim = media_urls.verify(token)
    if claim is None:
        raise _not_found()
    user = await db.get(User, claim.user_id)
    if user is None or user.disabled or int(user.token_version) != claim.token_version:
        raise _not_found()
    if claim.rendition == "zip":
        return await _serve_zip(claim, request)
    if claim.rendition == "version":
        return await _serve_version(db, claim, user, request)
    if claim.rendition == "export":
        return await _serve_export(claim)
    if claim.rendition == "face":
        return await _serve_crop(db, claim, request)
    try:
        row = await _load_readable_file(db, claim.file_id, user)
    except HTTPException:
        raise _not_found() from None

    left = max(claim.exp - int(datetime.now(timezone.utc).timestamp()), 0)
    headers = {
        # The URL names exactly these bytes (its version tag changes with
        # them), so the browser needn't ask again while it's valid.
        "Cache-Control": f"private, max-age={left}, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if claim.rendition == "original":
        if not _has_blob(row):
            raise _not_found()
        path = storage.absolute_path(row.storage_path)
        media_type = _safe_download_mime(row.mime_type, row.filename)
        # As /download: never rendered as a page on our origin. (<img> and
        # <video> ignore both headers.)
        headers["Content-Disposition"] = _content_disposition(row.filename)
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    else:
        path = rendition_path(row.id, media_urls.RENDITION_FILE[claim.rendition])
        media_type = "video/mp4" if claim.rendition == "video" else "image/webp"
    if not path.is_file():
        raise _not_found()

    if request.headers.get("x-promptly-accel") == "1":
        # nginx serves it from its read-only mount: Range, sendfile, and no
        # bytes through this worker.
        if claim.rendition == "original":
            rel = path.resolve().relative_to(storage.UPLOAD_ROOT.resolve()).as_posix()
            target = "/_blobs/" + rel
        else:
            rel = path.resolve().relative_to((storage.UPLOAD_ROOT / "derived").resolve()).as_posix()
            target = "/_renditions/" + rel
        headers["X-Accel-Redirect"] = urllib.parse.quote(target, safe="/")
        return Response(status_code=status.HTTP_200_OK, media_type=media_type, headers=headers)
    # No nginx in front (tests, a bare backend): Starlette streams it, Range
    # and HEAD included.
    return FileResponse(path=str(path), media_type=media_type, headers=headers)


async def _serve_version(db: AsyncSession, claim: media_urls.MediaClaim, user: User, request: Request) -> Response:
    """An earlier version of an uploaded file (WP-8.1): whoever may read the
    file may download its versions."""
    from app.files import storage
    from app.files.blob_versions import version_filename
    from app.files.models import FileVersion, UserFile
    from app.files.router import _content_disposition, _load_readable_file, _safe_download_mime

    v = await db.get(FileVersion, claim.file_id)
    if v is None or not v.storage_path:
        raise _not_found()
    try:
        row: UserFile = await _load_readable_file(db, v.file_id, user)
    except HTTPException:
        raise _not_found() from None
    path = storage.absolute_path(v.storage_path)
    if not path.is_file():
        raise _not_found()
    name = version_filename(row, v)
    headers = {
        "Cache-Control": "private, max-age=3600, immutable",
        "Content-Disposition": _content_disposition(name),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    media_type = _safe_download_mime(row.mime_type, row.filename)
    if request.headers.get("x-promptly-accel") == "1":
        headers["X-Accel-Redirect"] = urllib.parse.quote("/_blobs/" + v.storage_path, safe="/")
        return Response(status_code=status.HTTP_200_OK, media_type=media_type, headers=headers)
    return FileResponse(path=str(path), media_type=media_type, headers=headers)


async def _serve_crop(db: AsyncSession, claim: media_urls.MediaClaim, request: Request) -> Response:
    """A face's or animal's square crop (PH-3) — the photo's owner's only;
    made on first ask."""
    from app.files import storage
    from app.photos import crops

    path = await crops.ensure(db, claim.file_id, claim.user_id)
    if path is None or not path.is_file():
        raise _not_found()
    headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if request.headers.get("x-promptly-accel") == "1":
        rel = path.resolve().relative_to((storage.UPLOAD_ROOT / "derived").resolve()).as_posix()
        headers["X-Accel-Redirect"] = urllib.parse.quote("/_renditions/" + rel, safe="/")
        return Response(status_code=status.HTTP_200_OK, media_type="image/webp", headers=headers)
    return FileResponse(path=str(path), media_type="image/webp", headers=headers)


async def _serve_export(claim: media_urls.MediaClaim) -> Response:
    """A part of a library export (WP-10.4), written as it downloads."""
    from fastapi.responses import StreamingResponse

    from app.files import library_export
    from app.files.router import _content_disposition

    export_id = str(claim.file_id)
    state = await library_export.load(export_id)
    n = claim.ver
    if (
        state is None or state["user_id"] != str(claim.user_id) or not 1 <= n <= len(state["parts"])
        or not library_export.plan_path(export_id).exists()
    ):
        raise _not_found()
    return StreamingResponse(
        library_export.stream_part(export_id, n),
        media_type="application/zip",
        headers={
            "Content-Disposition": _content_disposition(library_export.part_name(state, n)),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            # Straight through nginx as it's written, not spooled to its disk.
            "X-Accel-Buffering": "no",
        },
    )


async def _serve_zip(claim: media_urls.MediaClaim, request: Request) -> Response:
    """A zip download (WP-7.6): its job must be this user's, and ready.
    (The files in it were checked when it was made.)"""
    from app.files import zip_jobs
    from app.files.router import _content_disposition

    job = await zip_jobs.load(str(claim.file_id))
    path = zip_jobs.zip_path(claim.file_id)
    if job is None or job.get("user_id") != str(claim.user_id) or job.get("state") != "ready" or not path.is_file():
        raise _not_found()
    headers = {
        "Cache-Control": "private, no-store",
        "Content-Disposition": _content_disposition(job.get("name") or "promptly-files.zip"),
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("x-promptly-accel") == "1":
        headers["X-Accel-Redirect"] = f"/_renditions/zips/{claim.file_id}.zip"
        return Response(status_code=status.HTTP_200_OK, media_type="application/zip", headers=headers)
    return FileResponse(path=str(path), media_type="application/zip", headers=headers)


__all__ = ["router", "urls_router"]
