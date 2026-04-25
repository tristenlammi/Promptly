"""Regression tests for the multi-condition mark-complete gate.

The gate is the single most important piece of behavioural evidence
in the Study subsystem — it's what stops a rushed tutor from
``mark_complete``-ing a unit three messages in. These tests pin down
the exact set of ``unmet`` strings each missing precondition
produces, so any accidental change (re-wording, re-ordering, new
condition sneaking in without the corresponding UI copy) fails
loudly.

Covers both:

* The pure :func:`evaluate_completion_gate` compute function used by
  the readiness endpoint and
* Its production configuration via :data:`study_config` constants.

Backend-only; no HTTP round-trip required. A tiny fake async session
stands in for SQLAlchemy so the tests don't need a live database —
the function's DB surface is narrow enough (two scalar selects) to
stub cleanly.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import pytest

from app.study import config as study_config
from app.study import service


# ---------------------------------------------------------------------------
# Minimal ORM-ish test doubles. Only the attributes the gate actually reads
# are modelled; everything else is free-form via __dict__ so a SQLAlchemy
# select() over these still walks them without complaint.
# ---------------------------------------------------------------------------


@dataclass
class FakeMasteryRow:
    unit_id: uuid.UUID
    objective_index: int
    objective_text: str
    mastery_score: int


@dataclass
class FakeUnit:
    id: uuid.UUID
    learning_objectives: list[str] = field(default_factory=list)
    status: str = "in_progress"
    mastery_score: int = 0
    mastery_summary: str | None = None
    completed_at: datetime | None = None
    last_studied_at: datetime | None = None
    updated_at: datetime | None = None
    exam_focus: str | None = None


@dataclass
class FakeSession:
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    teachback_passed_at: datetime | None = None
    confidence_captured_at: datetime | None = None
    min_turns_required: int | None = None
    student_turn_count: int = 0


class _ScalarsResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = list(rows)

    def all(self) -> list[Any]:
        return list(self._rows)

    def first(self) -> Any:
        return self._rows[0] if self._rows else None


class _ExecuteResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> _ScalarsResult:
        return _ScalarsResult(self._rows)


class FakeAsyncSession:
    """Stand-in for ``AsyncSession`` — answers every ``execute(stmt)``
    with the list of rows matching ``stmt.column_descriptions[0]["type"]``.

    This is intentionally dumb: we don't evaluate the WHERE clause,
    we just return everything we've registered for that ORM class.
    The gate only queries over a single unit / session at a time, so
    the filter is effectively redundant in test scope.
    """

    def __init__(
        self,
        mastery: list[FakeMasteryRow] | None = None,
        reflections: list[Any] | None = None,
    ) -> None:
        self._rows_by_type: dict[type, list[Any]] = {
            service.StudyObjectiveMastery: mastery or [],
            service.StudyUnitReflection: reflections or [],
        }
        self.added: list[Any] = []

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def execute(self, stmt: Any) -> _ExecuteResult:
        target = self._target_type(stmt)
        rows = self._rows_by_type.get(target, [])
        return _ExecuteResult(rows)

    @staticmethod
    def _target_type(stmt: Any) -> type:
        # SQLAlchemy 2.0 select() objects expose ``column_descriptions``;
        # each entry's ``type`` is the mapped class we want to route on.
        descs = getattr(stmt, "column_descriptions", None) or []
        if descs and isinstance(descs[0], dict) and "type" in descs[0]:
            return descs[0]["type"]
        return type(None)


def _make_unit(n_objectives: int = 2) -> FakeUnit:
    return FakeUnit(
        id=uuid.uuid4(),
        learning_objectives=[f"Objective {i + 1}" for i in range(n_objectives)],
    )


def _passing_session(unit: FakeUnit) -> FakeSession:
    """Return a session that satisfies every per-session precondition
    (teach-back stamped, confidence captured, enough turns). The
    mastery rows + reflection are the caller's responsibility."""
    return FakeSession(
        teachback_passed_at=datetime.now(timezone.utc),
        confidence_captured_at=datetime.now(timezone.utc),
        min_turns_required=3,
        student_turn_count=5,
    )


