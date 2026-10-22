"""What's in someone's photo library, and keeping it in step (WP-9.1).

The library is the person's **Photos folder** — the locked system folder
(``system_kind = 'camera_uploads'``, shown as "Photos") — and every
subfolder in it, like Google Photos: uploads from the Photos tab, phone
backups, shared-to-the-app photos and imports land there, by year and
month. Pictures anywhere else in My files are ordinary files, not Photos
("Move to Photos" files one in). Left out even inside it:

* what's in the trash;
* any folder marked "Hide from Photos", and everything inside it;
* the video half of a Live Photo (it plays behind its still).

``photo_assets`` holds a row per photo or video (``sync``, called when the
media worker reads a file and when its date or place is edited); the
folder rules are applied when the library is read, so moving a folder in
or out of a hidden one needs nothing doing.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileFolder, FileMedia, UserFile
from app.photos.models import PhotoAsset

PHOTOS_KIND = "camera_uploads"

# The same rule for the background stages, in SQL over ``p`` (photo_assets)
# and ``f`` (files), for every user at once: ``LIBRARY_CTES`` goes in front
# of the query, ``LIBRARY_WHERE`` in its WHERE.
LIBRARY_CTES = (
    "WITH RECURSIVE lib_photos(user_id, id) AS ("
    "  SELECT user_id, id FROM file_folders WHERE system_kind = '" + PHOTOS_KIND + "' AND trashed_at IS NULL"
    "  UNION ALL SELECT lp.user_id, c.id FROM file_folders c JOIN lib_photos lp ON c.parent_id = lp.id"
    "), lib_hidden(id) AS ("
    "  SELECT id FROM file_folders WHERE hide_from_photos"
    "  UNION ALL SELECT c.id FROM file_folders c JOIN lib_hidden h ON c.parent_id = h.id"
    ") "
)
LIBRARY_WHERE = (
    "f.folder_id IN (SELECT lp.id FROM lib_photos lp WHERE lp.user_id = p.user_id)"
    " AND f.folder_id NOT IN (SELECT id FROM lib_hidden)"
)


def user_zone(user) -> ZoneInfo | None:  # noqa: ANN001 — User | None
    """The owner's own time zone (Account → their settings), if set."""
    name = ((getattr(user, "settings", None) or {}).get("timezone") or "").strip()
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def taken_local(instant: datetime, offset_minutes: int | None, zone: ZoneInfo | None = None) -> datetime:
    """The wall-clock time where it was taken: the photo's own offset when
    it recorded one; else the owner's time zone (a screenshot, a scan, a
    date they typed in); else UTC."""
    if offset_minutes is None and zone is not None:
        return instant.astimezone(zone).replace(tzinfo=None)
    utc = instant.astimezone(timezone.utc).replace(tzinfo=None)
    return utc + timedelta(minutes=offset_minutes or 0)


def _asset_kind(media_kind: str) -> str | None:
    return {"image": "image", "raw": "image", "video": "video"}.get(media_kind)


async def sync(db: AsyncSession, file_id: uuid.UUID) -> None:
    """Bring a file's ``photo_assets`` row in line with its file and its
    metadata. Flushed, not committed."""
    row = await db.get(UserFile, file_id)
    media = await db.get(FileMedia, file_id)
    asset = await db.get(PhotoAsset, file_id)
    kind = _asset_kind(media.kind) if media is not None else None
    if row is None or row.user_id is None or media is None or media.extracted_at is None or kind is None:
        if asset is not None:
            await db.delete(asset)
            await db.flush()
        return
    instant = media.taken_at_override or media.taken_at or row.client_mtime or row.created_at
    offset = None if media.taken_at_override else media.tz_offset
    if asset is None:
        # A new photo: memories are made again at the next look (PH-5).
        from app.photos.memories import forget_fresh

        await forget_fresh(row.user_id)
        asset = PhotoAsset(file_id=file_id, user_id=row.user_id)
        # Archived where it came from (Google Photos): archived here too.
        from app.imports.models import FileImportMeta

        imported = await db.get(FileImportMeta, file_id)
        if imported is not None and imported.archived:
            asset.archived_at = datetime.now(timezone.utc)
        db.add(asset)
    asset.user_id = row.user_id
    asset.kind = kind
    asset.taken_at = instant
    from app.auth.models import User

    asset.taken_local = taken_local(instant, offset, user_zone(await db.get(User, row.user_id)))
    asset.live_hidden = kind == "video" and media.live_pair_file_id is not None
    await db.flush()
    # A location that changed (an edit, a re-read) is placed again (PH-2).
    from app.photos.understanding import forget_if_changed

    await forget_if_changed(db, file_id, media)


