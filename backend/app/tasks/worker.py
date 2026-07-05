"""Arq worker for scheduled-automation runs.

Run in its own container: ``arq app.tasks.worker.WorkerSettings``. It pulls
``execute_task_run`` jobs off Redis and executes them via the same
:func:`app.tasks.runner.execute_run` the API used to call inline — but out of
the API process, so redeploys of the API don't kill in-flight runs.
"""
from __future__ import annotations

import uuid

from arq.connections import RedisSettings
from arq.worker import func

from app.config import get_settings
from app.tasks.queue import RUN_MEETING, RUN_TASK


async def execute_task_run(ctx, run_id: str) -> None:
    """Arq job: execute one already-created pending TaskRun to completion.
    ``execute_run`` owns its own DB session and never raises (every failure is
    recorded on the run row), so a bad run can't take the worker down."""
    from app.tasks.runner import execute_run

    await execute_run(uuid.UUID(run_id))


async def execute_meeting_job(ctx, job_id: str) -> None:
    """Arq job: chunk-transcribe a meeting recording and seed the notes note.
    ``execute_meeting`` owns its session and records failures on the job row."""
    from app.workspaces.meetings_runner import execute_meeting

    await execute_meeting(uuid.UUID(job_id))


# Arq registers functions by their ``__name__``; pin it to the shared constant
# so the enqueue side (queue.RUN_TASK) and the worker always agree.
execute_task_run.__name__ = RUN_TASK
execute_meeting_job.__name__ = RUN_MEETING


class WorkerSettings:
    functions = [
        execute_task_run,
        # A long recording on CPU Whisper is legitimately slow — give
        # meeting jobs far more room than the 900s automation ceiling.
        func(execute_meeting_job, timeout=3 * 3600, max_tries=1),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().REDIS_URL)
    # A run can be long (LLM turns + tool hops + web search); give it room.
    # This is now a *backstop*, not the real limit — each run computes a
    # size-aware budget (app.tasks.graph_runner.estimate_flow_timeout, capped
    # at 3000s) and enforces it itself with a clear "exceeded time budget"
    # message. The worker ceiling just sits above that cap so the blunt kill
    # never fires before the friendly one (A3).
    job_timeout = 3300
    max_jobs = 4
    # Results live on the TaskRun row, not in Redis — don't retain them.
    keep_result = 0
