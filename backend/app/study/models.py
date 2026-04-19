"""Study module ORM models: projects, sessions, messages, whiteboard exercises."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


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
    model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    def __repr__(self) -> str:
        return f"<StudyProject id={self.id} title={self.title!r}>"


class StudySession(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "study_sessions"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Full Excalidraw scene JSON, debounced auto-save every ~30s.
    excalidraw_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    def __repr__(self) -> str:
        return f"<StudySession id={self.id} project_id={self.project_id}>"


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
    excalidraw_snap: Mapped[str | None] = mapped_column(Text, nullable=True)  # base64 PNG
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
