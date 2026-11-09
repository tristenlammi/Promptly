"""What the composer asks before you post (WP-P1.4, build §3.3).

For the photos you've just picked or uploaded — always your own — what
Photos already knows about them:

* a **description** for screen readers, from the caption Photos wrote for it
  (only there if you turned descriptions on in Photos), which you can change;
* the **place** it was taken (the nearest town, from Photos' own places), so
  "Add place" can offer it first. Never for a photo whose location you hid
  in Photos, and never the exact spot: the town's own point on the map.

Someone else's file, or one in the trash, just isn't in the answer.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia, UserFile

from . import core
from .deps import require_porch

router = APIRouter()


class FilesIn(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=60)


@router.post("/compose/files")
async def describe_files(body: FilesIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict[str, Any]:
    """Each of your photos' description (alt text) and place, if Photos has them."""
    from app.photos import places
    from app.photos.models import PhotoAsset

    ids = list(dict.fromkeys(body.file_ids))
    rows = (
        await db.execute(
            select(UserFile.id, FileMedia.location_hidden, PhotoAsset.place_id)
            .outerjoin(FileMedia, FileMedia.file_id == UserFile.id)
            .outerjoin(PhotoAsset, PhotoAsset.file_id == UserFile.id)
            .where(UserFile.id.in_(ids), UserFile.user_id == user.id, UserFile.trashed_at.is_(None))
        )
    ).all()
    found = {r[0]: r for r in rows}
    captions: dict[uuid.UUID, str] = {}
    if found:
        got = await db.execute(text("SELECT file_id, caption FROM photo_captions WHERE file_id = ANY(:ids)"), {"ids": list(found)})
        captions = {fid: (cap or "").strip() for fid, cap in got.all()}
    named: dict[int, dict[str, Any] | None] = {}
    out: list[dict[str, Any]] = []
    for fid in ids:
        r = found.get(fid)
        if r is None:
            continue
        _, hidden, place_id = r
        place = None
        if place_id is not None and not hidden:
            if place_id not in named:
                try:
                    p = await places.describe(db, place_id)
                except Exception:  # noqa: BLE001 — a nicety; never fail the composer
                    core.logger.warning("porch: place lookup failed", exc_info=True)
                    p = None
                named[place_id] = None if p is None else {"name": p.name, "address": p.label, "lat": round(p.lat, 4), "lon": round(p.lon, 4)}
            place = named[place_id]
        out.append({"file_id": str(fid), "caption": captions.get(fid) or None, "place": place})
    return {"files": out}


__all__ = ["router"]
