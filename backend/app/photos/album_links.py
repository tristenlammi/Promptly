"""Public album links (WP-9.5, Part E PH-1): an album anyone with the link can
look through — no account — like a grandparent opening "Holiday 2026".

Owner side (mounted at /api/photos/albums):

    GET    /{album_id}/links            the album's live links
    POST   /{album_id}/links            a new one (``keep_location``, ``expires_in_days``)
    DELETE /{album_id}/links/{link_id}  revoke it

Public side (mounted at /api/s, next to the other share links):

    GET /{token}/album                       title, owner, a page of photos
    GET /{token}/album/{file_id}/{rendition} a tile, preview, poster or web video
    GET /{token}/album/{file_id}/original    the photo itself, as a download
    GET /{token}/album/zip                   every photo, one streamed zip

Nobody following the link gets a location (decision D13): tiles, previews
and web videos are made without metadata, and an original is a stripped
copy — unless the owner ticked "include location" on that link. A link
that's revoked or expired stops at once; a photo taken out of the album (or
trashed) stops being reachable through it.
"""
from __future__ import annotations

import asyncio
import io
import secrets
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia, FileShareLink, UserFile
from app.photos.album_models import Album, AlbumItem
from app.photos.models import PhotoAsset

owner_router = APIRouter()
public_router = APIRouter()

_RENDITIONS = {"thumb": "thumb.webp", "preview": "preview.webp", "poster": "poster.webp", "video": "video.mp4"}
PAGE = 300


class LinkCreate(BaseModel):
    keep_location: bool = False
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


def _qr(url: str) -> str:
    from app.mfa.totp import qr_data_uri

    return qr_data_uri(url)


def _link_out(link: FileShareLink, request: Request) -> dict[str, Any]:
    path = f"/s/{link.token}"
    base = str(request.base_url).rstrip("/")
    return {
        "id": str(link.id),
        "path": path,
        "keep_location": link.keep_location,
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "created_at": link.created_at.isoformat(),
        "access_count": link.access_count,
        "qr": _qr(base + path),
    }


async def _owned_album(db: AsyncSession, album_id: uuid.UUID, user: User) -> Album:
    album = await db.get(Album, album_id)
    if album is None or album.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such album.")
    return album


@owner_router.get("/{album_id}/links")
async def list_links(
    album_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    album = await _owned_album(db, album_id, user)
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(FileShareLink)
            .where(
                FileShareLink.resource_type == "album", FileShareLink.resource_id == album.id,
                FileShareLink.revoked_at.is_(None),
                or_(FileShareLink.expires_at.is_(None), FileShareLink.expires_at > now),
            )
            .order_by(FileShareLink.created_at.desc())
        )
    ).scalars().all()
    return {"links": [_link_out(r, request) for r in rows]}


