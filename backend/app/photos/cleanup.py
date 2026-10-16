"""Cleanup (PH-7, Part E §E5): what in your library you may not want —
duplicates, blurry shots, screenshots, large videos — to review and move to
the trash (recoverable, like any delete).

- **Duplicates** — the same bytes (``content_sha256``), the same picture
  saved again (pHash ≤ ``COPY_BITS`` apart, anywhere in the library — found
  through four 16-bit bands, one of which a copy must share), or a burst
  (≤ ``BURST_BITS`` apart within ``BURST_SECONDS``). A group keeps one:
  a favourite, else the best quality, then the most pixels, then the oldest.
- **Blurry** — sharpness under ``BLURRY`` (a favourite never).
- **Screenshots** — a PNG with no camera, or named like one.
- **Large videos** — ``LARGE_VIDEO`` bytes or more, biggest first.

"Keep" on a suggestion is remembered per reason (``photo_cleanup_kept``).
Nothing here deletes: the page moves what you chose to the trash.
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

COPY_BITS = 3
BURST_BITS = 6
BURST_SECONDS = 600
BLURRY = 0.35
LARGE_VIDEO = 100 * 1024 * 1024
MAX_GROUPS = 200
MAX_ITEMS = 500
REASONS = ("duplicate", "blurry", "screenshot", "large_video")

_SCREENSHOT_NAME = re.compile(r"^(screenshot|screen shot|screen_shot|scrnshot|captura de pantalla|bildschirmfoto)", re.I)


@dataclass
class Row:
    file_id: uuid.UUID
    phash: int | None
    sharpness: float | None
    quality: float | None
    taken_at: datetime
    size: int
    sha: str | None
    kind: str
    mime: str
    make: str | None
    filename: str
    pixels: int
    favourite: bool


async def _rows(db: AsyncSession, user_id: uuid.UUID) -> list[Row]:
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    got = (
        await db.execute(
            select(
                PhotoAsset.file_id, PhotoAsset.phash, PhotoAsset.sharpness, PhotoAsset.quality, PhotoAsset.taken_at,
                PhotoAsset.kind, UserFile.size_bytes, UserFile.content_sha256, UserFile.mime_type, UserFile.filename,
                UserFile.starred_at, FileMedia.make, FileMedia.width, FileMedia.height,
            )
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(and_(in_library(user_id)))
            .order_by(PhotoAsset.taken_at)
        )
    ).all()
    return [
        Row(r.file_id, r.phash, r.sharpness, r.quality, r.taken_at, int(r.size_bytes or 0), r.content_sha256, r.kind,
            r.mime_type or "", r.make, r.filename or "", int((r.width or 0) * (r.height or 0)), r.starred_at is not None)
        for r in got
    ]


def _bands(ph: int) -> list[tuple[int, int]]:
    u = ph & ((1 << 64) - 1)
    return [(i, (u >> (16 * i)) & 0xFFFF) for i in range(4)]


def duplicate_groups(rows: list[Row]) -> list[list[Row]]:
    """Groups of two or more that are the same photo (best first)."""
    from app.photos.quality import hamming

    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def join(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_sha: dict[str, int] = {}
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        if r.sha:
            if r.sha in by_sha:
                join(by_sha[r.sha], i)
            else:
                by_sha[r.sha] = i
        if r.phash is not None and r.kind == "image":
            for band in _bands(r.phash):
                buckets[band].append(i)
    # A copy anywhere: shares a band, and is only a few bits away.
    for members in buckets.values():
        if len(members) < 2 or len(members) > 200:  # a flat band (blank frames) says nothing
            continue
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                a, b = rows[members[x]], rows[members[y]]
                if hamming(a.phash, b.phash) <= COPY_BITS:  # type: ignore[arg-type]
                    join(members[x], members[y])
    # A burst: close in time and close in look (rows are in time order).
    for i, r in enumerate(rows):
        if r.phash is None or r.kind != "image":
            continue
        j = i + 1
        while j < len(rows) and (rows[j].taken_at - r.taken_at).total_seconds() <= BURST_SECONDS:
            s = rows[j]
            if s.phash is not None and s.kind == "image" and hamming(r.phash, s.phash) <= BURST_BITS:
                join(i, j)
            j += 1

    groups: dict[int, list[Row]] = defaultdict(list)
    for i, r in enumerate(rows):
        groups[find(i)].append(r)
    out = [sorted(g, key=lambda r: (not r.favourite, -(r.quality or 0.0), -r.pixels, r.taken_at)) for g in groups.values() if len(g) > 1]
    out.sort(key=lambda g: -sum(r.size for r in g[1:]))
    return out


def is_screenshot(r: Row) -> bool:
    return (r.mime == "image/png" and not r.make) or bool(_SCREENSHOT_NAME.match(r.filename))


async def find(db: AsyncSession, user: Any) -> dict[str, Any]:
    """Every suggestion, by reason: ids (best first for a duplicate
    group), counts and the bytes moving them to the trash would free."""
    import asyncio

    rows = await _rows(db, user.id)
    kept: dict[str, set[uuid.UUID]] = defaultdict(set)
    for fid, reason in (await db.execute(
        text("SELECT file_id, reason FROM photo_cleanup_kept WHERE user_id = :u"), {"u": user.id}
    )).all():
        kept[reason].add(fid)
    # Seconds of pure Python on a big library: off the event loop.
    return await asyncio.to_thread(_suggest, rows, kept)


def _suggest(rows: list[Row], kept: dict[str, set[uuid.UUID]]) -> dict[str, Any]:
    groups = []
    for g in duplicate_groups(rows):
        extra = [r for r in g[1:] if r.file_id not in kept["duplicate"]]
        if extra:
            groups.append({"keep": g[0], "others": extra})
    blurry = [r for r in rows if r.kind == "image" and r.sharpness is not None and r.sharpness < BLURRY
              and not r.favourite and r.file_id not in kept["blurry"]]
    blurry.sort(key=lambda r: r.sharpness or 0.0)
    shots = [r for r in rows if r.kind == "image" and is_screenshot(r) and not r.favourite and r.file_id not in kept["screenshot"]]
    shots.sort(key=lambda r: r.taken_at, reverse=True)
    videos = [r for r in rows if r.kind == "video" and r.size >= LARGE_VIDEO and r.file_id not in kept["large_video"]]
    videos.sort(key=lambda r: -r.size)

    return {
        "duplicate": {
            "count": sum(len(g["others"]) for g in groups),
            "bytes": sum(r.size for g in groups for r in g["others"]),
            "groups": groups[:MAX_GROUPS],
        },
        "blurry": {"count": len(blurry), "bytes": sum(r.size for r in blurry), "items": blurry[:MAX_ITEMS]},
        "screenshot": {"count": len(shots), "bytes": sum(r.size for r in shots), "items": shots[:MAX_ITEMS]},
        "large_video": {"count": len(videos), "bytes": sum(r.size for r in videos), "items": videos[:MAX_ITEMS]},
    }


async def keep(db: AsyncSession, user_id: uuid.UUID, file_ids: list[uuid.UUID], reason: str) -> int:
    """Not suggested again for this reason. Not committed."""
    res = await db.execute(
        text(
            "INSERT INTO photo_cleanup_kept (user_id, file_id, reason) "
            "SELECT :u, f.id, :r FROM files f WHERE f.id = ANY(CAST(:ids AS uuid[])) AND f.user_id = :u "
            "ON CONFLICT DO NOTHING"
        ),
        {"u": user_id, "r": reason, "ids": [str(i) for i in file_ids]},
    )
    return res.rowcount or 0


__all__ = ["REASONS", "duplicate_groups", "find", "is_screenshot", "keep"]
