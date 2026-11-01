"""Rooms: spaces of text rooms, and direct messages, between the people on
this Promptly. Private by default — nothing here is indexed, searched by
the AI, or remembered; ``@promptly`` is the only AI (see ``promptly.py``)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class RoomSpace(UUIDPKMixin, CreatedAtMixin, Base):
    """A group of people with its rooms ("Family", "The Lads")."""

    __tablename__ = "room_spaces"

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False, default="", server_default="")
    color: Mapped[str] = mapped_column(String(9), nullable=False, default="#5B6DD9", server_default="#5B6DD9")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class RoomSpaceMember(Base):
    __tablename__ = "room_space_members"

    space_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("room_spaces.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False, default="member", server_default="member")  # owner/admin/member
    notify: Mapped[str] = mapped_column(String(8), nullable=False, default="all", server_default="all")  # all/mentions/none
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Room(UUIDPKMixin, CreatedAtMixin, Base):
    """A text room in a space, or a DM (``space_id`` NULL; members in
    ``room_members``)."""

    __tablename__ = "rooms"

    space_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("room_spaces.id", ondelete="CASCADE"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="text", server_default="text")  # text/dm/group
    name: Mapped[str] = mapped_column(String(80), nullable=False, default="", server_default="")
    topic: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # @promptly may read this room's recent history (a room admin's switch;
    # for a DM, every member's ``ai_ok`` instead).
    ai_context: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RoomMember(Base):
    """A DM's membership, and anyone's read state / settings in any room
    (made on first need for space rooms)."""

    __tablename__ = "room_members"

    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    last_read_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    notify: Mapped[str | None] = mapped_column(String(8), nullable=True)  # override: all/mentions/none
    ai_ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class RoomMessage(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "room_messages"
    __table_args__ = (UniqueConstraint("room_id", "seq", name="uq_room_messages_room_seq"),)

    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="user", server_default="user")  # user/promptly/system
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    reply_to_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("room_messages.id", ondelete="SET NULL"), nullable=True)
    mentions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pinned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RoomReaction(Base):
    __tablename__ = "room_reactions"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("room_messages.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    emoji: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class RoomAttachment(UUIDPKMixin, CreatedAtMixin, Base):
    """A file sent in a room. Stored at ``rooms/<room_id>/<id>`` under the
    upload root — not in anyone's Files, so not indexed."""

    __tablename__ = "room_attachments"

    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("room_messages.id", ondelete="CASCADE"), nullable=True, index=True)
    uploader_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime: Mapped[str] = mapped_column(String(127), nullable=False, default="application/octet-stream")
    size: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    has_thumb: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