@owner_router.post("/{album_id}/links", status_code=status.HTTP_201_CREATED)
async def create_link(
    album_id: uuid.UUID, payload: LinkCreate, request: Request,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    album = await _owned_album(db, album_id, user)
    link = FileShareLink(
        resource_type="album", resource_id=album.id, created_by=user.id, token=secrets.token_urlsafe(32),
        access_mode="public", keep_location=payload.keep_location,
        expires_at=datetime.now(timezone.utc) + timedelta(days=payload.expires_in_days) if payload.expires_in_days else None,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    return _link_out(link, request)


@owner_router.delete("/{album_id}/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_link(
    album_id: uuid.UUID, link_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> Response:
    album = await _owned_album(db, album_id, user)
    link = await db.get(FileShareLink, link_id)
    if link is None or link.resource_type != "album" or link.resource_id != album.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such link.")
    link.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ public


async def _album_link(db: AsyncSession, request: Request, token: str, unlock: str | None) -> tuple[FileShareLink, Album]:
    from app.files.share_router import _gate_link, _load_live_link

    link = await _load_live_link(db, token)
    if link.resource_type != "album":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    await _gate_link(request, db, link, unlock_header=unlock)
    album = await db.get(Album, link.resource_id)
    if album is None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This album was deleted.")
    return link, album


def _in_album(album_id: uuid.UUID):  # noqa: ANN202
    return and_(AlbumItem.album_id == album_id, UserFile.trashed_at.is_(None))


@public_router.get("/{token}/album")
async def public_album(
    token: str, request: Request, before: str | None = None,
    x_share_unlock: str | None = Header(default=None), db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from app.files.share_router import _bump_access
    from app.photos.router import _cursor, _uncursor

    link, album = await _album_link(db, request, token, x_share_unlock)
    owner = await db.get(User, album.owner_id)
    newest = album.sort != "oldest"
    q = (
        select(PhotoAsset, UserFile, FileMedia)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(_in_album(album.id))
    )
    if before:
        when, fid = _uncursor(before)
        cmp = (PhotoAsset.taken_local < when) if newest else (PhotoAsset.taken_local > when)
        tie = (PhotoAsset.file_id < fid) if newest else (PhotoAsset.file_id > fid)
        q = q.where(or_(cmp, and_(PhotoAsset.taken_local == when, tie)))
    order = (PhotoAsset.taken_local.desc(), PhotoAsset.file_id.desc()) if newest else (PhotoAsset.taken_local.asc(), PhotoAsset.file_id.asc())
    rows = (await db.execute(q.order_by(*order).limit(PAGE + 1))).all()
    more = len(rows) > PAGE
    rows = rows[:PAGE]
    base = f"/api/s/{token}/album"
    items = []
    for asset, row, media in rows:
        ready = media is not None and media.derivative_state == "ready"
        have = set((media.renditions or {}) if ready else ())
        width, height = (media.width, media.height) if media is not None else (None, None)
        if media is not None and media.orientation in (5, 6, 7, 8) and width and height:
            width, height = height, width
        edit = (media.renditions or {}).get("edit") if media is not None else None  # edited (PH-7)
        if edit:
            width, height = edit.get("width") or width, edit.get("height") or height
        items.append({
            "id": str(row.id),
            "kind": asset.kind,
            # The day it was taken — never where.
            "taken_local": asset.taken_local.isoformat(),
            "width": width,
            "height": height,
            "duration_ms": media.duration_ms if media is not None else None,
            "thumbhash": (edit or {}).get("thumbhash") or (media.thumbhash if media is not None else None),
            **{k: f"{base}/{row.id}/{k}" if v in have else None for k, v in _RENDITIONS.items()},
            "original": f"{base}/{row.id}/original",
            "filename": row.filename,
        })
    if not before:
        await _bump_access(db, link)
    total = (
        await db.execute(
            select(AlbumItem.file_id).join(UserFile, UserFile.id == AlbumItem.file_id).where(_in_album(album.id))
        )
    ).all()
    return {
        "title": album.title,
        "description": album.description,
        "owner": owner.username if owner else None,
        "count": len(total),
        "items": items,
        "next_cursor": _cursor(rows[-1][0].taken_local, rows[-1][0].file_id) if more and rows else None,
        "zip": f"{base}/zip",
        # Whether this link's owner chose to include where photos were taken.
        "location": link.keep_location,
    }


async def _item(db: AsyncSession, album: Album, file_id: uuid.UUID) -> UserFile:
    row = (
        await db.execute(
            select(UserFile).join(AlbumItem, AlbumItem.file_id == UserFile.id).where(_in_album(album.id), UserFile.id == file_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not in this album.")
    return row


@public_router.get("/{token}/album/zip")
async def public_album_zip(
    token: str, request: Request, x_share_unlock: str | None = Header(default=None), db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    from app.files.share_router import _share_content_disposition

    link, album = await _album_link(db, request, token, x_share_unlock)
    rows = (
        await db.execute(
            select(UserFile).join(AlbumItem, AlbumItem.file_id == UserFile.id).where(_in_album(album.id))
            .order_by(AlbumItem.added_at)
        )
    ).scalars().all()
    files = [(r.filename, r.storage_path, r.mime_type) for r in rows if r.storage_path]
    keep = link.keep_location
    return StreamingResponse(
        _zip_stream(files, keep),
        media_type="application/zip",
        headers={"Content-Disposition": _share_content_disposition(f"{album.title or 'Album'}.zip")},
    )


class _Sink(io.RawIOBase):
    """Where zipfile writes; the generator drains it after each chunk."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:  # noqa: ANN001
        self.parts.append(bytes(b))
        return len(b)

    def take(self) -> bytes:
        out = b"".join(self.parts)
        self.parts.clear()
        return out


def _zip_stream(files: list[tuple[str, str, str]], keep_location: bool) -> Iterator[bytes]:
    """A zip of the originals (stripped unless the link keeps location),
    stored rather than compressed — photos and videos are compressed
    already — and sent as it's written. Runs in a worker thread."""
    from app.files import egress
    from app.files.storage import absolute_path

    sink = _Sink()
    seen: set[str] = set()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for name, rel, mime in files:
            arc = name
            stem, dot, ext = name.rpartition(".")
            i = 1
            while arc.lower() in seen:
                arc = f"{stem} ({i}).{ext}" if dot else f"{name} ({i})"
                i += 1
            seen.add(arc.lower())
            path = absolute_path(rel)
            if not keep_location and mime in egress.STRIPPABLE_MIMES:
                stripped = egress.public_copy(rel, mime)
                if stripped is None:
                    continue  # never send it with its location
                path = stripped
            if not path.is_file():
                continue
            with zf.open(arc, "w", force_zip64=True) as dest, open(path, "rb") as src:
                while chunk := src.read(1024 * 1024):
                    dest.write(chunk)
                    yield sink.take()
        # (the central directory)
    yield sink.take()


@public_router.get("/{token}/album/{file_id}/{rendition}")
async def public_album_file(
    token: str, file_id: uuid.UUID, rendition: str, request: Request,
    x_share_unlock: str | None = Header(default=None), db: AsyncSession = Depends(get_db),
) -> Response:
    from app.files.derivatives import rendition_path
    from app.files.router import _safe_download_mime
    from app.files.share_router import _egress_path, _share_content_disposition

    link, album = await _album_link(db, request, token, x_share_unlock)
    row = await _item(db, album, file_id)
    headers = {"X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin"}
    if rendition == "original":
        path = await _egress_path(link, row)
        headers["Content-Disposition"] = _share_content_disposition(row.filename)
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return FileResponse(str(path), media_type=_safe_download_mime(row.mime_type, row.filename), headers=headers)
    name = _RENDITIONS.get(rendition)
    if name is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such size.")
    path = rendition_path(row.id, name)
    if rendition in ("thumb", "preview"):
        edited = rendition_path(row.id, name.replace(".webp", ".edit.webp"))  # as edited (PH-7)
        if await asyncio.to_thread(edited.is_file):
            path = edited
    if not await asyncio.to_thread(path.is_file):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not ready yet.")
    headers["Cache-Control"] = "public, max-age=3600"
    return FileResponse(str(path), media_type="video/mp4" if rendition == "video" else "image/webp", headers=headers)


__all__ = ["owner_router", "public_router"]
