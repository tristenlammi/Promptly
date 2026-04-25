"""Centralised tunables for the Study state machine.

All thresholds the server enforces live here so we can tweak
pedagogical parameters without code surgery scattered across the
planner, tutor service, review scheduler, and staleness evaluator.

Everything is a module-level constant for two reasons:

1. It keeps the "which number is the magic one?" story obvious —
   reading :func:`handle_unit_action` and seeing ``MASTERY_FLOOR``
   reads better than a hard-coded ``80``.
2. Tests can monkeypatch individual constants to drive edge cases
   (e.g. drop ``MIN_TURNS_REQUIRED`` to 1 for fast-path tests).
"""
from __future__ import annotations

# ---- Completion-gate thresholds --------------------------------------
# Overall unit mastery (weighted blend of per-objective scores) the
# tutor must claim before ``mark_complete`` is accepted. Matches the
# existing gate but extracts the magic number from the service layer.
MASTERY_FLOOR = 80

# Minimum per-objective mastery. Protects against a unit passing its
# overall floor while one objective sits at 40 — which would bury a
# blind spot the tutor should have surfaced.
PER_OBJECTIVE_FLOOR = 75


def min_turns_required(n_objectives: int) -> int:
    """Number of student turns the gate requires before unit close.

    Scaling linearly with ``n_objectives`` discourages the tutor from
    racing through a 6-objective unit in two turns, while still
    letting a 1-objective refresher wrap up quickly.

    Formula: ``4 + 2 * n_objectives`` — so a 1-objective unit needs 6
    turns, a typical 3-objective unit needs 10, and an ambitious
    6-objective unit needs 16.
    """

    return 4 + 2 * max(1, n_objectives)


# ---- Spaced repetition defaults --------------------------------------
# First-review interval in days when an objective is freshly mastered.
# Kept modest so the student sees the concept again within a week.
INITIAL_INTERVAL_DAYS = 1

# Default SM-2 ease factor for new objectives. SuperMemo's canonical
# starting value; nudged by ``schedule_next_review`` based on score.
DEFAULT_EASE_FACTOR = 2.5

# Lower bound on ease factor. Anything below this starts to produce
# chaotic schedules; SuperMemo's original paper uses the same floor.
MIN_EASE_FACTOR = 1.3

# Ease delta applied on a failed review. Matches SM-2's ``-0.2`` penalty.
FAIL_EASE_PENALTY = 0.2

# Reviews that score >= this value are treated as "successful" and
# schedule forward. Anything below resets the interval to 1 day.
REVIEW_PASS_SCORE = 70

# How many items the ``/review-queue`` endpoint surfaces per project.
# Kept small because the prompt budget is the real constraint — the
# tutor can only interleave a handful of review items per unit.
REVIEW_QUEUE_LIMIT = 3

# Default review interval ladder for display hints — exposed so the
# frontend can show "next review: ~3 days from now" style labels
# without re-deriving the SM-2 math.
REVIEW_INTERVALS_DEFAULT = [1, 3, 7, 21, 60]


# ---- Prompt hydration caps -------------------------------------------
# We inject recent reflections, unresolved misconceptions, and due
# review items into every unit prompt. Caps keep the token budget in
# check and match the plan's risk call-out ("hydrated prompt grows").
MAX_REFLECTIONS_IN_PROMPT = 3
MAX_MISCONCEPTIONS_IN_PROMPT = 5
MAX_REVIEW_ITEMS_IN_PROMPT = 3


# ---- Interleaving trigger --------------------------------------------
# After this many turns on new material in a single session, the tutor
# is prompted to weave in a due review item. Matches Principle #10
# (interleaving) without forcing a review on turn 1.
INTERLEAVING_TRIGGER_TURNS = 6
