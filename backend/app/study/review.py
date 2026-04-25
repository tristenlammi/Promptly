"""Spaced-repetition helpers for the Study module.

Implements a lean SM-2 variant against the
:class:`app.study.models.StudyObjectiveMastery` table. The classic SM-2
algorithm is overkill for our needs (we don't collect 0-5 quality
ratings from the student — just a 0-100 mastery score the tutor
reports via ``update_objective_mastery``), so we compress it to:

* **Pass (score >= :data:`config.REVIEW_PASS_SCORE`)**: schedule forward.
  ``new_interval = max(1, round(current_interval * ease_factor))``.
  Ease factor nudges up for strong scores and down for marginal ones
  so the cadence self-tunes.
* **Fail**: reset to 1 day, drop ease by
  :data:`config.FAIL_EASE_PENALTY` (clamped at
  :data:`config.MIN_EASE_FACTOR`), bump ``consecutive_failures``.

The queue projection (:func:`compute_due`) scopes to the student's own
projects and orders by overdue ratio so freshly-stale items don't
starve behind long-overdue backlog.

Seeding (:func:`seed_objectives_for_unit`) is idempotent — safe to
call every time a unit session opens so legacy units (created before
this migration) get their rows lazily.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import config, models


# ---- Scheduling ------------------------------------------------------
def schedule_next_review(
    row: "models.StudyObjectiveMastery", *, success: bool, score: int
) -> None:
    """Mutate an objective mastery row in place with a fresh schedule.

    Called from the ``update_objective_mastery`` action handler after
    the tutor reports a per-objective score. Caller is responsible for
    committing the session.

    Args:
        row: The ORM instance to update.
        success: Whether this review counts as a pass. Typically
            ``score >= config.REVIEW_PASS_SCORE``; kept as a separate
            arg so the action handler can override for edge cases
            (e.g. a "partial credit — try again tomorrow" case where
            the tutor explicitly requests re-scheduling).
        score: 0-100 mastery signal from the tutor. Used to nudge the
            ease factor (strong scores nudge up, marginal scores nudge
            down) and persisted into ``mastery_score``.
    """

    now = datetime.now(tz=timezone.utc)
    row.last_reviewed_at = now
    row.review_count = (row.review_count or 0) + 1
    row.mastery_score = max(0, min(100, int(score)))

    if success:
        row.consecutive_failures = 0
        # First pass starts the ladder; subsequent passes multiply.
        if row.interval_days <= 0:
            row.interval_days = config.INITIAL_INTERVAL_DAYS
        else:
            row.interval_days = max(
                1, round(row.interval_days * (row.ease_factor or config.DEFAULT_EASE_FACTOR))
            )
        # Ease nudge: +0.1 at score >= 90, -0.05 in 70..79, neutral otherwise.
        # Keeps the SM-2 spirit (good answers widen the gap, marginal
        # answers tighten it) without collecting an explicit rating.
        if score >= 90:
            row.ease_factor = round((row.ease_factor or config.DEFAULT_EASE_FACTOR) + 0.1, 3)
        elif score < 80:
            row.ease_factor = max(
                config.MIN_EASE_FACTOR,
                round((row.ease_factor or config.DEFAULT_EASE_FACTOR) - 0.05, 3),
            )
    else:
        row.consecutive_failures = (row.consecutive_failures or 0) + 1
        row.interval_days = 1
        row.ease_factor = max(
            config.MIN_EASE_FACTOR,
            round((row.ease_factor or config.DEFAULT_EASE_FACTOR) - config.FAIL_EASE_PENALTY, 3),
        )

    row.next_review_at = now + timedelta(days=row.interval_days)


# ---- Due queue projection --------------------------------------------
async def compute_due(
    db: AsyncSession,
    project_id: uuid.UUID,
    *,
    limit: int = config.REVIEW_QUEUE_LIMIT,
) -> list[models.StudyObjectiveMastery]:
    """Return the top ``limit`` objectives most overdue for review.

    Ordering is ``(next_review_at ASC NULLS LAST)`` — the oldest due
    date wins, which is equivalent to "most overdue ratio" since we
    don't weight by subject matter. Items with a null
    ``next_review_at`` (never reviewed) sit at the bottom so they
    don't crowd out actual spaced-repetition work.
    """

    now = datetime.now(tz=timezone.utc)
    stmt = (
        select(models.StudyObjectiveMastery)
        .where(models.StudyObjectiveMastery.project_id == project_id)
        .where(models.StudyObjectiveMastery.next_review_at.is_not(None))
        .where(models.StudyObjectiveMastery.next_review_at <= now)
        .order_by(models.StudyObjectiveMastery.next_review_at.asc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


# ---- Objective seeding -----------------------------------------------
async def seed_objectives_for_unit(
    db: AsyncSession, unit: "models.StudyUnit"
) -> list[models.StudyObjectiveMastery]:
    """Ensure every objective on ``unit`` has a mastery row.

    Idempotent: skips indices that already exist, inserts the rest.
    Called both by the planner (when a plan is first generated) and
    lazily on session open for legacy units created before this
    migration.

    Caller is responsible for committing. Returns the full current set
    of rows for the unit (existing + newly-seeded) so the caller can
    use them without a second round-trip.
    """

    objectives = list(unit.learning_objectives or [])
    existing_stmt = select(models.StudyObjectiveMastery).where(
        models.StudyObjectiveMastery.unit_id == unit.id
    )
    existing_rows = list((await db.execute(existing_stmt)).scalars().all())
    existing_by_idx = {r.objective_index: r for r in existing_rows}

    created: list[models.StudyObjectiveMastery] = []
    for idx, text in enumerate(objectives):
        if idx in existing_by_idx:
            # Keep objective_text in sync if the planner regenerated
            # the unit with a lightly reworded objective — otherwise
            # the prompt would show stale text.
            row = existing_by_idx[idx]
            if (text or "").strip() and row.objective_text != text:
                row.objective_text = text
            continue
        row = models.StudyObjectiveMastery(
            project_id=unit.project_id,
            unit_id=unit.id,
            objective_index=idx,
            objective_text=text or f"Objective {idx + 1}",
            mastery_score=0,
            ease_factor=config.DEFAULT_EASE_FACTOR,
            interval_days=0,
            review_count=0,
            consecutive_failures=0,
        )
        db.add(row)
        created.append(row)

    await db.flush()
    return existing_rows + created


async def list_mastery_for_project(
    db: AsyncSession, project_id: uuid.UUID
) -> list[models.StudyObjectiveMastery]:
    """Return every objective mastery row for a project.

    Used both by the ``/objective-mastery`` endpoint and by prompt
    hydration — the tutor's "Mastery state" block needs the whole set
    to render per-objective bars for the unit in focus.
    """

    stmt = (
        select(models.StudyObjectiveMastery)
        .where(models.StudyObjectiveMastery.project_id == project_id)
        .order_by(
            models.StudyObjectiveMastery.unit_id,
            models.StudyObjectiveMastery.objective_index,
        )
    )
    return list((await db.execute(stmt)).scalars().all())
