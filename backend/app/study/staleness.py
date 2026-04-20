"""Staleness / mastery-decay logic for completed study units.

A student who breezes through a unit and then forgets about it for a
month probably isn't at the mastery level the gradebook claims they
are. Rather than running a background cron, we evaluate staleness
lazily every time the topic detail endpoint loads the project. This
keeps the rules dead-simple to operate: no schedulers, no drift
between workers, and the UI is always consistent with what the DB
thinks.

### Tiers (all measured in days since ``last_studied_at``, falling back
to ``completed_at`` when the unit was completed but never revisited)

=== Tier ``fresh``
Under 7 days. No-op.

=== Tier ``nudge`` (>= 7, < 14)
"Last studied N days ago" footer on the UnitCard, muted tone. No DB
change — this is pure UI signal so the student has a gentle reminder
without any numbers moving behind their back.

=== Tier ``soft`` (>= 14, < 30)
Soft decay: ``mastery_score`` drifts down 5 points per week past the
14-day threshold, floored at 65. Status stays ``completed``. The
tutor prompt also gets a ``staleness_block`` telling it to open with a
short recap question before teaching.

=== Tier ``flip`` (>= 30)
Status flips from ``completed`` back to ``in_progress``. Mastery
score caps at 60. The unit is no longer counted as "done" for the
progress bar purposes, but the **final exam stays unlocked** — this
is a C-style advisory, not a gate, so the student can still retest
whenever they want.

None of this deletes data. Regenerating the plan wipes the row set
anyway, which is why we don't bother with an "undo decay" path.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from .models import StudyProject, StudyUnit

# Tier thresholds, in whole days. Changing these is a product call, not
# a hot-path tweak — they're pulled out as constants so tests can read
# them without re-declaring the boundaries.
_STALE_NUDGE_DAYS = 7
_STALE_SOFT_DAYS = 14
_STALE_FLIP_DAYS = 30

# Mastery floors for the soft/flip tiers. Chosen so the visible number
# never plummets past what the student actually earned — a "completed"
# unit should still feel close to done when it's merely stale.
_SOFT_DECAY_FLOOR = 65
_FLIP_SCORE_CAP = 60
# 5 points of mastery bleed per 7-day chunk past the soft threshold.
_SOFT_DECAY_POINTS_PER_WEEK = 5
_SOFT_DECAY_WINDOW_DAYS = 7

StalenessTier = Literal["fresh", "nudge", "soft", "flip"]


@dataclass(frozen=True)
class StalenessVerdict:
    """Outcome of evaluating one unit against the current clock.

    Consumers typically only need ``tier`` (for prompt/UI decisions)
    and ``days_stale`` (for the "Last studied N days ago" line). The
    other two fields are what the mutation helper writes back when
    the verdict demands a change.
    """

    tier: StalenessTier
    days_stale: int
    recommended_score: int | None
    flip_status: bool


def _reference_timestamp(unit: StudyUnit) -> datetime | None:
    """Pick the timestamp we should measure staleness from.

    ``last_studied_at`` is set every time the unit tutor emits a
    message, so it's the freshest signal. For units completed in a
    single sitting that the student never returned to, fall back to
    ``completed_at`` so decay still kicks in instead of hanging on
    that first-and-only visit forever.
    """
    return unit.last_studied_at or unit.completed_at


def evaluate_staleness(unit: StudyUnit, now: datetime) -> StalenessVerdict:
    """Compute the staleness verdict for ``unit`` at ``now``.

    Pure function: no DB writes, no side effects, no logging. The
    caller decides whether to apply the verdict (see
    :func:`apply_staleness_to_project`).

    A unit is eligible for staleness grading if it has ever been
    completed — tracked via ``completed_at``. Not-started units and
    units that are still on their first pass (in_progress with no
    ``completed_at``) are always ``fresh`` because there's no earned
    mastery to decay yet. Units that were completed and then later
    flipped back to in_progress by this same module **do** stay
    eligible, so the tutor keeps seeing the flip-tier recovery block
    on subsequent sessions until the student re-earns mastery.
    """
    if unit.completed_at is None:
        return StalenessVerdict(
            tier="fresh",
            days_stale=0,
            recommended_score=None,
            flip_status=False,
        )

    reference = _reference_timestamp(unit)
    if reference is None:
        # Completed with no timestamps is a data anomaly — don't try
        # to recover, just treat as fresh so we don't start punishing
        # users for backfill gaps.
        return StalenessVerdict(
            tier="fresh",
            days_stale=0,
            recommended_score=None,
            flip_status=False,
        )

    # Normalise naive datetimes to UTC so the subtraction works even
    # when legacy rows came in without tzinfo.
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)

    delta_days = int((now - reference).total_seconds() // 86400)
    if delta_days < 0:
        delta_days = 0

    if delta_days >= _STALE_FLIP_DAYS:
        return StalenessVerdict(
            tier="flip",
            days_stale=delta_days,
            recommended_score=_FLIP_SCORE_CAP,
            flip_status=True,
        )

    if delta_days >= _STALE_SOFT_DAYS:
        weeks_past = (delta_days - _STALE_SOFT_DAYS) // _SOFT_DECAY_WINDOW_DAYS
        drop = (weeks_past + 1) * _SOFT_DECAY_POINTS_PER_WEEK
        base = unit.mastery_score if unit.mastery_score is not None else 100
        recommended = max(_SOFT_DECAY_FLOOR, base - drop)
        return StalenessVerdict(
            tier="soft",
            days_stale=delta_days,
            recommended_score=recommended,
            flip_status=False,
        )

    if delta_days >= _STALE_NUDGE_DAYS:
        return StalenessVerdict(
            tier="nudge",
            days_stale=delta_days,
            recommended_score=None,
            flip_status=False,
        )

    return StalenessVerdict(
        tier="fresh",
        days_stale=delta_days,
        recommended_score=None,
        flip_status=False,
    )


async def apply_staleness_to_project(
    db: AsyncSession,
    project: StudyProject,
    units: Iterable[StudyUnit],
    *,
    now: datetime | None = None,
) -> bool:
    """Evaluate every completed unit and persist any decay the verdict
    demands. Returns True if any row mutated, False if everything was
    already in sync (so the caller can skip a redundant commit).

    Only touches units whose ``status`` is ``completed``. In-progress
    and not-started units are left alone; their scores haven't been
    earned yet, so there's nothing to decay.

    The "flip" tier sends the unit back into ``in_progress`` with the
    capped score — this is deliberately advisory (the final exam
    stays unlocked) but it does show up in the progress bar, which is
    exactly the nudge we want.
    """
    reference_now = now or datetime.now(timezone.utc)
    changed = False
    for unit in units:
        if unit.status != "completed":
            continue
        verdict = evaluate_staleness(unit, reference_now)
        if verdict.tier == "fresh" or verdict.tier == "nudge":
            continue

        # Apply soft decay: only move the score down, never up, so a
        # brief clock skew can't accidentally boost someone's number.
        if verdict.recommended_score is not None:
            current = unit.mastery_score if unit.mastery_score is not None else 100
            if verdict.recommended_score < current:
                unit.mastery_score = verdict.recommended_score
                changed = True

        if verdict.flip_status and unit.status != "in_progress":
            unit.status = "in_progress"
            changed = True

    if changed:
        project.updated_at = reference_now
        await db.flush()

    return changed


def staleness_tier(unit: StudyUnit, now: datetime | None = None) -> StalenessTier:
    """Cheap tier lookup for UI code that doesn't need the full verdict.

    Prefer this over re-running :func:`evaluate_staleness` when you
    only care about which tier bucket a completed unit is in.
    """
    reference_now = now or datetime.now(timezone.utc)
    return evaluate_staleness(unit, reference_now).tier


def days_since_studied(unit: StudyUnit, now: datetime | None = None) -> int | None:
    """Days elapsed since the unit was last studied (or completed).

    Returns ``None`` for units that have no reference timestamp yet,
    matching the nullable contract of the ``days_since_studied``
    field on ``StudyUnitSummary``. Negative gaps (clock skew) are
    normalised to 0.
    """
    reference = _reference_timestamp(unit)
    if reference is None:
        return None
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    reference_now = now or datetime.now(timezone.utc)
    gap = int((reference_now - reference).total_seconds() // 86400)
    return max(0, gap)
