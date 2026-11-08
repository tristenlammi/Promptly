"""Talk's one table: how fast each answered turn was (0300). Timings only:
no words, no audio, nothing that says what was talked about."""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class TalkMetric(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "talk_metrics"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    session_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    device: Mapped[str] = mapped_column(String(16), nullable=False)  # web | android | car
    transport: Mapped[str] = mapped_column(String(16), nullable=False)  # ws | fallback
    # Last word -> the turn decision (Smart Turn), as the speech service measured it.
    endpoint_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Last word -> the final transcript in hand.
    stt_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The model call started -> its first words.
    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Last word -> the first audio sent back. The number that matters.
    first_audio_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tool_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    barge_ins: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    fast_path: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    __table_args__ = (Index("ix_talk_metrics_created_at", "created_at"),)
