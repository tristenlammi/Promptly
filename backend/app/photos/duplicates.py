"""A photo you already have, arriving again (a phone synced after a Google
Takeout): it's hidden as a copy instead of shown twice.

A new photo is a copy of one already in your Photos library when it's:

* the same file (``content_sha256``), or
* an image taken at the same instant (:func:`same_moment`) that looks the
  same — their perceptual hashes (``photo_assets.phash``) at most
  :data:`BITS` of 64 bits apart. Google's copy and the phone's original are
  often not byte-identical (metadata rewritten, "Storage saver"
  re-compressed), but they're the same moment and the same picture. Frames
  of a burst are not: each has its own instant (a Pixel shoots several a
  second, and writes the fraction of a second it took each).

The one that came later is the copy (``duplicate_of`` → the original): it
leaves Photos — the timeline, search, background work — but its file stays
where the phone put it, so the phone counts it as sent and doesn't send it
again. The original keeps its albums, people and descriptions. "Not a copy"
(Clean up) undoes it for good; deleting the original brings the copy back.
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

SECONDS = 1.0
BITS = 6
KEPT_REASON = "copy"  # photo_cleanup_kept: "not a copy", so never hidden again
SUBSEC_SLACK_US = 1000  # copies keep the same sub-second, to the millisecond
COLOUR_SLACK = 0.1  # average colour (ThumbHash L/P/Q) apart, at most
MONO = 0.04  # |P| and |Q| under this: black and white


def look(thumbhash: str | None) -> tuple[float, float, float] | None:
    """A photo's average colour (L, P, Q), from its ThumbHash header — or
    None when it hasn't one yet."""
    if not thumbhash:
        return None
    try:
        b = base64.b64decode(thumbhash)
        h = b[0] | (b[1] << 8) | (b[2] << 16)
    except (ValueError, IndexError):
        return None
    return (h & 63) / 63, ((h >> 6) & 63) / 31.5 - 1, ((h >> 12) & 63) / 31.5 - 1


def looks_alike(a: str | None, b: str | None, *, mono_ok: bool = False) -> bool:
    """Whether two near-equal pHashes can be trusted. A pHash sees only light
    and dark shapes — every plain or near-plain picture gets about the same
    one, whatever its colour — so they need the same average colour too
    (with ``mono_ok``, one may be a black-and-white version of the other).
    Without a ThumbHash to go on, the pHash alone decides."""
    la, lb = look(a), look(b)
    if la is None or lb is None:
        return True
    if abs(la[0] - lb[0]) > COLOUR_SLACK:
        return mono_ok and (_mono(la) or _mono(lb))
    if abs(la[1] - lb[1]) <= COLOUR_SLACK and abs(la[2] - lb[2]) <= COLOUR_SLACK:
        return True
    return mono_ok and (_mono(la) or _mono(lb))


def _mono(x: tuple[float, float, float]) -> bool:
    return abs(x[1]) <= MONO and abs(x[2]) <= MONO


def same_moment(a: datetime, b: datetime) -> bool:
    """Two capture times of the same shot, rather than two shots.

    Within :data:`SECONDS` — one copy may have lost the fraction of a second
    (or be stamped from whole-second Takeout metadata) — but when both keep
    a fraction, it must match: a burst's frames share the second, never the
    millisecond."""
    if abs((a - b).total_seconds()) >= SECONDS:
        return False
    if a.microsecond and b.microsecond:
        return abs(a.microsecond - b.microsecond) <= SUBSEC_SLACK_US
    return True


async def original_of(db: AsyncSession, asset: Any) -> uuid.UUID | None:
    """The photo already in the library that ``asset`` is a copy of, if any."""
    from app.files.models import FileMedia, UserFile
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
        select(PhotoAsset.file_id, PhotoAsset.phash, PhotoAsset.taken_at, UserFile.content_sha256, FileMedia.thumbhash)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
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
    mine_th = await db.scalar(select(FileMedia.thumbhash).where(FileMedia.file_id == asset.file_id))
    near = (
        await db.execute(
            earlier.where(
                PhotoAsset.kind == "image",
                PhotoAsset.phash.is_not(None),
                func.abs(func.extract("epoch", PhotoAsset.taken_at - asset.taken_at)) <= SECONDS,
            )
        )
    ).all()
    best = min(
        (
            (hamming(r.phash, asset.phash), r.file_id)
            for r in near
            if same_moment(r.taken_at, asset.taken_at) and looks_alike(r.thumbhash, mine_th)
        ),
        default=None,
    )
    return best[1] if best is not None and best[0] <= BITS else None


async def hide_if_copy(db: AsyncSession, asset: Any) -> bool:
    """Mark ``asset`` a copy when it is one. True if it was."""
    original = await original_of(db, asset)
    if original is None:
        return False
    asset.duplicate_of = original
    return True


__all__ = ["BITS", "KEPT_REASON", "SECONDS", "hide_if_copy", "original_of"]
