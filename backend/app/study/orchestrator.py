"""Lesson-phase orchestrator for the Study module.

Phase 2 of the S-tier overhaul.  The orchestrator owns "what beat
happens next" so the LLM doesn't have to manage the lesson arc in its
head while also trying to teach well.

Architecture
------------
* The server advances the phase once per student turn, before the
  system prompt is built.
* Each phase gets a short, focused instruction block prepended to the
  system prompt (see :mod:`app.study.phase_prompts`).
* The LLM *fills* the phase — it does not manage the sequence.
* Phase transitions are deterministic rules on observable state; no
  model call is required.

Canonical phase sequence
------------------------
hook → activate → (present → guided → independent)* → interleave?
    → teachback → transfer → close

The present/guided/independent loop repeats per objective until all
objectives have been practiced at least once (``mastery_score > 0``).
The server tracks which iteration of the loop we're in via
``session.phase_history``.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.study import config as study_config

if TYPE_CHECKING:
    from app.study.models import StudyObjectiveMastery, StudySession, StudyUnit

# Canonical ordered phase list.  The orchestrator can only advance
# *forward* (or stay) — never backward — except for the present/guided/
# independent loop which cycles per objective.
PHASES: list[str] = [
    "hook",
    "activate",
    "present",
    "guided",
    "independent",
    "interleave",
    "teachback",
    "transfer",
    "close",
]


# ---- Helpers ---------------------------------------------------------

def turns_in_current_phase(session: "StudySession") -> int:
    """Number of student turns since the current phase started.

    Reads ``session.phase_history`` (list of ``{"phase", "turn"}``
    entries, newest last) and returns
    ``current_student_turn_count - entered_at_turn``.

    Returns 0 when the phase was just entered or history is empty.
    """
    current = session.phase
    if not current:
        return session.student_turn_count or 0
    history: list[dict[str, Any]] = list(session.phase_history or [])
    # Walk backwards to find the most recent entry for this phase.
    for entry in reversed(history):
        if entry.get("phase") == current:
            entered_at = int(entry.get("turn", 0))
            return max(0, (session.student_turn_count or 0) - entered_at)
    return session.student_turn_count or 0


def _objectives_fully_mastered(
    mastery_rows: "list[StudyObjectiveMastery]",
    unit_id: Any,
) -> int:
    """Count objectives for *unit_id* with mastery_score >= REVIEW_PASS_SCORE."""
    return sum(
        1
        for r in mastery_rows
        if r.unit_id == unit_id and r.mastery_score >= study_config.REVIEW_PASS_SCORE
    )


def _objectives_with_any_score(
    mastery_rows: "list[StudyObjectiveMastery]",
    unit_id: Any,
) -> int:
    """Count objectives for *unit_id* that have been scored at least once."""
    return sum(
        1 for r in mastery_rows if r.unit_id == unit_id and r.mastery_score > 0
    )


# ---- Core transition logic -------------------------------------------

def _next_phase(
    *,
    current_phase: str | None,
    student_turn_count: int,
    turns_in_phase: int,
    teachback_passed: bool,
    confidence_captured: bool,
    comprehension_confirmed: bool,
    total_objectives: int,
    objectives_with_score: int,
    objectives_fully_mastered: int,
    has_due_reviews: bool,
) -> str:
    """Return the phase the session should be in on this turn.

    Called once per student message, before building the system prompt.
    Pure function — no side effects; the caller mutates ``session``.
    """
    total = max(1, total_objectives)

    # ---- Session start -----------------------------------------------
    if current_phase is None:
        return "hook"

    # ---- hook --------------------------------------------------------
    if current_phase == "hook":
        # After the student's first response, move to activate.
        return "activate" if student_turn_count >= 1 else "hook"

    # ---- activate ----------------------------------------------------
    if current_phase == "activate":
        # One calibration exchange, then teach.
        return "present" if turns_in_phase >= 1 else "activate"

    # ---- present (explain one objective) -----------------------------
    if current_phase == "present":
        # The tutor's ``comprehension_confirmed`` signal is the driver
        # (L0.2): a student advances when they demonstrate understanding,
        # not on a schedule. The turn ceiling is only a slow escape valve
        # for a model that forgets to emit the signal — set high enough
        # that a genuinely struggling student gets re-explanations (the
        # phase prompt switches to simplify-and-recheck after 3 turns)
        # instead of being shoved into guided practice.
        if comprehension_confirmed or turns_in_phase >= 6:
            return "guided"
        return "present"

    # ---- guided (faded worked example) -------------------------------
    if current_phase == "guided":
        # One scaffolded example, then student practices solo.
        return "independent" if turns_in_phase >= 2 else "guided"

    # ---- independent (retrieval without hints) -----------------------
    if current_phase == "independent":
        # All objectives mastered → move toward close arc.
        if objectives_fully_mastered >= total:
            return "teachback"
        # Insert an interleave beat when due items exist + enough turns.
        if has_due_reviews and turns_in_phase >= 3:
            return "interleave"
        # After practicing the current objective, loop to next objective.
        if turns_in_phase >= 3:
            return "present"
        return "independent"

    # ---- interleave (one prior-unit retrieval rep) -------------------
    if current_phase == "interleave":
        # Brief interleave (1-2 turns), then back to the main arc.
        if objectives_fully_mastered >= total:
            return "teachback"
        return "present" if turns_in_phase >= 2 else "interleave"

    # ---- teachback (Feynman explain-back) ----------------------------
    if current_phase == "teachback":
        return "transfer" if teachback_passed else "teachback"

    # ---- transfer (anchor to student's world) ------------------------
    if current_phase == "transfer":
        # After one transfer exchange, move to close.
        # Also advance early if confidence already captured.
        if confidence_captured or turns_in_phase >= 2:
            return "close"
        return "transfer"

    # ---- close (gate check + completion) -----------------------------
    # close is terminal for the orchestrator; the completion gate in
    # service.py handles the actual mark_complete logic.
    return "close"


# ---- Public API ------------------------------------------------------

def advance_phase(
    *,
    session: "StudySession",
    unit: "StudyUnit",
    mastery_rows: "list[StudyObjectiveMastery]",
    has_due_reviews: bool,
) -> str:
    """Determine and apply the next phase for this turn.

    Mutates ``session.phase`` and ``session.phase_history`` in-place
    (the caller's DB session will commit these with the assistant
    message).  Returns the new phase name.

    Safe to call multiple times on the same session object in the same
    turn — subsequent calls see the already-updated phase and are
    no-ops (they return the same phase).
    """
    total_objectives = len(unit.learning_objectives or [])
    obj_with_score = _objectives_with_any_score(mastery_rows, unit.id)
    obj_mastered = _objectives_fully_mastered(mastery_rows, unit.id)
    t_in_phase = turns_in_current_phase(session)

    new_phase = _next_phase(
        current_phase=session.phase,
        student_turn_count=session.student_turn_count or 0,
        turns_in_phase=t_in_phase,
        teachback_passed=session.teachback_passed_at is not None,
        confidence_captured=session.confidence_captured_at is not None,
        comprehension_confirmed=getattr(session, "comprehension_confirmed_at", None) is not None,
        total_objectives=total_objectives,
        objectives_with_score=obj_with_score,
        objectives_fully_mastered=obj_mastered,
        has_due_reviews=has_due_reviews,
    )

    if new_phase != session.phase:
        # Reset the comprehension stamp when leaving present so the next
        # iteration of present (for a new objective) starts fresh.
        if session.phase == "present":
            session.comprehension_confirmed_at = None
        history: list[dict[str, Any]] = list(session.phase_history or [])
        history.append(
            {
                "phase": new_phase,
                "turn": session.student_turn_count or 0,
            }
        )
        session.phase = new_phase
        session.phase_history = history

    return new_phase
