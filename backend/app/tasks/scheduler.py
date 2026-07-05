"""Background scheduler for Scheduled Tasks (Phase 1 — T.1).

A single ``asyncio.Task`` started from the FastAPI lifespan. Every minute
it claims any task whose ``next_run_at`` has elapsed using
``FOR UPDATE SKIP LOCKED`` (so multiple backend workers never double-fire
the same task), advances ``next_run_at`` to the following slot *before*
running, creates a pending :class:`TaskRun`, and spawns
:func:`app.tasks.runner.execute_run` as a detached coroutine.

Advancing ``next_run_at`` on claim is also the overlap guard: a task
won't be re-picked until its next slot, so a slow run can't stack up.
After downtime the task fires **once** (we jump straight to the next
future slot) rather than backfilling every missed tick.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.database import SessionLocal
from app.tasks.models import Task, TaskRun
from app.tasks.queue import enqueue_run
from app.tasks.recurrence import compute_next_run

logger = logging.getLogger("promptly.tasks.scheduler")

POLL_INTERVAL_SECONDS = 60
# Max tasks claimed per tick — a safety valve so a backlog can't spawn an
# unbounded burst of model calls in one pass.
_CLAIM_LIMIT = 25


async def _claim_due() -> list[uuid.UUID]:
    """Claim due tasks, enqueue a run for each, return the new run ids."""
    now = datetime.now(timezone.utc)
    run_ids: list[uuid.UUID] = []
    async with SessionLocal() as db:
        rows = (
            (
                await db.execute(
                    select(Task)
                    .where(
                        Task.enabled.is_(True),
                        Task.next_run_at.is_not(None),
                        Task.next_run_at <= now,
                    )
                    .order_by(Task.next_run_at.asc())
                    .limit(_CLAIM_LIMIT)
                    .with_for_update(skip_locked=True)
                )
            )
            .scalars()
            .all()
        )
        for task in rows:
            # Advance to the next slot up front so we don't re-claim it.
            try:
                task.next_run_at = compute_next_run(
                    frequency=task.frequency,
                    after=now,
                    hour=task.hour,
                    minute=task.minute,
                    weekday=task.weekday,
                    day_of_month=task.day_of_month,
                    tz_name=task.timezone,
                )
            except ValueError:
                logger.warning(
                    "Task %s has invalid schedule; disabling", task.id
                )
                task.enabled = False
                continue
            # Overlap policy (A3): with ``skip``, don't start a scheduled fire
            # while a run for this task is still in flight — a slow run can't
            # stack up on the next tick. (next_run_at is already advanced, so
            # the task simply waits for its following slot.) Default ``allow``
            # keeps the historical fire-anyway behaviour.
            if task.concurrency == "skip" and await _has_active_run(db, task.id):
                logger.info(
                    "Task %s scheduled fire skipped (a run is still in flight)",
                    task.id,
                )
                continue
            run = TaskRun(task_id=task.id, status="pending", trigger="schedule")
            db.add(run)
            await db.flush()
            run_ids.append(run.id)
        await db.commit()
    return run_ids


async def _has_active_run(db, task_id: uuid.UUID) -> bool:
    """True if a pending/running run already exists for this task."""
    existing = (
        await db.execute(
            select(TaskRun.id)
            .where(
                TaskRun.task_id == task_id,
                TaskRun.status.in_(("pending", "running")),
            )
            .limit(1)
        )
    ).first()
    return existing is not None


async def _loop() -> None:
    while True:
        try:
            run_ids = await _claim_due()
            for rid in run_ids:
                await enqueue_run(rid)
            if run_ids:
                logger.info("scheduler dispatched %d task run(s)", len(run_ids))
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            logger.exception("task scheduler tick failed; will retry")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def start_scheduler() -> asyncio.Task[None]:
    """Spawn the scheduler loop; caller cancels the handle on shutdown."""
    return asyncio.create_task(_loop(), name="task_scheduler")
