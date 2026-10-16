"""Deferred blob deletion — the 14-day safety net under every permanent delete.

Callers that hard-delete file rows call :func:`tombstone` for each blob in
the *same* transaction instead of unlinking it. :func:`sweep_due` (run daily
by the arq worker) unlinks a tombstoned blob once its window has passed, and
only after re-checking that no row points at the path any more.

Two properties this buys:

* **Recoverable.** For 14 days a mistaken "Delete forever", Empty trash or
  user deletion still has its bytes on disk; restoring the nightly database
  dump brings the rows back and they open again.
* **Crash-safe.** The row delete and the tombstone commit together, so a
  process dying half-way leaves either both or neither — never a row whose
  blob is gone, never a blob nobody will clean up.

Upload-failure cleanups (bytes written a moment ago, never committed as a
row) still unlink directly — nothing there is anyone's data yet.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import BlobTombstone, UserFile
from app.files import storage
from app.files.storage import absolute_path

logger = logging.getLogger("promptly.files.tombstones")

RETENTION_DAYS = 14


def tombstone(
    db: AsyncSession,
    storage_path: str | None,
    *,
    reason: str,
    size_bytes: int = 0,
    user_id: uuid.UUID | None = None,
    is_dir: bool = False,
) -> None:
    """Schedule ``storage_path`` for deletion in :data:`RETENTION_DAYS`.

    Adds to ``db`` without committing — the caller commits it together with
    the row delete it belongs to.
    """
    if not storage_path:
        return
    db.add(
        BlobTombstone(
            storage_path=storage_path,
            size_bytes=max(0, int(size_bytes or 0)),
            user_id=user_id,
            reason=reason[:32],
            is_dir=is_dir,
            purge_after=datetime.now(timezone.utc) + timedelta(days=RETENTION_DAYS),
        )
    )


def tombstone_files(db: AsyncSession, rows, *, reason: str) -> None:
    """:func:`tombstone` every ``UserFile`` in ``rows``."""
    for r in rows:
        tombstone(
            db, r.storage_path, reason=reason, size_bytes=r.size_bytes, user_id=r.user_id
        )


async def _referenced_paths(db: AsyncSession, paths: list[str]) -> set[str]:
    """Which of ``paths`` some row still points at (they must survive)."""
    from app.workspaces.meetings_models import MeetingJob
    from app.files.models import FileVersion

    if not paths:
        return set()
    found: set[str] = set()
    for i in range(0, len(paths), 500):
        chunk = paths[i : i + 500]
        found.update(
            (await db.execute(select(UserFile.storage_path).where(UserFile.storage_path.in_(chunk))))
            .scalars()
            .all()
        )
        found.update(
            (await db.execute(select(MeetingJob.audio_path).where(MeetingJob.audio_path.in_(chunk))))
            .scalars()
            .all()
        )
        # A PDF's earlier versions (WP-6.5).
        found.update(
            (await db.execute(select(FileVersion.storage_path).where(FileVersion.storage_path.in_(chunk))))
            .scalars()
            .all()
        )
    return found


def _files_under(rel_dir: str) -> list[str]:
    try:
        root = absolute_path(rel_dir)
    except ValueError:
        return []
    if not root.is_dir():
        return []
    out: list[str] = []
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            out.append(Path(dirpath, n).relative_to(storage.UPLOAD_ROOT).as_posix())
    return out


def _unlink(rel: str) -> int:
    try:
        p = absolute_path(rel)
    except ValueError:
        return 0
    try:
        size = p.stat().st_size
        p.unlink()
        return size
    except FileNotFoundError:
        return 0
    except OSError:
        logger.warning("tombstone sweep: could not unlink %s", rel, exc_info=True)
        return 0


def _prune_empty_dirs(rel_dir: str) -> None:
    try:
        root = absolute_path(rel_dir)
    except ValueError:
        return
    for dirpath, _dirs, _names in sorted(os.walk(root), key=lambda t: -len(t[0])):
        try:
            os.rmdir(dirpath)  # only succeeds when empty
        except OSError:
            pass


async def sweep_due(db: AsyncSession, *, now: datetime | None = None) -> tuple[int, int]:
    """Unlink every tombstoned blob past its window. Returns (blobs, bytes).

    A path some row references again is kept and its tombstone dropped —
    the sweep never deletes bytes a live row needs.
    """
    now = now or datetime.now(timezone.utc)
    due = (
        (await db.execute(select(BlobTombstone).where(BlobTombstone.purge_after <= now)))
        .scalars()
        .all()
    )
    removed = 0
    freed = 0
    for t in due:
        if t.is_dir:
            candidates = await run_in_threadpool(_files_under, t.storage_path)
        else:
            candidates = [t.storage_path]
        keep = await _referenced_paths(db, candidates)
        for rel in candidates:
            if rel in keep:
                continue
            size = await run_in_threadpool(_unlink, rel)
            removed += 1
            freed += size
        if t.is_dir:
            await run_in_threadpool(_prune_empty_dirs, t.storage_path)
        await db.delete(t)
        await db.commit()
    if removed:
        logger.info("tombstone sweep: unlinked %d blob(s), %d bytes", removed, freed)
    return removed, freed


# Blobs this young may belong to an upload still writing its row.
ORPHAN_MIN_AGE_SECONDS = 3600


def _bucket_blobs(min_age: float) -> list[str]:
    """Every file in the per-user buckets (``u_<id>/``, ``shared/``) older
    than ``min_age`` seconds — the candidates for the orphan sweep."""
    import time

    root = storage.UPLOAD_ROOT
    cutoff = time.time() - min_age
    out: list[str] = []
    try:
        buckets = [p for p in root.iterdir() if p.is_dir() and (p.name.startswith("u_") or p.name == "shared")]
    except OSError:
        return out
    for b in buckets:
        for dirpath, _dirs, names in os.walk(b):
            for n in names:
                p = Path(dirpath, n)
                try:
                    if p.stat().st_mtime > cutoff:
                        continue
                except OSError:
                    continue
                out.append(p.relative_to(root).as_posix())
    return out


def _stale_thumbs(live_ids: set[str]) -> int:
    """Remove cached thumbnails (``derived/thumbs/<id>-…``) of files that are
    gone. They're regenerable, so this unlinks directly."""
    d = storage.UPLOAD_ROOT / "derived" / "thumbs"
    removed = 0
    try:
        entries = list(d.iterdir())
    except OSError:
        return 0
    for p in entries:
        if p.name[:36] not in live_ids:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


async def pending_summary(db: AsyncSession) -> tuple[int, int]:
    """(tombstones waiting, bytes they hold) — for the admin Backups card."""
    count, total = (
        await db.execute(
            select(func.count(BlobTombstone.id), func.coalesce(func.sum(BlobTombstone.size_bytes), 0))
        )
    ).one()
    return int(count), int(total)


__all__ = [
    "RETENTION_DAYS",
    "pending_summary",
    "sweep_due",
    "tombstone",
    "tombstone_files",
]
