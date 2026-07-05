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

from app.config import get_settings

logger = logging.getLogger("promptly.tasks.queue")

# The Arq function names the worker registers (see app/tasks/worker.py).
RUN_TASK = "execute_task_run"
RUN_MEETING = "execute_meeting_job"

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


async def enqueue_run(run_id: uuid.UUID) -> None:
    """Enqueue a :class:`TaskRun` for the worker to execute.

    Falls back to inline execution (non-durable, but never dropped) if the
    queue can't be reached."""
    try:
        pool = await _get_pool()
        await pool.enqueue_job(RUN_TASK, str(run_id))
        return
    except Exception:  # noqa: BLE001 — never let queueing break the request
        logger.warning(
            "enqueue_run: queue unavailable, executing inline", exc_info=True
        )
    # Best-effort inline fallback.
    from app.tasks.runner import execute_run

    asyncio.create_task(execute_run(run_id), name=f"task_run_{run_id}")


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

    asyncio.create_task(execute_meeting(job_id), name=f"meeting_job_{job_id}")


__all__ = ["enqueue_run", "enqueue_meeting", "RUN_TASK", "RUN_MEETING"]
