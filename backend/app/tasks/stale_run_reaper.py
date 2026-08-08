"""Reap automation runs whose worker died mid-flight.

A ``TaskRun`` moves ``pending`` → ``running`` → terminal. Nothing moved it
*out* of the first two states except the worker itself, so if the arq worker
was killed (OOM, redeploy, `docker compose down`) between those points, the
row stayed non-terminal forever. That is worse than it sounds, because two
other things treat a non-terminal run as "still in flight":

* ``scheduler._has_active_run`` — a task with ``concurrency="skip"`` is
  skipped whenever any pending/running row exists, with no age bound. One
  orphaned row therefore disables that schedule **permanently**, and it only
  says so at INFO once per tick, so the automation just quietly stops running.
* ``hooks_router`` — counts unfinished runs toward ``_MAX_QUEUED`` and starts
  returning 429 once enough accumulate, permanently rejecting the webhook.

Neither surfaces as an error. The automation simply stops, and the operator
has no signal beyond "it used to run".

This sweeper closes both by marking sufficiently-old non-terminal runs as
failed, which is the truthful outcome: the worker died, so the run did not
complete. It logs at WARNING — a reaped run means work was lost, which is
worth noticing, unlike the routine housekeeping the other sweepers do.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app.database import SessionLocal
from app.tasks.models import TaskRun

logger = logging.getLogger("promptly.tasks.reaper")

# How often to look. Stale runs block future work, so this shouldn't be a
# once-a-day job, but the sweep is a single indexed UPDATE — cheap to repeat.
SWEEP_INTERVAL_SECONDS = 10 * 60

# A ``running`` row is only stale once it has outlived any legitimate run.
# arq's ``job_timeout`` is 3300s (55 min), so the worker itself gives up
# before this; the margin means we never reap a run that's genuinely working.
RUNNING_TIMEOUT = timedelta(minutes=90)

# A ``pending`` row means the worker never picked the job up. That's either a
# Redis outage or a process that died between committing the row and
# enqueueing it (see ``scheduler`` / ``queue``). Shorter than the running
# timeout because nothing is legitimately in this state for long.
PENDING_TIMEOUT = timedelta(minutes=30)

_RUNNING_ERROR = (
    "The worker stopped before this run finished (it was restarted or "
    "crashed). Marked failed automatically so the automation isn't blocked "
    "from running again."
)
_PENDING_ERROR = (
    "This run was queued but never started — the worker was unreachable. "
    "Marked failed automatically so the automation isn't blocked from "
    "running again."
)


async def reap_stale_runs() -> int:
    """Mark timed-out non-terminal runs as failed. Returns how many."""
    now = datetime.now(timezone.utc)
    running_cutoff = now - RUNNING_TIMEOUT
    pending_cutoff = now - PENDING_TIMEOUT

    async with SessionLocal() as db:
        rows = (
            (
                await db.execute(
                    select(TaskRun).where(
                        or_(
                            # ``started_at`` is set when the run flips to
                            # running. Fall back to created_at if it somehow
                            # isn't, so a malformed row can't be immortal.
                            (TaskRun.status == "running")
                            & (
                                TaskRun.started_at.is_(None)
                                | (TaskRun.started_at < running_cutoff)
                            ),
                            (TaskRun.status == "pending")
                            & (TaskRun.created_at < pending_cutoff),
                        )
                    )
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return 0

        for run in rows:
            # Read the original status *before* overwriting it — the two
            # cases get different explanations, and "running" vs "pending"
            # is the only thing distinguishing them.
            was_running = run.status == "running"
            run.status = "failed"
            run.error = _RUNNING_ERROR if was_running else _PENDING_ERROR
            run.finished_at = now
            logger.warning(
                "Reaping stale automation run %s (task=%s, was %s) — the "
                "worker never finished it; the schedule was blocked until now",
                run.id,
                run.task_id,
                "running" if was_running else "pending",
            )
        await db.commit()
        return len(rows)


async def _sweep_loop() -> None:
    """Sweep forever. Cancellation propagates up cleanly via lifespan."""
    while True:
        try:
            reaped = await reap_stale_runs()
            if reaped:
                logger.warning(
                    "stale-run reaper failed %d orphaned automation run(s)",
                    reaped,
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            logger.exception("stale-run reaper failed; will retry")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def start_stale_run_reaper() -> asyncio.Task[None]:
    """Spawn the reaper as a detached task; caller cancels on shutdown."""
    return asyncio.create_task(_sweep_loop(), name="stale_run_reaper")
