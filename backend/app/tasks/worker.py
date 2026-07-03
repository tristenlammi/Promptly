"""Arq worker for scheduled-automation runs.

Run in its own container: ``arq app.tasks.worker.WorkerSettings``. It pulls
``execute_task_run`` jobs off Redis and executes them via the same
:func:`app.tasks.runner.execute_run` the API used to call inline — but out of
the API process, so redeploys of the API don't kill in-flight runs.
"""
from __future__ import annotations

import uuid

from arq.connections import RedisSettings
from arq.cron import cron

from app.config import get_settings
from app.tasks.queue import RUN_TASK


async def execute_task_run(ctx, run_id: str) -> None:
    """Arq job: execute one already-created pending TaskRun to completion.
    ``execute_run`` owns its own DB session and never raises (every failure is
    recorded on the run row), so a bad run can't take the worker down."""
    from app.tasks.runner import execute_run

    await execute_run(uuid.UUID(run_id))


# Arq registers functions by their ``__name__``; pin it to the shared constant
# so the enqueue side (queue.RUN_TASK) and the worker always agree.
execute_task_run.__name__ = RUN_TASK


async def purge_deleted(ctx) -> None:
    """Daily cron: hard-delete users/orgs whose soft-delete grace window has
    elapsed (see ``app.tasks.deletion.run_purge``). Isolated + self-logging so
    a bad row can't take the worker down."""
    from app.tasks.deletion import run_purge

    await run_purge()


class WorkerSettings:
    functions = [execute_task_run, purge_deleted]
    redis_settings = RedisSettings.from_dsn(get_settings().REDIS_URL)
    # Daily hard-purge of soft-deleted accounts, 03:15 UTC (off the hour to
    # avoid piling onto other midnight jobs). run_shutdown/startup unused.
    cron_jobs = [cron(purge_deleted, hour=3, minute=15)]
    # A run can be long (LLM turns + tool hops + web search); give it room.
    job_timeout = 900
    max_jobs = 4
    # Results live on the TaskRun row, not in Redis — don't retain them.
    keep_result = 0
