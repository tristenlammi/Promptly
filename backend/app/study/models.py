"""Study module ORM models: projects, units, sessions, exams, messages, exercises."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


# ---- Project statuses ----------------------------------------------------
# ``planning``  — plan generation is pending or in flight; no units yet.
# ``active``    — plan exists; student is working through units.
# ``completed`` — final exam passed; project is eligible for archiving.
# ``archived``  — filed away; still readable, not shown in the active tab.
ProjectStatus = str  # 'planning' | 'active' | 'completed' | 'archived'


class StudyProject(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "study_projects"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    topics: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, default=list, server_default="{}"
    )
    goal: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Raw "I want to learn..." description the student entered when
    # creating the topic. The planner LLM reads this verbatim to emit
    # a unit plan; we keep it around so we can regenerate if the first
    # plan turns out to be off-base.
    learning_request: Mapped[str | None] = mapped_column(Text, nullable=True)
    # AI-inferred difficulty tag surfaced in the UI card (beginner /
    # intermediate / advanced / mixed). Free-form string — not enforced
    # at the DB layer because the planner may decide "intro-to-advanced"
    # or similar.
    difficulty: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Student's self-reported starting level, collected in the New Study
    # wizard. One of ``beginner`` / ``some_exposure`` / ``refresher``, or
    # None if they skipped the field. The planner uses this to pace the
    # plan (beginners on advanced topics like CCNA get explicit
    # foundations units at the front); the unit tutor uses it as a
    # default register until the Unit 1 diagnostic confirms or corrects
    # it.
    current_level: Mapped[str | None] = mapped_column(String(24), nullable=True)
    # Whether the Unit 1 forced diagnostic has run on this project yet.
    # Flipped true by the tutor emitting ``calibration_complete`` or
    # ``insert_prerequisites`` with ``mark_calibrated=true``. Reset to
    # false when the plan is regenerated.
    calibrated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # How calibration flipped on for this project. One of ``skipped``
    # (student clicked "Skip diagnostic"), ``tutor_set`` (tutor emitted
    # ``set_calibrated`` at the end of a clean warm-up), or
    # ``tutor_insert`` (tutor emitted ``insert_prerequisites`` and the
    # handler auto-calibrated). NULL until the flag first flips. Never
    # overwritten once set so we can honestly report whether the
    # student took the warm-up seriously.
    calibration_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # One-shot timestamp for the ``calibration_warning`` SSE event.
    # NULL means "the honesty nudge has not fired yet"; any value
    # means "already shown, don't show again".
    calibration_warning_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    planning_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    planning_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="planning", server_default="active"
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ---- Persistent learner state (0033) ----
    # Free-form JSONB grab-bag the tutor writes via the
    # ``save_learner_profile`` action. Mergeable keys include
    # ``occupation``, ``interests`` (list), ``goals`` (list),
    # ``background``, ``preferred_examples_from`` (list),
    # ``free_form`` (notes). Server always merges additively rather
    # than replacing so the tutor can refine the profile over time
    # without losing older context.
    learner_profile: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="'{}'::jsonb"
    )
    learner_profile_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<StudyProject id={self.id} title={self.title!r} status={self.status}>"


class StudyUnit(UUIDPKMixin, TimestampMixin, Base):
    """One ordered slice of the learning plan for a ``StudyProject``.

    Units are generated by the AI planner right after a project is
    created and remain mostly static after that — only ``status``,
    ``mastery_score``, ``completed_at`` and ``last_studied_at`` flip as
    the student progresses. ``exam_focus`` is populated when a failed
    exam surfaces specific weaknesses for this unit; the unit tutor
    prepends it to its next system prompt so follow-up study targets
    exactly what the exam found missing.
    """

    __tablename__ = "study_units"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    learning_objectives: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )

    # 'not_started' | 'in_progress' | 'completed'
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="not_started", server_default="not_started"
    )
    mastery_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mastery_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    exam_focus: Mapped[str | None] = mapped_column(Text, nullable=True)

    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_studied_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "study_sessions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_study_units_session_id",
        ),
        nullable=True,
    )

    # True for units the tutor inserted mid-plan via
    # ``insert_prerequisites`` (either proactively during a unit session
    # or as the outcome of the Unit 1 calibration diagnostic). Surfaced
    # in the UI with a subtle "added by tutor" label so the student can
    # distinguish original plan units from fill-in foundations.
    inserted_as_prereq: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Free-form reason the tutor provided when emitting
    # ``insert_prerequisites``. Shown verbatim in the "Added by tutor"
    # banner on the topic page so the student understands why the plan
    # was modified without re-reading chat.
    prereq_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Shared UUID for every unit inserted by the same tutor reply, so
    # the UI can group them into a single dismissible banner keyed in
    # localStorage.
    prereq_batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<StudyUnit id={self.id} #{self.order_index} {self.title!r} "
            f"status={self.status}>"
        )


class StudyExam(UUIDPKMixin, TimestampMixin, Base):
    """One attempt at the final exam for a project.

    A project can have multiple ``StudyExam`` rows — one per attempt.
    Only one row at a time can be in ``in_progress``; the rest are
    ``pending``/``passed``/``failed`` terminals. Failing an exam flips
    the project back into ``active`` state and unlocks the listed
    ``weak_unit_ids`` for targeted re-study.
    """

    __tablename__ = "study_exams"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "study_sessions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_study_exams_session_id",
        ),
        nullable=True,
    )

    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # 'pending' | 'in_progress' | 'passed' | 'failed'
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    time_limit_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1200, server_default="1200"
    )

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    weak_unit_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=True
    )
    strong_unit_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=True
    )
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Per-unit grader notes keyed by stringified unit id —
    # ``{unit_id: "1-2 sentence note"}``. Populated by the grader LLM
    # when it emits the ``grade`` exam action; surfaced in the topic
    # page "Exam breakdown" panel alongside the weak/strong lists.
    unit_notes: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    def __repr__(self) -> str:
        return f"<StudyExam id={self.id} status={self.status} score={self.score}>"


class StudySession(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "study_sessions"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Free-form student notes for this unit session. Plain text (the
    # frontend renders it as a simple textarea), debounced auto-save
    # every few seconds. Replaced the old Excalidraw scene JSON in 0026.
    notes_md: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Discriminator: ``unit`` for unit-tutor sessions, ``exam`` for a
    # final-exam session, ``legacy`` for free-form sessions created
    # before the Units feature landed.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unit", server_default="legacy"
    )
    unit_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_units.id", ondelete="SET NULL"), nullable=True
    )
    exam_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_exams.id", ondelete="SET NULL"), nullable=True
    )

    # ---- Completion-gate checkpoints (0033) ----
    # Stamp set by the tutor's ``teachback_passed`` action after the
    # student has successfully explained the unit in their own words.
    # The server's ``mark_complete`` gate refuses unit completion
    # until this is non-null so the Feynman step can't be skipped.
    teachback_passed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Stamp set when the student reports a 1-5 confidence score for
    # the unit (either via the ``capture_confidence`` action emitted
    # by the tutor, or directly via the student-initiated
    # ``POST /sessions/{id}/confidence`` endpoint).
    confidence_captured_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Minimum number of student turns the gate requires before the
    # unit can be marked complete. Computed at session open via
    # ``MIN_TURNS_FORMULA(n_objectives)``; null = "no minimum yet"
    # (legacy sessions or first-load before the planner seeded
    # objectives).
    min_turns_required: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Count of student (``role='user'``) messages persisted on this
    # session. Incremented in the router whenever a user message is
    # written so the completion gate has a cheap, monotonic check.
    student_turn_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Count of assistant turns in which the tutor offered a scaffolded
    # hint (tracked so future analytics can see "how many hints did
    # this student need before passing?"). Incremented from the
    # action parser when the tutor emits structured scaffolding.
    hint_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Pointer to a ``study_objective_mastery`` row the student opted
    # to review via the ReviewQueueWidget deep-link. Set by
    # ``send_message`` the first time it sees a ``review_focus_
    # objective_id`` on an incoming payload, consulted by the prompt
    # builder on every turn, and cleared automatically when the
    # tutor emits ``update_objective_mastery`` for the matching
    # objective index — i.e. the review is "done" the moment the
    # objective has a fresh score, regardless of how many turns that
    # took. Nullable on all existing sessions.
    current_review_focus_objective_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_objective_mastery.id", ondelete="SET NULL"),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<StudySession id={self.id} kind={self.kind} project_id={self.project_id}>"


class WhiteboardExercise(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "whiteboard_exercises"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Circular reference with study_messages — broken during DDL via use_alter.
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "study_messages.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_whiteboard_exercises_message_id",
        ),
        nullable=True,
    )

    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    html: Mapped[str] = mapped_column(Text, nullable=False)

    # 'active' | 'submitted' | 'reviewed'
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="active", server_default="active"
    )

    answer_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    ai_feedback: Mapped[str | None] = mapped_column(Text, nullable=True)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return f"<WhiteboardExercise id={self.id} status={self.status}>"


class StudyMessage(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "study_messages"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )

    role: Mapped[str] = mapped_column(String(32), nullable=False)
    # Chat text with `<whiteboard_action>` blocks stripped.
    content: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    exercise_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "whiteboard_exercises.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_study_messages_exercise_id",
        ),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<StudyMessage id={self.id} role={self.role}>"


# ====================================================================
# Persistent learner state (0033) — per-objective mastery, misconceptions,
# and unit reflections. These three tables together are what lets the
# tutor prompt be *state-driven* instead of re-probing the same info
# every session.
# ====================================================================
class StudyObjectiveMastery(UUIDPKMixin, TimestampMixin, Base):
    """Per-objective mastery score + SM-2-lite spacing state.

    One row per ``(project_id, unit_id, objective_index)`` triple.
    Seeded by the planner when a unit is generated (or lazily on first
    session open for plans that predate this migration). Written by
    the tutor via the ``update_objective_mastery`` action.

    The SM-2-lite fields (``ease_factor``, ``interval_days``,
    ``next_review_at``, ``consecutive_failures``) are mutated by
    :func:`app.study.review.schedule_next_review`. ``mastery_score``
    is the gate criterion — each objective must pass
    :data:`app.study.config.PER_OBJECTIVE_FLOOR` before the unit can
    be marked complete.
    """

    __tablename__ = "study_objective_mastery"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    unit_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_units.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    objective_index: Mapped[int] = mapped_column(Integer, nullable=False)
    objective_text: Mapped[str] = mapped_column(Text, nullable=False)

    mastery_score: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    ease_factor: Mapped[float] = mapped_column(
        Float, nullable=False, default=2.5, server_default="2.5"
    )
    interval_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    next_review_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    consecutive_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "unit_id",
            "objective_index",
            name="uq_study_objective_mastery_objective",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<StudyObjectiveMastery unit={self.unit_id} "
            f"#{self.objective_index} score={self.mastery_score}>"
        )


class StudyMisconception(UUIDPKMixin, Base):
    """A single misconception the tutor has observed for a project.

    Catalog is project-scoped, not unit-scoped: some misconceptions
    span multiple units (e.g. "confuses correlation and causation"
    across a stats plan), so ``unit_id`` is nullable and SET NULL on
    unit delete. ``times_seen`` monotonically increases when the
    tutor re-logs the same pattern; ``resolved_at`` is set when the
    student demonstrates they've moved past it.
    """

    __tablename__ = "study_misconceptions"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    unit_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_units.id", ondelete="SET NULL"), nullable=True
    )
    objective_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    correction: Mapped[str] = mapped_column(Text, nullable=False)

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(tz=None),
        server_default="CURRENT_TIMESTAMP",
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(tz=None),
        server_default="CURRENT_TIMESTAMP",
    )
    times_seen: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<StudyMisconception id={self.id} project={self.project_id}>"


class StudyUnitReflection(UUIDPKMixin, CreatedAtMixin, Base):
    """A bridging summary written at the end of a unit attempt.

    Emitted by the tutor's ``summarise_unit`` action (or auto-stubbed
    by the server gate if the model forgets). The most recent 3
    reflections across the project are injected into every new unit's
    system prompt as the "Recent unit reflections" block — this is
    what lets the tutor cite a concrete anchor from a prior unit in
    its opening message (Principle #12, bridging narrative).
    """

    __tablename__ = "study_unit_reflections"

    unit_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_units.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("study_sessions.id", ondelete="SET NULL"), nullable=True
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    # Per-objective verdict map keyed by stringified ``objective_index``
    # → 1-2 sentence note. Optional — older rows store ``{}``.
    objectives_summary: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="'{}'::jsonb"
    )
    # Free-form list of short "concept anchor" strings the tutor wants
    # to cite from this unit next time. Powers Principle #11 (transfer
    # prompts) — the next unit's opener picks one anchor and asks
    # "remember when…".
    concepts_anchored: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )

    def __repr__(self) -> str:
        return f"<StudyUnitReflection unit={self.unit_id} id={self.id}>"
