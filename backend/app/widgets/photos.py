"""The Photo widget's two reads (``/api/widgets/photos/…``).

A phone's home-screen widget shows photos from one album, a different one
every so often. It asks for:

* the albums you could pick — yours and the ones shared with you (the same
  rule as ``/api/photos/albums``: owner or member, nobody else);
* a handful of photos from one album, picked at random here so the phone
  never needs the whole list. Videos are left out, and so is anything in the
  trash or still waiting for its preview.

Each photo comes with short-lived signed links (``/m/…``) to its preview and
its small tile; the phone downloads one, shrinks it and keeps its own copy.
Nothing is written.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files import media_urls
from app.files.models import FileMedia, UserFile
from app.photos.album_models import Album, AlbumItem, AlbumMember
from app.photos.models import PhotoAsset

MAX_HAVE = 60


def _images(album_ids):  # noqa: ANN001, ANN202 — AlbumItem ⨝ UserFile ⨝ PhotoAsset, photos only
    return (
        select(AlbumItem.album_id, AlbumItem.file_id)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .where(AlbumItem.album_id.in_(album_ids), UserFile.trashed_at.is_(None), PhotoAsset.kind == "image")
    )


async def albums(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """Your albums and the ones shared with you, most recently changed first."""
    from app.photos.albums_router import _cover

    member_of = select(AlbumMember.album_id).where(AlbumMember.user_id == user.id)
    rows = (
        await db.execute(
            select(Album).where(or_(Album.owner_id == user.id, Album.id.in_(member_of))).order_by(Album.updated_at.desc())
        )
    ).scalars().all()
    ids = [a.id for a in rows]
    counts: dict[uuid.UUID, int] = {}
    if ids:
        sub = _images(ids).subquery()
        counts = dict((await db.execute(select(sub.c.album_id, func.count()).group_by(sub.c.album_id))).all())
    out = []
    for a in rows:
        cover = await _cover(db, a, user)
        out.append({
            "id": str(a.id),
            "title": a.title,
            "count": counts.get(a.id, 0),
            "shared": a.owner_id != user.id,
            "cover": (cover or {}).get("thumb"),
        })
    return out


async def pick(db: AsyncSession, user: User, album_id: uuid.UUID, n: int, have: list[uuid.UUID]) -> dict[str, Any] | None:
    """Up to ``n`` photos from the album at random, ones the phone doesn't
    hold (``have``) first; None when the album isn't there for this person."""
    album = await db.get(Album, album_id)
    if album is None:
        return None
    if album.owner_id != user.id and await db.get(AlbumMember, (album.id, user.id)) is None:
        return None
    sub = _images([album.id]).subquery()
    count = (await db.execute(select(func.count()).select_from(sub))).scalar_one()
    q = (
        select(UserFile.id, FileMedia)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .join(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(
            AlbumItem.album_id == album.id, UserFile.trashed_at.is_(None), PhotoAsset.kind == "image",
            FileMedia.derivative_state == "ready",
        )
    )
    order = [func.random()]
    if have:
        # New ones first; if the album has nothing new, ones it has again.
        order.insert(0, AlbumItem.file_id.in_(have[:MAX_HAVE]))
    rows = (await db.execute(q.order_by(*order).limit(n))).all()
    photos = []
    for fid, media in rows:
        thumb = media_urls.sign_shown(fid, user.id, user.token_version, media.renditions, "thumb")
        url = media_urls.sign_shown(fid, user.id, user.token_version, media.renditions, "preview") or thumb
        if url is None:
            continue
        width, height = media.width, media.height
        if media.orientation in (5, 6, 7, 8) and width and height:
            width, height = height, width
        photos.append({"id": str(fid), "url": url, "thumb": thumb, "width": width, "height": height})
    # Ones the phone holds that have left the album (or gone to the trash): it drops them.
    gone: list[str] = []
    if have:
        held = have[:MAX_HAVE]
        still = set((await db.execute(select(sub.c.file_id).where(sub.c.file_id.in_(held)))).scalars().all())
        gone = [str(h) for h in held if h not in still]
    return {"album": {"id": str(album.id), "title": album.title, "count": count}, "photos": photos, "gone": gone}
