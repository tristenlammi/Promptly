"""Calls' tables (0281). Live state is in Redis (``app.calls.state``);
these hold a voice channel's settings and the history of voice sessions,
for usage and "Export my library". Nothing said is stored anywhere."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin

QUALITIES = ("standard", "good", "high", "music")
# Opus bitrates the clients publish at (kbps); "music" is stereo, no DTX.
BITRATES = {"standard": 32, "good": 64, "high": 96, "music": 128}
ROLES = ("member", "admin")
ALONE_CHOICES = (5, 15, 30, 60)  # minutes; NULL = never
DEFAULT_ALONE_MINUTES = 15


class RoomVoice(Base):
    """A voice channel's settings (``rooms.kind == "voice"``)."""

    __tablename__ = "room_voice"

    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    user_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")  # 0 = no limit
    quality: Mapped[str] = mapped_column(String(8), nullable=False, default="good", server_default="good")
    join_role: Mapped[str] = mapped_column(String(8), nullable=False, default="member", server_default="member")
    talk_role: Mapped[str] = mapped_column(String(8), nullable=False, default="member", server_default="member")
    video: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")  # cameras and Go Live
    alone_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True, default=DEFAULT_ALONE_MINUTES, server_default="15")


class Call(UUIDPKMixin, Base):
    """One voice session: a channel's first join until it's empty again.
    Phases 2-4 (DM calls, meetings, notes) add their columns."""

    __tablename__ = "calls"

    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="voice", server_default="voice")
    room_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=True, index=True)
    lk_room: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CallParticipant(Base):
    """Who was in a session and for how long (history and usage only)."""

    __tablename__ = "call_participants"

    call_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("calls.id", ondelete="CASCADE"), primary_key=True)
    identity: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    first_joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
