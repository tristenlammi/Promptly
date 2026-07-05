"""Due-date reminder sweep for Team Learning (Study L3).

A single hourly ``asyncio.Task`` started from the FastAPI lifespan.
Two one-shot notices per enrollment, stamped so they never repeat:

* **Due soon** — the assignment is due within 24 hours and isn't
  completed → nudge the learner.
* **Overdue** — the due date has passed and it isn't completed → tell
  the learner, and cc the assigner (their dashboard shows the red chip;
  the ping means they don't have to go looking).

Deliberately conservative: no repeats, no escalation ladder — a
self-hosted team tool should nag exactly as much as a good colleague
would, once.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.database import SessionLocal
from app.study.models import StudyCourse, StudyEnrollment

logger = logging.getLogger("promptly.study.reminders")

SWEEP_INTERVAL_SECONDS = 3600  # hourly is plenty for day-granular due dates
_DUE_SOON_WINDOW = timedelta(hours=24)


async def sweep_due_reminders() -> int:
    """One pass: send pending due-soon / overdue notices. Returns count sent.

    Separated from the loop so tests (and ops) can invoke a single sweep
    directly.
    """
    from app.notifications import notify_user

    sent = 0
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(StudyEnrollment, StudyCourse)
                .join(StudyCourse, StudyCourse.id == StudyEnrollment.course_id)
                .where(
                    StudyEnrollment.due_at.is_not(None),
                    StudyEnrollment.status != "completed",
                )
            )
        ).all()
        for enr, course in rows:
            due = enr.due_at
            if due is None:
                continue
            # --- Overdue (one-shot) ---
            if due < now and enr.overdue_notice_sent_at is None:
                enr.overdue_notice_sent_at = now
                sent += 1
                await notify_user(
                    user_id=enr.learner_user_id,
                    category="assignment",
                    title="Assigned course overdue",
                    body=(
                        f"'{course.title}' was due "
                        f"{due.strftime('%d %b')} — pick it back up when "
                        "you can."
                    ),
                    url=f"/study/topics/{enr.project_id}",
                    tag=f"promptly-course-overdue-{enr.id}",
                    workspace_id=course.workspace_id,
                )
                if enr.assigned_by and enr.assigned_by != enr.learner_user_id:
                    await notify_user(
                        user_id=enr.assigned_by,
                        category="assignment",
                        title="Assigned course overdue",
                        body=(
                            f"A course you assigned ('{course.title}') "
                            f"passed its due date without being completed."
                        ),
                        url=f"/workspaces/{course.workspace_id}",
                        tag=f"promptly-course-overdue-lead-{enr.id}",
                        workspace_id=course.workspace_id,
                    )
                continue  # overdue supersedes due-soon
            # --- Due soon (one-shot, ≤24h out) ---
            if (
                now <= due <= now + _DUE_SOON_WINDOW
                and enr.due_reminder_sent_at is None
            ):
                enr.due_reminder_sent_at = now
                sent += 1
                await notify_user(
                    user_id=enr.learner_user_id,
                    category="assignment",
                    title="Assigned course due soon",
                    body=(
                        f"'{course.title}' is due "
                        f"{due.strftime('%d %b')} — a session today keeps "
                        "it on track."
                    ),
                    url=f"/study/topics/{enr.project_id}",
                    tag=f"promptly-course-due-{enr.id}",
                    workspace_id=course.workspace_id,
                )
        await db.commit()
    return sent


async def _loop() -> None:
    while True:
        try:
            sent = await sweep_due_reminders()
            if sent:
                logger.info("study reminder sweep sent %d notice(s)", sent)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover — defensive
            logger.exception("study reminder sweep failed; will retry")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def start_study_reminders() -> asyncio.Task[None]:
    """Spawn the reminder loop; caller cancels the handle on shutdown."""
    return asyncio.create_task(_loop(), name="study_reminders")
