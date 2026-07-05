"""Meeting-notes jobs (S-tier 4.4).

A :class:`MeetingJob` tracks one uploaded meeting recording from upload
to finished workspace note. It's the durable state an Arq worker commits
progress into, and the thing the UI polls:

    pending → transcribing → summarising → done | failed

The transcript is persisted on the row the moment transcription finishes
so a failure in the (cheap, retryable) summarise stage never discards an
hour of (expensive) Whisper work.
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class MeetingJob(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "meeting_jobs"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Who uploaded the recording — they own the resulting note's authorship
    # and get the completion notification.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # pending | transcribing | summarising | done | failed
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )
    # Chunk progress (done/total) — committed after every transcribed chunk
    # so the polling UI can show a real bar, not a spinner.
    progress_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duration_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Optional BCP-47 hint forwarded to Whisper (empty = auto-detect).
    language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Relative path (under UPLOAD_ROOT) of the uploaded audio. Cleared once
    # the job reaches a terminal state — the recording is transient input,
    # not a Drive file.
    audio_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # The seeded note, once the job is done.
    note_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_items.id", ondelete="SET NULL"), nullable=True
    )


__all__ = ["MeetingJob"]