async def refile_zoneless(db: AsyncSession, user_id: uuid.UUID, zone_name: str | None, old_zone: str | None = None) -> int:
    """The owner's time zone changed: photos that don't carry their own
    (and dates typed in by hand) move to their days in the new one — except
    a camera's zoneless clock, which keeps its wall time (read as the old
    zone, it's now read as the new one). Flushed, not committed."""
    from sqlalchemy import text

    params = {"old": old_zone or "UTC", "tz": zone_name or "UTC", "u": user_id}
    await db.execute(
        text(
            "UPDATE file_media AS m SET taken_at = ((m.taken_at AT TIME ZONE :old) AT TIME ZONE :tz) "
            "FROM files AS f WHERE f.id = m.file_id AND f.user_id = :u "
            "AND m.taken_at_source = 'exif' AND m.tz_offset IS NULL AND m.taken_at IS NOT NULL"
        ),
        params,
    )
    await db.execute(
        text(
            "UPDATE photo_assets AS p SET taken_at = m.taken_at FROM file_media AS m "
            "WHERE m.file_id = p.file_id AND p.user_id = :u AND m.taken_at_override IS NULL "
            "AND m.taken_at_source = 'exif' AND m.tz_offset IS NULL AND m.taken_at IS NOT NULL"
        ),
        {"u": user_id},
    )
    result = await db.execute(
        text(
            "UPDATE photo_assets AS p SET taken_local = (p.taken_at AT TIME ZONE :tz), updated_at = now() "
            "FROM file_media AS m WHERE m.file_id = p.file_id AND p.user_id = :u "
            "AND (m.taken_at_override IS NOT NULL OR m.tz_offset IS NULL)"
        ),
        {"tz": zone_name or "UTC", "u": user_id},
    )
    return result.rowcount or 0


def photos_folders(user_id: uuid.UUID):  # noqa: ANN201 — a CTE
    """The person's Photos folder and every folder inside it."""
    base = (
        select(FileFolder.id)
        .where(FileFolder.user_id == user_id, FileFolder.system_kind == PHOTOS_KIND, FileFolder.trashed_at.is_(None))
        .cte("photos_tree", recursive=True)
    )
    return base.union_all(select(FileFolder.id).join(base, FileFolder.parent_id == base.c.id))


def hidden_folders(user_id: uuid.UUID):  # noqa: ANN201 — a CTE
    """Folders marked "Hide from Photos", and everything inside them."""
    base = (
        select(FileFolder.id)
        .where(FileFolder.user_id == user_id, FileFolder.hide_from_photos.is_(True))
        .cte("photos_hidden", recursive=True)
    )
    return base.union_all(select(FileFolder.id).join(base, FileFolder.parent_id == base.c.id))


# Photos in albums someone owns or was invited to — searched with their own
# (PH-4 follow-up): ``:u`` is the asker.
SHARED_SQL = (
    "SELECT ai.file_id FROM album_items ai JOIN albums al ON al.id = ai.album_id "
    "WHERE al.owner_id = :u OR EXISTS (SELECT 1 FROM album_members am WHERE am.album_id = al.id AND am.user_id = :u) "
    # …and their family library (PH-5).
    "UNION SELECT fi.file_id FROM photo_family_items fi "
    "JOIN photo_family_members fm ON fm.family_id = fi.family_id AND fm.user_id = :u"
)


def shared_with(user_id: uuid.UUID):  # noqa: ANN201 — a subquery of file ids
    """The photos in albums this person owns or is a member of, and in
    their family library."""
    from app.photos.album_models import Album, AlbumItem, AlbumMember

    from sqlalchemy import text as sql

    member = select(AlbumMember.album_id).where(AlbumMember.user_id == user_id)
    albums = (
        select(AlbumItem.file_id)
        .join(Album, Album.id == AlbumItem.album_id)
        .where(or_(Album.owner_id == user_id, Album.id.in_(member)))
    )
    family = select(sql("fi.file_id")).select_from(
        sql("photo_family_items fi JOIN photo_family_members fm ON fm.family_id = fi.family_id")
    ).where(sql("fm.user_id = :fam_reader").bindparams(fam_reader=user_id))
    return albums.union(family)


def in_library(user_id: uuid.UUID):  # noqa: ANN201 — a WHERE clause
    """Rows of ``photo_assets`` joined to ``files`` that are in the library:
    inside the Photos folder, not hidden, not in the trash."""
    tree, hidden = photos_folders(user_id), hidden_folders(user_id)
    return and_(
        PhotoAsset.user_id == user_id,
        PhotoAsset.live_hidden.is_(False),
        UserFile.trashed_at.is_(None),
        UserFile.folder_id.in_(select(tree.c.id)),
        UserFile.folder_id.not_in(select(hidden.c.id)),
    )


__all__ = [
    "LIBRARY_CTES", "LIBRARY_WHERE", "PHOTOS_KIND", "hidden_folders", "photos_folders", "SHARED_SQL", "in_library", "refile_zoneless", "shared_with", "sync", "taken_local",
    "user_zone",
]
