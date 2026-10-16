"""The media pipeline (WP-7.4, Part C §4.5): one job per photo or video on
the dedicated ``promptly:media`` queue — metadata (WP-7.3), then renditions.

The ``file_media`` row is the source of truth: ``derivative_state`` goes
pending → processing → ready | failed (| skipped). The media worker's sweep
(every 20 minutes) re-queues rows stuck in ``processing`` (a worker that
died mid-job), retries ``failed`` ones a couple of times, and picks up
anything never queued — so when Redis is down at upload time nothing runs
in the API process: the row just waits for the sweep.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger("promptly.files.media_pipeline")

STUCK_AFTER = timedelta(minutes=45)
MAX_ATTEMPTS = 3
SWEEP_BATCH = 500

# One video at a time per worker process, whatever max_jobs allows — a
# transcode takes every core it gets.
_VIDEO_SLOT = asyncio.Semaphore(1)


async def ingest(file_id: uuid.UUID | str, *, force: bool = False) -> str:
    """Metadata + renditions for one file. Returns the derivative state."""
    import app.auth.models  # noqa: F401 — FK target, for a bare worker process
    from app.database import SessionLocal
    from app.files import derivatives
    from app.files.media_meta import extract_and_store
    from app.files.models import FileMedia, UserFile
    from app.files.storage import absolute_path

    fid = uuid.UUID(str(file_id))
    if not await extract_and_store(fid):
        return "skipped"
    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        media = await db.get(FileMedia, fid)
        if row is None or media is None:
            return "skipped"
        if media.derivative_state == "ready" and media.renditions and not force:
            return "ready"
        media.derivative_state = "processing"
        media.processing_started_at = datetime.now(timezone.utc)
        media.attempts = (media.attempts or 0) + 1
        kind = media.kind
        motion = bool(media.motion_embedded)
        path = absolute_path(row.storage_path)
        await db.commit()

    async def work() -> tuple[dict[str, Any], str | None]:
        return await asyncio.to_thread(derivatives.make_renditions, path, fid, kind, motion=motion)

    try:
        if kind == "video":
            async with _VIDEO_SLOT:
                renditions, thumbhash = await work()
        else:
            renditions, thumbhash = await work()
        state, error = "ready", None
    except Exception as exc:  # noqa: BLE001 — recorded on the row; the sweep retries
        logger.warning("renditions for %s failed", fid, exc_info=True)
        renditions, thumbhash, state, error = None, None, "failed", str(exc)[:1000]
    async with SessionLocal() as db:
        media = await db.get(FileMedia, fid)
        if media is None:
            return state
        media.derivative_state = state
        media.processing_started_at = None
        if renditions is not None:
            media.renditions = renditions
            media.thumbhash = thumbhash
            media.derived_bytes = sum(int(v.get("bytes", 0)) for v in renditions.values())
            media.error = None
        else:
            media.error = error
        await db.commit()
    if renditions is not None and kind != "video":
        # Made again: an edited photo's edited renditions too (PH-7).
        try:
            async with SessionLocal() as db:
                from sqlalchemy import text

                from app.photos import edits

                if await db.scalar(text("SELECT 1 FROM photo_edits WHERE file_id = :f"), {"f": fid}):
                    await edits.apply_to_renditions(db, fid)
                    await db.commit()
        except Exception:  # noqa: BLE001 — the original's renditions stand
            logger.warning("edited renditions for %s failed", fid, exc_info=True)
    return state


async def sweep() -> dict[str, int]:
    """Re-queue what needs it (the media worker's cron)."""
    from sqlalchemy import or_, select, text, update

    from app.database import SessionLocal
    from app.files.models import FileMedia
    from app.tasks.queue import enqueue_media

    now = datetime.now(timezone.utc)
    out = {"stuck": 0, "retried": 0, "new": 0}
    async with SessionLocal() as db:
        stuck = (
            await db.execute(
                update(FileMedia)
                .where(FileMedia.derivative_state == "processing", FileMedia.processing_started_at < now - STUCK_AFTER)
                .values(derivative_state="pending", processing_started_at=None)
                .returning(FileMedia.file_id)
            )
        ).scalars().all()
        out["stuck"] = len(stuck)
        due = (
            await db.execute(
                select(FileMedia.file_id)
                .where(
                    or_(
                        FileMedia.derivative_state == "pending",
                        (FileMedia.derivative_state == "failed") & (FileMedia.attempts < MAX_ATTEMPTS),
                    )
                )
                .limit(SWEEP_BATCH)
            )
        ).scalars().all()
        out["retried"] = len(due)
        # Photos and videos with no row at all (stored before WP-7.3, or
        # uploaded while the queue was down).
        new = (
            await db.execute(
                text(
                    "SELECT f.id FROM files AS f LEFT JOIN file_media AS m ON m.file_id = f.id "
                    "WHERE m.file_id IS NULL AND f.blob_state = 'ready' AND f.trashed_at IS NULL "
                    "AND (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%') "
                    "AND f.mime_type <> 'image/svg+xml' ORDER BY f.created_at DESC LIMIT :n"
                ),
                {"n": SWEEP_BATCH},
            )
        ).scalars().all()
        out["new"] = len(new)
        await db.commit()
    for fid in {*stuck, *due, *new}:
        await enqueue_media(fid)
    return out


async def queue_status(db) -> dict[str, Any]:  # noqa: ANN001
    from sqlalchemy import func, select

    from app.files.models import FileMedia

    rows = (await db.execute(select(FileMedia.derivative_state, func.count(), func.coalesce(func.sum(FileMedia.derived_bytes), 0)).group_by(FileMedia.derivative_state))).all()
    counts = {state: int(n) for state, n, _b in rows}
    return {"counts": counts, "derived_bytes": int(sum(b for _s, _n, b in rows))}


__all__ = ["ingest", "queue_status", "sweep"]
