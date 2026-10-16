"""Arq job queue for scheduled-automation runs (durable execution).

Runs used to execute inline in the API process (``asyncio.create_task``), so an
API redeploy killed anything in flight. They're now enqueued onto Arq and
executed by a separate ``arq-worker`` container — the worker survives API
redeploys, and if the worker is momentarily down the job simply waits in Redis
and runs when it comes back.

Degrades gracefully: if the queue itself is unreachable (Redis down, or in a
test/CLI context with no Redis), we fall back to inline execution so a run is
never silently dropped.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

from arq import create_pool
from arq.connections import RedisSettings

from app.background import spawn
from app.config import get_settings

logger = logging.getLogger("promptly.tasks.queue")

# The Arq function names the worker registers (see app/tasks/worker.py).
RUN_TASK = "execute_task_run"
RUN_MEETING = "execute_meeting_job"
OFFICE_TEXT = "extract_office_text_job"
OFFICE_CONVERT = "convert_office_job"
DOC_THUMB = "doc_thumbnail_job"
RENDER_PDF = "render_pdf_job"
# The media worker's queue and job (WP-7.4): metadata + renditions.
MEDIA_QUEUE = "promptly:media"
MEDIA_INGEST = "ingest_media_job"
BUILD_ZIP = "build_zip_job"
INDEX_IMPORT = "index_import_job"
RUN_IMPORT = "run_import_job"

_pool = None
_lock = asyncio.Lock()


async def _get_pool():
    global _pool
    if _pool is None:
        async with _lock:
            if _pool is None:
                _pool = await create_pool(
                    RedisSettings.from_dsn(get_settings().REDIS_URL)
                )
    return _pool


# For callers that wait on a job's result (a Doc's PDF, WP-6.4).
get_pool = _get_pool


async def enqueue_run(run_id: uuid.UUID, *, defer_by: float | None = None) -> None:
    """Enqueue a :class:`TaskRun` for the worker to execute (``defer_by``
    seconds from now, when given).

    Falls back to inline execution (non-durable, but never dropped) if the
    queue can't be reached."""
    try:
        pool = await _get_pool()
        if defer_by:
            from datetime import timedelta

            # A distinct job id: arq won't enqueue a second job under the
            # id of one it already knows about.
            await pool.enqueue_job(
                RUN_TASK,
                str(run_id),
                _defer_by=timedelta(seconds=defer_by),
                _job_id=f"{run_id}:{uuid.uuid4().hex[:8]}",
            )
        else:
            await pool.enqueue_job(RUN_TASK, str(run_id))
        return
    except Exception:  # noqa: BLE001 — never let queueing break the request
        logger.warning(
            "enqueue_run: queue unavailable, executing inline", exc_info=True
        )
    # Best-effort inline fallback (honouring the deferral, so a re-queued
    # run doesn't spin).
    from app.tasks.runner import execute_run

    async def _later() -> None:
        if defer_by:
            await asyncio.sleep(defer_by)
        await execute_run(run_id)

    spawn(_later(), name=f"task_run_{run_id}")


async def enqueue_doc_thumbnail(file_id: uuid.UUID, version: str) -> None:
    """A Doc's first-page thumbnail, on the worker — once per version."""
    import hashlib

    pool = await _get_pool()
    tag = hashlib.sha1(version.encode()).hexdigest()[:10]
    await pool.enqueue_job(DOC_THUMB, str(file_id), _job_id=f"doc-thumb-{file_id}-{tag}")


async def enqueue_office_convert(file_id: uuid.UUID) -> None:
    """An Office file → its faithful PDF preview, on the worker (Stage 12)."""
    pool = await _get_pool()
    await pool.enqueue_job(OFFICE_CONVERT, str(file_id), _job_id=f"office-convert-{file_id}")


async def enqueue_office_text(file_id: uuid.UUID) -> None:
    """Read an uploaded Office file's text on the worker (WP-4.3). Falls back
    to a background thread here when the queue is down — search just
    catches up a little later."""
    try:
        pool = await _get_pool()
        await pool.enqueue_job(OFFICE_TEXT, str(file_id), _job_id=f"office-text-{file_id}")
        return
    except Exception:  # noqa: BLE001 — never let queueing break the upload
        logger.warning("enqueue_office_text: queue unavailable, reading inline", exc_info=True)
    from app.files.office_formats import extract_and_store

    spawn(extract_and_store(file_id), name=f"office_text_{file_id}")


async def enqueue_media(file_id: uuid.UUID) -> None:
    """Queue a photo or video for the media worker (WP-7.4): its metadata,
    thumbnails, preview, poster and web-playable video. Never runs here —
    with the queue down the file simply waits for the media worker's sweep
    (CPU-heavy media work must not land on the API's one worker)."""
    try:
        pool = await _get_pool()
        await pool.enqueue_job(MEDIA_INGEST, str(file_id), _queue_name=MEDIA_QUEUE, _job_id=f"media-{file_id}")
    except Exception:  # noqa: BLE001 — never let queueing break the upload
        logger.warning("enqueue_media: queue unavailable; the media sweep will pick %s up", file_id, exc_info=True)


async def enqueue_zip(job_id: str) -> None:
    """Build a zip download on the worker (WP-7.6). If the queue is down it
    is built here — the writing runs in a thread, so the API stays
    responsive."""
    try:
        pool = await _get_pool()
        await pool.enqueue_job(BUILD_ZIP, job_id, _job_id=f"zip-{job_id}")
        return
    except Exception:  # noqa: BLE001
        logger.warning("enqueue_zip: queue unavailable, building inline", exc_info=True)
    from app.files.zip_jobs import build

    spawn(build(job_id), name=f"zip_{job_id}")


async def enqueue_meeting(job_id: uuid.UUID) -> None:
    """Enqueue a meeting-notes job (chunked transcription + summarise).

    Same durability story as :func:`enqueue_run`: prefer the worker, fall
    back to inline execution so an upload is never silently dropped."""
    try:
        pool = await _get_pool()
        await pool.enqueue_job(RUN_MEETING, str(job_id))
        return
    except Exception:  # noqa: BLE001 — never let queueing break the request
        logger.warning(
            "enqueue_meeting: queue unavailable, executing inline", exc_info=True
        )
    from app.workspaces.meetings_runner import execute_meeting

    spawn(execute_meeting(job_id), name=f"meeting_job_{job_id}")


__all__ = ["enqueue_run", "enqueue_meeting", "RUN_TASK", "RUN_MEETING"]
