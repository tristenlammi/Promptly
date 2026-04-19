"""Pydantic schemas for the Study module (projects, sessions, messages)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

StudyMessageRole = Literal["user", "assistant", "system"]


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
    created_at: datetime
    updated_at: datetime


class StudySessionDetail(StudySessionSummary):
    excalidraw_snapshot: dict[str, Any] | None = None
    messages: list[StudyMessageResponse] = Field(default_factory=list)


# ---- Projects ----
class StudyProjectSummary(BaseModel):
    # Silence Pydantic's model_* protected-namespace warning for `model_id`.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    title: str
    topics: list[str]
    goal: str | None = None
    model_id: str | None = None
    created_at: datetime
    updated_at: datetime


class StudyProjectDetail(StudyProjectSummary):
    sessions: list[StudySessionSummary] = Field(default_factory=list)


class StudyProjectCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str = Field(min_length=1, max_length=255)
    topics: list[str] = Field(default_factory=list)
    goal: str | None = Field(default=None, max_length=4000)
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    # When true (default), a session is created immediately so the user can
    # open the project and start studying right away.
    create_session: bool = True


class StudyProjectUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    topics: list[str] | None = None
    goal: str | None = Field(default=None, max_length=4000)
    model_id: str | None = Field(default=None, max_length=255)


# ---- Send message / stream ----
class StudySendMessageRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    content: str = Field(min_length=1)
    # Per-message override; falls back to the project's stored model.
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=4096, ge=1, le=100_000)


class StudySendMessageResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: StudyMessageResponse


# ---- Whiteboard snapshot ----
class WhiteboardUpdate(BaseModel):
    """Payload for `POST /sessions/{id}/whiteboard/update`.

    `snapshot` is the raw Excalidraw scene JSON. We store it as-is so the
    client can re-hydrate with `initialData` on reload.
    """

    snapshot: dict[str, Any] | None = None


class WhiteboardState(BaseModel):
    snapshot: dict[str, Any] | None = None
    updated_at: datetime


# ---- Whiteboard exercises ----
ExerciseStatus = Literal["active", "submitted", "reviewed"]


class WhiteboardExerciseSummary(BaseModel):
    """Lightweight shape for history listings — omits the (potentially huge)
    HTML body so the list endpoint stays snappy."""

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
    excalidraw_snap: str | None = None


class WhiteboardSubmitRequest(BaseModel):
    """Payload for `POST /sessions/{id}/whiteboard/submit`.

    ``answers`` is untyped JSON — the AI-authored HTML decides its own shape.
    ``excalidraw_snapshot_b64`` is an optional base64-encoded PNG of the
    student's freehand scene captured at submit time.
    """

    exercise_id: uuid.UUID
    answers: Any = None
    excalidraw_snapshot_b64: str | None = None


class WhiteboardSubmitResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: StudyMessageResponse
    exercise: WhiteboardExerciseSummary