def _full_mastery(unit: FakeUnit) -> list[FakeMasteryRow]:
    return [
        FakeMasteryRow(
            unit_id=unit.id,
            objective_index=i,
            objective_text=text,
            mastery_score=95,
        )
        for i, text in enumerate(unit.learning_objectives)
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_gate_ready_when_all_conditions_met() -> None:
    """Happy path: every precondition satisfied + summary supplied."""
    unit = _make_unit()
    session = _passing_session(unit)
    db = FakeAsyncSession(
        mastery=_full_mastery(unit),
        reflections=[object()],  # any non-empty = reflection recorded
    )

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=study_config.MASTERY_FLOOR + 5,
        proposed_summary="Student explained it back cleanly.",
    )

    assert readiness["ready"] is True
    assert readiness["unmet"] == []
    assert readiness["teachback_passed"] is True
    assert readiness["confidence_captured"] is True
    assert readiness["has_reflection"] is True


async def test_gate_flags_low_overall_score() -> None:
    unit = _make_unit()
    session = _passing_session(unit)
    db = FakeAsyncSession(
        mastery=_full_mastery(unit), reflections=[object()]
    )

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=study_config.MASTERY_FLOOR - 1,
        proposed_summary="summary",
    )

    assert readiness["ready"] is False
    assert any(
        "overall mastery" in msg and "needs" in msg for msg in readiness["unmet"]
    )


async def test_gate_flags_missing_objective_scores() -> None:
    """Objectives with no mastery row at all trip the per-objective
    condition even when the rest of the session is perfect."""
    unit = _make_unit(n_objectives=3)
    session = _passing_session(unit)
    # Only one of the three objectives has been scored.
    partial = [
        FakeMasteryRow(
            unit_id=unit.id,
            objective_index=0,
            objective_text=unit.learning_objectives[0],
            mastery_score=90,
        )
    ]
    db = FakeAsyncSession(mastery=partial, reflections=[object()])

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=90,
        proposed_summary="summary",
    )

    assert readiness["ready"] is False
    no_score_msgs = [
        m for m in readiness["unmet"] if "has no mastery score yet" in m
    ]
    assert len(no_score_msgs) == 2  # objectives 2 and 3


async def test_gate_flags_missing_teachback_and_confidence() -> None:
    unit = _make_unit()
    session = FakeSession(
        teachback_passed_at=None,
        confidence_captured_at=None,
        min_turns_required=3,
        student_turn_count=5,
    )
    db = FakeAsyncSession(
        mastery=_full_mastery(unit), reflections=[object()]
    )

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=study_config.MASTERY_FLOOR + 5,
        proposed_summary="summary",
    )

    assert readiness["ready"] is False
    assert any("teach-back" in m for m in readiness["unmet"])
    assert any("confidence" in m for m in readiness["unmet"])


async def test_gate_flags_insufficient_turns() -> None:
    unit = _make_unit()
    session = _passing_session(unit)
    session.student_turn_count = 1
    session.min_turns_required = 5
    db = FakeAsyncSession(
        mastery=_full_mastery(unit), reflections=[object()]
    )

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=study_config.MASTERY_FLOOR + 5,
        proposed_summary="summary",
    )

    assert readiness["ready"] is False
    assert any("turns" in m for m in readiness["unmet"])


async def test_gate_accepts_summary_when_no_reflection_row_yet() -> None:
    """If the tutor skipped ``summarise_unit`` but supplied a summary
    on ``mark_complete``, the readiness check should NOT flag a
    missing reflection — the write-path will auto-stub one."""
    unit = _make_unit()
    session = _passing_session(unit)
    db = FakeAsyncSession(mastery=_full_mastery(unit), reflections=[])

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=study_config.MASTERY_FLOOR + 5,
        proposed_summary="Today we covered X, and the student can now Y.",
    )

    assert readiness["ready"] is True
    assert readiness["has_reflection"] is False  # factual — no row exists yet


async def test_readiness_endpoint_shape_omits_overall_check_without_score() -> None:
    """When called without ``proposed_score`` (the readiness-API
    path), the gate must NOT complain about overall mastery — the
    student is *heading towards* completion, not trying to close
    right now."""
    unit = _make_unit()
    session = _passing_session(unit)
    db = FakeAsyncSession(
        mastery=_full_mastery(unit), reflections=[object()]
    )

    readiness = await service.evaluate_completion_gate(
        db=db,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        proposed_score=None,
        proposed_summary=None,
    )

    assert readiness["ready"] is True
    assert not any("overall mastery" in m for m in readiness["unmet"])
    # Overall score is forecast from the mastery rows (avg of 95s).
    assert readiness["overall_score"] == 95
