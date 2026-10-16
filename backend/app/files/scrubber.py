"""The integrity scrubber (WP-7.2, Part C §5.4 — the Immich model).

Nightly, on the worker:

1. **stat pass** — every canonical blob (:func:`app.files.blobstore.is_canonical`)
   is looked at: gone → ``missing``; a different size from the row →
   ``damaged``; back where it should be after a restore → ``ready`` again
   (and re-hashed below);
2. **verify pass** — sha256 re-checked against ``content_sha256`` under a
   time budget (``SCRUB_BUDGET_MINUTES``, 20 by default), oldest
   ``verified_at`` first, so the whole library is covered over successive
   nights; a mismatch → ``damaged``;
3. **orphan walk** (Sundays) — blobs in the user buckets that no row points
   at are moved to ``.quarantine/`` (same relative path) — never deleted
   automatically; an admin looks, then empties it.

Each run is a ``storage_checks`` row. A file newly found missing or damaged
alerts the admins, shows on Admin → Storage, and puts a "restore from a
backup" banner on the file.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import blobstore, storage

logger = logging.getLogger("promptly.files.scrubber")

QUARANTINE_DIR = ".quarantine"
_BATCH = 500


def _budget_seconds() -> float:
    try:
        return max(float(os.environ.get("SCRUB_BUDGET_MINUTES", "20")), 0.0) * 60
    except ValueError:
        return 20 * 60.0


async def stat_pass(db: AsyncSession, check) -> list[Any]:  # noqa: ANN001 — StorageCheck
    """Missing / wrong-size blobs (and recovered ones). Returns the rows
    that newly went bad."""
    import app.auth.models  # noqa: F401 — FK target, for a bare worker process
    from app.files.models import UserFile

    newly_bad: list[Any] = []
    last = None
    while True:
        q = select(UserFile).where(text(blobstore.canonical_sql("files"))).order_by(UserFile.id).limit(_BATCH)
        if last is not None:
            q = q.where(UserFile.id > last)
        rows = (await db.execute(q)).scalars().all()
        if not rows:
            break
        last = rows[-1].id
        for row in rows:
            check.checked += 1
            info = await asyncio.to_thread(blobstore.blobstore.stat, row.storage_path)
            if info is None:
                state = blobstore.MISSING
            elif info.size != row.size_bytes:
                state = blobstore.DAMAGED
            elif row.blob_state == blobstore.MISSING:
                # It's back (restored from a backup): ready, and re-verified
                # by the hash pass straight away.
                state = blobstore.READY
                row.verified_at = None
                check.recovered += 1
            else:
                state = row.blob_state if row.blob_state != blobstore.INGESTING else blobstore.READY
            if state != row.blob_state:
                if state in (blobstore.MISSING, blobstore.DAMAGED):
                    newly_bad.append(row)
                row.blob_state = state
            if state == blobstore.MISSING:
                check.missing += 1
            elif state == blobstore.DAMAGED:
                check.damaged += 1
        await db.commit()
    return newly_bad


async def verify_pass(db: AsyncSession, check, budget_seconds: float) -> list[Any]:  # noqa: ANN001
    """Re-hash, oldest-verified first, until the budget runs out. Returns
    the rows that turned out damaged."""
    from app.files.models import UserFile

    started = time.monotonic()
    damaged: list[Any] = []
    seen: set = set()
    while time.monotonic() - started < budget_seconds:
        q = (
            select(UserFile)
            .where(
                text(blobstore.canonical_sql("files")),
                UserFile.content_sha256.is_not(None),
                UserFile.blob_state == blobstore.READY,
            )
            .order_by(UserFile.verified_at.asc().nullsfirst(), UserFile.id)
            .limit(50)
        )
        rows = [r for r in (await db.execute(q)).scalars().all() if r.id not in seen]
        if not rows:
            break
        for row in rows:
            if time.monotonic() - started >= budget_seconds:
                break
            seen.add(row.id)
            try:
                sha256, _sha1, size = await asyncio.to_thread(blobstore.blobstore.hash_file, row.storage_path)
            except (OSError, ValueError):
                row.blob_state = blobstore.MISSING
                check.missing += 1
                damaged.append(row)
                continue
            check.verified += 1
            check.bytes_verified += size
            if sha256 != row.content_sha256:
                row.blob_state = blobstore.DAMAGED
                check.damaged += 1
                damaged.append(row)
            else:
                row.verified_at = datetime.now(timezone.utc)
        await db.commit()
    return damaged


def _quarantine(rel: str) -> int:
    src = storage.absolute_path(rel)
    dest = (storage.UPLOAD_ROOT / QUARANTINE_DIR / rel).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    size = src.stat().st_size
    shutil.move(str(src), str(dest))
    return size


async def orphan_walk(db: AsyncSession, check) -> int:  # noqa: ANN001
    """Move blobs no row references into ``.quarantine/``. Returns how many."""
    from app.files.tombstones import ORPHAN_MIN_AGE_SECONDS, _bucket_blobs, _referenced_paths, _stale_thumbs
    from app.files.models import BlobTombstone, UserFile

    candidates = await asyncio.to_thread(_bucket_blobs, ORPHAN_MIN_AGE_SECONDS)
    if not candidates:
        return 0
    keep = await _referenced_paths(db, candidates)
    # Already waiting to be deleted (a purge): that's not an orphan.
    for i in range(0, len(candidates), 500):
        chunk = candidates[i : i + 500]
        keep.update(
            (await db.execute(select(BlobTombstone.storage_path).where(BlobTombstone.storage_path.in_(chunk))))
            .scalars()
            .all()
        )
    moved = 0
    for rel in candidates:
        if rel in keep:
            continue
        try:
            await asyncio.to_thread(_quarantine, rel)
            moved += 1
        except (OSError, ValueError):
            logger.warning("couldn't quarantine %s", rel, exc_info=True)
    live = {str(i) for i in (await db.execute(select(UserFile.id))).scalars().all()}
    await asyncio.to_thread(_stale_thumbs, live)
    await asyncio.to_thread(_stale_derived, live)
    check.quarantined = moved
    if moved:
        logger.warning("scrubber: moved %d unreferenced blob(s) to %s", moved, QUARANTINE_DIR)
    return moved


def _stale_derived(live_ids: set[str]) -> int:
    """Renditions (``derived/<file_id>/``, WP-7.4) of files that are gone.
    Regenerable, so removed outright."""
    root = storage.UPLOAD_ROOT / "derived"
    removed = 0
    try:
        entries = list(root.iterdir())
    except OSError:
        return 0
    for p in entries:
        if p.is_dir() and len(p.name) == 36 and p.name not in live_ids:
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
    return removed


def quarantine_summary() -> dict[str, Any]:
    root = storage.UPLOAD_ROOT / QUARANTINE_DIR
    count = size = 0
    oldest: float | None = None
    items: list[dict[str, Any]] = []
    if root.is_dir():
        for dirpath, _dirs, names in os.walk(root):
            for n in names:
                p = Path(dirpath, n)
                try:
                    st = p.stat()
                except OSError:
                    continue
                count += 1
                size += st.st_size
                oldest = st.st_mtime if oldest is None else min(oldest, st.st_mtime)
                if len(items) < 50:
                    items.append({"path": p.relative_to(root).as_posix(), "size": st.st_size})
    return {
        "count": count,
        "bytes": size,
        "oldest": datetime.fromtimestamp(oldest, timezone.utc).isoformat() if oldest else None,
        "items": items,
    }


def empty_quarantine() -> int:
    root = storage.UPLOAD_ROOT / QUARANTINE_DIR
    n = sum(len(names) for _d, _s, names in os.walk(root)) if root.is_dir() else 0
    if root.is_dir():
        shutil.rmtree(root, ignore_errors=True)
    return n


async def _alert(names_list: list[str]) -> None:
    if not names_list:
        return
    from app.files.disk_guard import _notify_admins

    n = len(names_list)
    names = ", ".join(f"“{name}”" for name in names_list[:3])
    more = f" and {n - 3} more" if n > 3 else ""
    await _notify_admins(
        f"{n} file{'s' if n != 1 else ''} failed the storage check",
        f"{names}{more} {'is' if n == 1 else 'are'} missing or no longer match what was stored. "
        "Restore them from a backup — Admin → Storage lists them.",
    )


async def run_check(*, trigger: str = "nightly", orphans: bool | None = None, budget_seconds: float | None = None) -> dict[str, Any]:
    """One scrubber run in its own session — the nightly cron and "Check
    now". Sundays (or ``orphans=True``) include the orphan walk."""
    from app.database import SessionLocal
    from app.files.models import StorageCheck

    if orphans is None:
        orphans = datetime.now(timezone.utc).weekday() == 6
    budget = _budget_seconds() if budget_seconds is None else budget_seconds
    async with SessionLocal() as db:
        check = StorageCheck(trigger=trigger, status="running", checked=0, verified=0, bytes_verified=0,
                             missing=0, damaged=0, recovered=0, quarantined=0)
        db.add(check)
        await db.commit()
        bad: list[Any] = []
        try:
            bad += await stat_pass(db, check)
            bad += await verify_pass(db, check, budget)
            if orphans:
                await orphan_walk(db, check)
            check.status = "problems" if (check.missing or check.damaged) else "ok"
        except Exception as exc:  # noqa: BLE001 — record it, then alert below
            logger.exception("storage check failed")
            await db.rollback()
            check.status = "failed"
            check.error = str(exc)[:2000]
        check.finished_at = datetime.now(timezone.utc)
        db.add(check)
        await db.commit()
        unique: dict = {}
        for r in bad:
            unique.setdefault(r.id, r.filename)
        names = list(unique.values())
        out = {
            "id": str(check.id), "status": check.status, "checked": check.checked, "verified": check.verified,
            "missing": check.missing, "damaged": check.damaged, "recovered": check.recovered,
            "quarantined": check.quarantined,
        }
    await _alert(names)
    return out


async def recheck_file(db: AsyncSession, row) -> str:  # noqa: ANN001 — UserFile
    """An admin's "Check again" after putting a file back: stat + hash now.
    A row without a hash (never recorded) is hashed fresh."""
    info = await asyncio.to_thread(blobstore.blobstore.stat, row.storage_path)
    if info is None:
        row.blob_state = blobstore.MISSING
    else:
        sha256, sha1, md5, size = await asyncio.to_thread(blobstore.blobstore.hashes, row.storage_path)
        if row.content_sha256 and sha256 != row.content_sha256:
            row.blob_state = blobstore.DAMAGED
        elif size != row.size_bytes and row.content_sha256:
            row.blob_state = blobstore.DAMAGED
        else:
            row.content_sha256 = row.content_sha256 or sha256
            row.sha1 = row.sha1 or sha1
            row.md5 = row.md5 or md5
            row.blob_state = blobstore.READY
            row.verified_at = datetime.now(timezone.utc)
    await db.commit()
    return row.blob_state


__all__ = [
    "QUARANTINE_DIR",
    "empty_quarantine",
    "orphan_walk",
    "quarantine_summary",
    "recheck_file",
    "run_check",
    "stat_pass",
    "verify_pass",
]
