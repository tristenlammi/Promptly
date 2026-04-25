"""Pydantic schemas for the Study module — projects, units, exams, sessions."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

StudyMessageRole = Literal["user", "assistant", "system"]
ProjectStatus = Literal["planning", "active", "completed", "archived"]
UnitStatus = Literal["not_started", "in_progress", "completed"]
ExamStatus = Literal["pending", "in_progress", "passed", "failed"]
SessionKind = Literal["unit", "exam", "legacy"]
# Student's self-reported starting level, collected in the New Study wizard.
# Optional — they can skip the field, in which case the planner and tutor
# fall back to a neutral register.
CurrentLevel = Literal["beginner", "some_exposure", "refresher"]


# ---- Messages ----
class StudyMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    role: StudyMessageRole
    content: str
    exercise_id: uuid.UUID | None = None
    created_at: datetime


# ---- Sessions ----
class StudySessionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    kind: SessionKind = "legacy"
    unit_id: uuid.UUID | None = None
    exam_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    # Completion-gate checkpoints so the frontend can render progress
    # affordances (teach-back banner, confidence widget, turn counter)
    # without a second round-trip.
    teachback_passed_at: datetime | None = None
    confidence_captured_at: datetime | None = None
    min_turns_required: int | None = None
    student_turn_count: int = 0
    hint_count: int = 0
    current_review_focus_objective_id: uuid.UUID | None = None


class StudySessionDetail(StudySessionSummary):
    notes_md: str | None = None
    messages: list[StudyMessageResponse] = Field(default_factory=list)


# ---- Units ----
class StudyUnitSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    order_index: int
    title: str
    description: str
    learning_objectives: list[str]
    status: UnitStatus
    mastery_score: int | None = None
    mastery_summary: str | None = None
    exam_focus: str | None = None
    inserted_as_prereq: bool = False
    prereq_reason: str | None = None
    prereq_batch_id: uuid.UUID | None = None
    # Computed server-side from ``last_studied_at`` (or ``completed_at``
    # fallback). Only meaningful for completed units; ``None`` means
    # the unit has never been studied long enough to anchor a gap.
    days_since_studied: int | None = None
    completed_at: datetime | None = None
    last_studied_at: datetime | None = None
    session_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


# ---- Exams ----
class StudyExamSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID | None = None
    attempt_number: int
    status: ExamStatus
    time_limit_seconds: int
    started_at: datetime | None = None
    ended_at: datetime | None = None
    score: int | None = None
    passed: bool | None = None
    weak_unit_ids: list[uuid.UUID] | None = None
    strong_unit_ids: list[uuid.UUID] | None = None
    summary: str | None = None
    # Per-unit grader notes keyed by unit id → short note. Populated
    # when the final-exam grader emits ``unit_notes`` alongside the
    # weak/strong lists.
    unit_notes: dict[str, str] | None = None
    created_at: datetime
    updated_at: datetime


# ---- Projects ----
class StudyProjectSummary(BaseModel):
    # Silence Pydantic's model_* protected-namespace warning for `model_id`.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    title: str
    topics: list[str]
    goal: str | None = None
    learning_request: str | None = None
    difficulty: str | None = None
    current_level: CurrentLevel | None = None
    calibrated: bool = False
    # How calibration flipped: "skipped" | "tutor_set" | "tutor_insert"
    # or None if calibration hasn't happened yet. Frontend uses this
    # only indirectly (via the ``calibration_warning`` SSE event) but
    # it's exposed for diagnostics.
    calibration_source: str | None = None
    status: ProjectStatus
    model_id: str | None = None
    archived_at: datetime | None = None
    planning_error: str | None = None
    # Derived counts — cheap to compute server-side and avoids N+1s on
    # the topics list.
    total_units: int = 0
    completed_units: int = 0
    created_at: datetime
    updated_at: datetime


class StudyProjectDetail(StudyProjectSummary):
    units: list[StudyUnitSummary] = Field(default_factory=list)
    sessions: list[StudySessionSummary] = Field(default_factory=list)
    exams: list[StudyExamSummary] = Field(default_factory=list)
    # The final-exam slot is unlocked once every unit is completed and
    # there's no in-progress exam already. Mirrors server logic so the
    # client can render the Final Exam card without re-deriving it.
    final_exam_unlocked: bool = False
    active_exam_id: uuid.UUID | None = None


class StudyProjectCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str = Field(min_length=1, max_length=255)
    topics: list[str] = Field(default_factory=list)
    goal: str | None = Field(default=None, max_length=4000)
    learning_request: str = Field(min_length=1, max_length=6000)
    # Optional — student can skip the level picker. When provided, the
    # planner front-loads prerequisite units for beginners and keeps
    # the plan tight for refreshers.
    current_level: CurrentLevel | None = None
    model_id: str = Field(min_length=1, max_length=255)
    provider_id: uuid.UUID


class StudyProjectUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    topics: list[str] | None = None
    goal: str | None = Field(default=None, max_length=4000)
    model_id: str | None = Field(default=None, max_length=255)


class StudyProjectRegeneratePlan(BaseModel):
    """Trigger plan regeneration for an existing project.

    The provider + model default to whatever was stored on the project
    at create time; passing them here lets the student try a different
    model without having to delete and recreate the topic.
    """

    model_config = ConfigDict(protected_namespaces=())

    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None


# ---- Exam management ----
class StudyExamStartRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    # Client may override the default 20-minute timer within a sensible
    # range. Server clamps to 5-45 minutes.
    time_limit_seconds: int | None = Field(default=None, ge=300, le=2700)


class StudyExamStartResponse(BaseModel):
    exam: StudyExamSummary
    session: StudySessionSummary
    # Optional kick-off stream so the AI can deliver item #1 without
    # the student having to send a message first.
    stream_id: uuid.UUID | None = None


# ---- Send message / stream ----
class StudySendMessageRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    content: str = Field(min_length=1)
    # Per-message override; falls back to the project's stored model.
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=4096, ge=1, le=100_000)
    # One-shot hint: the frontend sends this on the FIRST message
    # after deep-linking from the ReviewQueueWidget so the server
    # can stamp it on the session. Ignored if the session already
    # has a focus (sticky-until-satisfied, cleared server-side when
    # the tutor scores the matching objective).
    review_focus_objective_id: uuid.UUID | None = None


class StudySendMessageResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: StudyMessageResponse


# ---- Unit notes (plain text scratchpad) ----
class NotesUpdate(BaseModel):
    notes: str | None = None


class NotesState(BaseModel):
    notes: str | None = None
    updated_at: datetime


# ---- Whiteboard exercises ----
ExerciseStatus = Literal["active", "submitted", "reviewed"]


class WhiteboardExerciseSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    message_id: uuid.UUID | None = None
    title: str | None = None
    status: ExerciseStatus
    created_at: datetime
    submitted_at: datetime | None = None


class WhiteboardExerciseDetail(WhiteboardExerciseSummary):
    html: str
    answer_payload: Any = None
    ai_feedback: str | None = None


class WhiteboardSubmitRequest(BaseModel):
    exercise_id: uuid.UUID
    answers: Any = None


class WhiteboardSubmitResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: StudyMessageResponse
    exercise: WhiteboardExerciseSummary


# ======================================================================
# Persistent learner state (0033) — mirrors ORM models in models.py.
# These schemas back the new ``/study/projects/{id}/learner-profile``,
# ``/objective-mastery``, ``/misconceptions``, ``/review-queue``,
# and ``/sessions/{id}/confidence`` endpoints.
# ======================================================================


# ---- Learner profile (stored as JSONB on StudyProject) ----
class LearnerProfile(BaseModel):
    """Structured view of ``StudyProject.learner_profile``.

    All fields are optional so the tutor can partially populate the
    profile over time via ``save_learner_profile`` additive merges.
    The ``free_form`` bag captures anything that doesn't fit cleanly
    into the typed fields.
    """

    model_config = ConfigDict(extra="allow")

    occupation: str | None = None
    interests: list[str] = Field(default_factory=list)
    goals: list[str] = Field(default_factory=list)
    background: str | None = None
    preferred_examples_from: list[str] = Field(default_factory=list)
    free_form: dict[str, Any] = Field(default_factory=dict)


class LearnerProfileResponse(BaseModel):
    profile: LearnerProfile
    updated_at: datetime | None = None


class LearnerProfileUpdate(BaseModel):
    """Student-editable update. Sent from the LearnerProfilePanel.

    Server merges additively — passing ``interests: []`` explicitly
    clears the list, whereas omitting the field leaves it untouched.
    """

    occupation: str | None = None
    interests: list[str] | None = None
    goals: list[str] | None = None
    background: str | None = None
    preferred_examples_from: list[str] | None = None
    free_form: dict[str, Any] | None = None


# ---- Per-objective mastery ----
class ObjectiveMasteryEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    unit_id: uuid.UUID
    objective_index: int
    objective_text: str
    mastery_score: int
    ease_factor: float
    interval_days: int
    last_reviewed_at: datetime | None = None
    next_review_at: datetime | None = None
    review_count: int
    consecutive_failures: int
    # Computed server-side for UI convenience — null when the
    # objective has never been reviewed.
    days_since_review: int | None = None
    # True when ``next_review_at`` is in the past. Lets the frontend
    # highlight "due now" items without re-computing client-side.
    is_due: bool = False


class ObjectiveMasteryListResponse(BaseModel):
    entries: list[ObjectiveMasteryEntry] = Field(default_factory=list)


# ---- Review queue (projection of mastery rows due now) ----
class ReviewQueueItem(BaseModel):
    """A single row surfaced by the review-queue endpoint."""

    model_config = ConfigDict(from_attributes=True)

    objective_id: uuid.UUID
    unit_id: uuid.UUID
    unit_title: str
    objective_index: int
    objective_text: str
    mastery_score: int
    days_overdue: int
    last_reviewed_at: datetime | None = None


class ReviewQueueResponse(BaseModel):
    items: list[ReviewQueueItem] = Field(default_factory=list)


# ---- Misconceptions ----
class MisconceptionEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    unit_id: uuid.UUID | None = None
    objective_index: int | None = None
    description: str
    correction: str
    first_seen_at: datetime
    last_seen_at: datetime
    times_seen: int
    resolved_at: datetime | None = None


class MisconceptionListResponse(BaseModel):
    entries: list[MisconceptionEntry] = Field(default_factory=list)


# ---- Unit reflections ----
class UnitReflectionEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    unit_id: uuid.UUID
    session_id: uuid.UUID | None = None
    summary: str
    objectives_summary: dict[str, Any] = Field(default_factory=dict)
    concepts_anchored: list[str] = Field(default_factory=list)
    created_at: datetime


# ---- Student-initiated confidence capture ----
class ConfidenceCaptureRequest(BaseModel):
    level: int = Field(ge=1, le=5)
    objective_index: int | None = None
    note: str | None = Field(default=None, max_length=500)


class ConfidenceCaptureResponse(BaseModel):
    session_id: uuid.UUID
    captured_at: datetime
    level: int


# ---- Completion readiness ----
class CompletionReadinessObjective(BaseModel):
    """Per-objective row inside a :class:`CompletionReadinessResponse`.

    ``score`` is ``None`` until the objective has been assessed at
    least once (no mastery row yet, so nothing to report). ``meets_
    floor`` exists as a pre-computed boolean so the UI doesn't need
    to import the per-objective threshold constant.
    """

    index: int
    text: str
    score: int | None = None
    meets_floor: bool


class CompletionReadinessResponse(BaseModel):
    """Returned by ``GET /study/sessions/{id}/completion-readiness``.

    Read-only snapshot of the six-condition gate the server uses to
    accept ``mark_complete``. Safe to hit on every SSE
    ``study_state_updated`` event so the UI progress affordances
    stay in sync with the live transcript state.
    """

    ready: bool
    unmet: list[str] = Field(default_factory=list)
    overall_score: int
    per_objective: list[CompletionReadinessObjective] = Field(default_factory=list)
    teachback_passed: bool
    confidence_captured: bool
    student_turn_count: int
    min_turns_required: int | None = None
    has_reflection: bool


# ---- Unit entry response ----
class UnitEnterResponse(BaseModel):
    """Returned by ``POST /study/units/{id}/enter`` — the session to
    navigate to, plus the unit as it currently is so the frontend can
    show the mastery score immediately."""

    unit: StudyUnitSummary
    session: StudySessionSummary
    # Optional kick-off stream for fresh unit sessions so the tutor
    # can speak first ("Ready to start? Here's what we'll cover…")
    # rather than staring at an empty chat until the student types.
    # Populated only when we actually enqueue a kickoff (i.e. session
    # is brand-new with zero prior messages); re-entering an existing
    # session returns ``None`` so the client doesn't re-stream on tab
    # switches.
    stream_id: uuid.UUID | None = None
