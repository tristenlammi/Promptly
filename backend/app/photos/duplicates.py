"""A photo you already have, arriving again (a phone synced after a Google
Takeout): it's hidden as a copy instead of shown twice.

A new photo is a copy of one already in your Photos library when it's:

* the same file (``content_sha256``), or
* an image taken within :data:`SECONDS` of it that looks the same — their
  perceptual hashes (``photo_assets.phash``) at most :data:`BITS` of 64
  bits apart. Google's copy and the phone's original are often not
  byte-identical (metadata rewritten, "Storage saver" re-compressed), but
  they're the same moment and the same picture.

The one that came later is the copy (``duplicate_of`` → the original): it
leaves Photos — the timeline, search, background work — but its file stays
where the phone put it, so the phone counts it as sent and doesn't send it
again. The original keeps its albums, people and descriptions. "Not a copy"
(Clean up) undoes it for good; deleting the original brings the copy back.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

SECONDS = 1.0
BITS = 6
KEPT_REASON = "copy"  # photo_cleanup_kept: "not a copy", so never hidden again


async def original_of(db: AsyncSession, asset: Any) -> uuid.UUID | None:
    """The photo already in the library that ``asset`` is a copy of, if any."""
    from app.files.models import UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset
    from app.photos.quality import hamming

    me = await db.get(UserFile, asset.file_id)
    if me is None:
        return None
    kept = await db.scalar(
        text("SELECT 1 FROM photo_cleanup_kept WHERE file_id = :f AND reason = :r"), {"f": asset.file_id, "r": KEPT_REASON}
    )
    if kept:
        return None
    earlier = (
        select(PhotoAsset.file_id, PhotoAsset.phash, UserFile.content_sha256)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .where(
            in_library(asset.user_id),
            PhotoAsset.duplicate_of.is_(None),
            PhotoAsset.file_id != asset.file_id,
            UserFile.created_at < me.created_at,
        )
    )
    # The same file.
    if me.content_sha256:
        same = (await db.execute(earlier.where(UserFile.content_sha256 == me.content_sha256).limit(1))).first()
        if same is not None:
            return same.file_id
    # The same moment, the same picture.
    if asset.kind != "image" or asset.phash is None:
        return None
    near = (
        await db.execute(
            earlier.where(
                PhotoAsset.kind == "image",
                PhotoAsset.phash.is_not(None),
                func.abs(func.extract("epoch", PhotoAsset.taken_at - asset.taken_at)) <= SECONDS,
            )
        )
    ).all()
    best = min(((hamming(r.phash, asset.phash), r.file_id) for r in near), default=None)
    return best[1] if best is not None and best[0] <= BITS else None


async def hide_if_copy(db: AsyncSession, asset: Any) -> bool:
    """Mark ``asset`` a copy when it is one. True if it was."""
    original = await original_of(db, asset)
    if original is None:
        return False
    asset.duplicate_of = original
    return True


__all__ = ["BITS", "KEPT_REASON", "SECONDS", "hide_if_copy", "original_of"]
