"""Albums (WP-9.4): references to photos, with members."""
from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

import app.auth.models  # noqa: F401 — users, the FK target, for a bare worker process
from app.database import Base


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    sort: Mapped[str] = mapped_column(String(8), nullable=False, default="newest", server_default="newest")
    # A smart album's saved question (PH-5) — None for an ordinary album.
    rules: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    rules_checked_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AlbumItem(Base):
    __tablename__ = "album_items"

    album_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True)
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True, index=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    added_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # Put there by a smart album's question (and taken out when it stops matching).
    via_rule: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))


class AlbumMember(Base):
    __tablename__ = "album_members"

    album_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="viewer", server_default="viewer")
    added_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())




class AlbumExclusion(Base):
    """A photo the owner took out of a smart album: its question won't put
    it back (PH-5)."""

    __tablename__ = "album_exclusions"

    album_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True)
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = ["Album", "AlbumExclusion", "AlbumItem", "AlbumMember"]
