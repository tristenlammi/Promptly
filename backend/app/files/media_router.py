"""A photo's or video's details (WP-7.3, Part C §4.3).

    GET   /api/files/{id}/media    when / where it was taken, size, camera, duration, Live Photo pair
    PATCH /api/files/{id}/media    correct the date or the location (the owner) — the original is untouched
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia

router = APIRouter()


class MediaPatch(BaseModel):
    taken_at: datetime | None = None
    reset_taken_at: bool = False
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    hide_location: bool | None = None
    reset_location: bool = False


@router.get("/{file_id:uuid}/media")
async def get_media(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.files.media_meta import effective, media_kind
    from app.files.router import _load_readable_file

    row = await _load_readable_file(db, file_id, user)
    if media_kind(row.mime_type) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a photo or video")
    out = effective(await db.get(FileMedia, row.id), row)
    out["can_edit"] = row.user_id == user.id
    # A description brought in with it (Takeout, WP-10.2).
    from app.imports.models import FileImportMeta

    imported = await db.get(FileImportMeta, row.id)
    out["description"] = imported.description if imported is not None else None
    # Where that is (PH-2): the nearest place, offline — shown with the location.
    out["place"] = None
    if out.get("location"):
        from app.photos import places
        from app.photos.models import PhotoAsset

        asset = await db.get(PhotoAsset, row.id)
        place = await places.describe(db, asset.place_id) if asset is not None else None
        out["place"] = {**place.to_dict(), "attribution": places.ATTRIBUTION} if place else None
    # The wall-clock time Photos shows it at (the owner's zone where the photo
    # has none of its own), so the info and the viewer agree.
    from app.photos.models import PhotoAsset as _Asset

    shown = await db.get(_Asset, row.id)
    out["taken_local"] = shown.taken_local.isoformat() if shown is not None else None
    # Animals found (PH-2): what kind, for anyone who can see the photo.
    from sqlalchemy import text as _sql

    out["animals"] = [
        {"species": sp, "x": x, "y": y, "w": w, "h": h}
        for sp, x, y, w, h in (
            await db.execute(
                _sql("SELECT species, box_x, box_y, box_w, box_h FROM photo_animals WHERE file_id = :f ORDER BY box_x"),
                {"f": row.id},
            )
        ).all()
    ]
    # Text read in it, and its description (PH-2).
    out["text"] = await db.scalar(_sql("SELECT text FROM photo_text WHERE file_id = :f"), {"f": row.id})
    described = (
        await db.execute(_sql("SELECT caption, tags FROM photo_captions WHERE file_id = :f"), {"f": row.id})
    ).first()
    out["caption"] = {"text": described[0], "tags": described[1]} if described else None
    # Faces found (PH-2) — the owner's own, only when they turned faces on.
    out["faces"] = None
    if row.user_id == user.id and (user.settings or {}).get("photos_faces"):
        from sqlalchemy import text as sql

        out["faces"] = [
            {"x": x, "y": y, "w": w, "h": h}
            for x, y, w, h in (
                await db.execute(
                    sql("SELECT box_x, box_y, box_w, box_h FROM photo_faces WHERE file_id = :f ORDER BY box_x"),
                    {"f": row.id},
                )
            ).all()
        ]
    return out


@router.patch("/{file_id:uuid}/media")
async def patch_media(
    file_id: uuid.UUID,
    body: MediaPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.files.media_meta import effective, media_kind
    from app.files.router import _load_writable_file

    row = await _load_writable_file(db, file_id, user)
    kind = media_kind(row.mime_type)
    if kind is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a photo or video")
    media = await db.get(FileMedia, row.id)
    if media is None:
        # Not read yet — keep the correction; reading it later won't undo it.
        media = FileMedia(file_id=row.id, kind=kind)
        db.add(media)
    if body.reset_taken_at:
        media.taken_at_override = None
    elif body.taken_at is not None:
        t = body.taken_at
        media.taken_at_override = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    if body.reset_location:
        media.lat_override = media.lon_override = None
        media.location_hidden = False
    else:
        if (body.lat is None) != (body.lon is None):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Give both latitude and longitude.")
        if body.lat is not None:
            media.lat_override, media.lon_override = round(body.lat, 6), round(body.lon, 6)
            media.location_hidden = False
        if body.hide_location is not None:
            media.location_hidden = body.hide_location
    from app.photos.library import sync as sync_photo

    await db.flush()
    await sync_photo(db, row.id)
    await db.commit()
    await db.refresh(media)
    out = effective(media, row)
    out["can_edit"] = True
    return out


__all__ = ["router"]
