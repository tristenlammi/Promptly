"""Study — ORM (migration ``0483_study``).

Everything here belongs to one person (``user_id`` on the subject; every
other row hangs off a subject and goes with it). Nobody else, an admin
included, has a route to any of it.

* :class:`StudySubject` — what someone is learning: the goal, how deep, who
  it's pitched at, and where the build is up to.
* :class:`StudyUnit` / :class:`StudyConcept` — the map. A concept knows what
  it depends on (``prereqs``), how solid the learner is on it (``mastery``,
  0–1) and why it is there (``origin``: planned, or added for a gap, with
  the ``reason`` the learner is shown).
* :class:`StudyMisconception` — a wrong idea the learner has shown.
* :class:`StudySession` — one sitting: the placement check or a lesson.
* :class:`StudyStep` — one thing the teacher did: its ``payload`` (with the
  answer key, never sent to the browser before it is answered), what the
  learner answered, the ``grade`` and the ``evidence`` it gave per concept.
* :class:`StudySource` — the numbered source pack steps cite.

``StudyConcept.fsrs`` is the review card for a learned concept: the same
state the Flashcards kind keeps (``app.items.kinds.flashcards.fsrs``), with
``due_at`` beside it so "what's due" is a query. :class:`StudyDay` is one row
per person per day they studied. (Phase 2, migration ``0484_study_two``.)
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

DEPTHS = ("overview", "solid", "deep")
LEVELS = ("child", "teen", "adult")
SUBJECT_STATUSES = ("building", "failed", "placement", "active", "complete")
CONCEPT_STATES = ("new", "learning", "mastered", "known")
ORIGINS = ("planned", "gap")


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class StudySubject(Base):
    __tablename__ = "study_subjects"
    __table_args__ = (Index("ix_study_subjects_user", "user_id", "updated_at"),)

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    prior: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    depth: Mapped[str] = mapped_column(String(12), nullable=False, default="solid", server_default="solid")
    level: Mapped[str] = mapped_column(String(8), nullable=False, default="adult", server_default="adult")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="building", server_default="building")
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    use_web: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    # {"file_ids": [...], "note_ids": [...]}: the owner's own, checked at create.
    attached: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    build_stage: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", server_default="queued")
    build_progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    build_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()
    last_studied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The final applied task: {"status": "passed"|"open", "tries": n, "step_id", "outcome", "at"}.
    capstone: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # Written once when the subject is finished: {"next": [{"title", "why"}], "at"}.
    report: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StudyUnit(Base):
    __tablename__ = "study_units"
    __table_args__ = (Index("ix_study_units_subject", "subject_id", "position"),)

    id: Mapped[uuid.UUID] = _pk()
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # The unit's applied task (same shape as the subject's).
    capstone: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)


class StudyConcept(Base):
    __tablename__ = "study_concepts"
    __table_args__ = (Index("ix_study_concepts_subject", "subject_id", "position"),)

    id: Mapped[uuid.UUID] = _pk()
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    unit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_units.id", ondelete="CASCADE"), nullable=False)
    # Order across the whole subject (not per unit). Floats so a gap concept
    # can sit just before the concept it was added for.
    position: Mapped[float] = mapped_column(Float, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    objectives: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # fact | process | principle | skill: steers which step kinds are used.
    nature: Mapped[str] = mapped_column(String(12), nullable=False, default="principle", server_default="principle")
    prereqs: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")  # concept ids
    source_ns: Mapped[list[int]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    mastery: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    state: Mapped[str] = mapped_column(String(10), nullable=False, default="new", server_default="new")
    origin: Mapped[str] = mapped_column(String(8), nullable=False, default="planned", server_default="planned")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    gap_for: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_concepts.id", ondelete="SET NULL"), nullable=True
    )
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    production_ok: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    steps_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    mastered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fsrs: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StudyMisconception(Base):
    __tablename__ = "study_misconceptions"
    __table_args__ = (Index("ix_study_misc_concept", "concept_id"),)

    id: Mapped[uuid.UUID] = _pk()
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    concept_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_concepts.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(80), nullable=False)  # normalised label, for "the same one again"
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    seen: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    resolved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    first_seen_at: Mapped[datetime] = _now()
    last_seen_at: Mapped[datetime] = _now()


class StudySession(Base):
    __tablename__ = "study_sessions"
    __table_args__ = (Index("ix_study_sessions_subject", "subject_id", "started_at"),)

    id: Mapped[uuid.UUID] = _pk()
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)  # placement | lesson | review
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="active", server_default="active")
    # Working state the engine owns (focus concept, parked concepts, the
    # placement probes and where the search is up to).
    plan: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = _now()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StudyStep(Base):
    __tablename__ = "study_steps"
    __table_args__ = (
        Index("ix_study_steps_session", "session_id", "position"),
        Index("ix_study_steps_concept", "concept_id"),
    )

    id: Mapped[uuid.UUID] = _pk()
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_sessions.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    concept_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_concepts.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # recall | test_out | placement | review | capstone | "" (an ordinary teaching step)
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="pending", server_default="pending")
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    answer: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    grade: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # teach_student: the conversation with the confused student.
    turns: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # Ask the teacher, on this step.
    asks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    hints_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    confidence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = _now()
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StudySource(Base):
    __tablename__ = "study_sources"
    __table_args__ = (Index("ix_study_sources_subject", "subject_id", "n"),)

    id: Mapped[uuid.UUID] = _pk()
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)
    n: Mapped[int] = mapped_column(Integer, nullable=False)  # the number steps cite: [1], [2]…
    kind: Mapped[str] = mapped_column(String(6), nullable=False)  # web | file | note
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    note_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")


class StudyDay(Base):
    """A day someone studied (their own local date), and how many steps."""

    __tablename__ = "study_days"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    steps: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
