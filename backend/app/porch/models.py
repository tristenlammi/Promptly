"""Porch's tables (0270). See ``docs/porch-plan.md`` and ``docs/porch-build.md``.

Who can see what is :mod:`app.porch.access` — never read these tables for
another person without going through it."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, SmallInteger, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin

ROLES = ("owner", "admin", "member")
STATUSES = ("invited", "member", "removed")
NOTIFY = ("all", "none")
KINDS = ("photo", "video", "text", "poll", "life_event")


class PorchGroup(UUIDPKMixin, CreatedAtMixin, Base):
    """A group: "Family", "The Lads", "Fishing" — or the built-in Everyone
    (``kind='everyone'``, exactly one; everyone who may use Porch is in it
    without a row, and server admins are its admins)."""

    __tablename__ = "porch_groups"

    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="custom", server_default="custom")
    visibility: Mapped[str] = mapped_column(String(8), nullable=False, default="private", server_default="private")
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False, default="", server_default="")
    cover_file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    about: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    members_can_invite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PorchGroupMember(Base):
    """Someone in a group, invited to it, or removed from it (``removed``
    keeps them from joining a public group again by themselves). For
    Everyone the row only holds that person's ``in_feed`` / ``notify``."""

    __tablename__ = "porch_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False, default="member", server_default="member")
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="member", server_default="member")
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    in_feed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    notify: Mapped[str] = mapped_column(String(8), nullable=False, default="none", server_default="none")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PorchPost(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "porch_posts"

    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    body: Mapped[str] = mapped_column(String(5000), nullable=False, default="", server_default="")
    place: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # {name, lat, lon}
    life_event: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # {type, title, date}
    link: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # {url, title, description, site_name}
    mentions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    from_memory_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    origin: Mapped[str | None] = mapped_column(String(255), nullable=True)
    uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # body_tsv: a generated column, searched with raw SQL (not mapped).


class PorchPostGroup(Base):
    """The groups a post went to, fixed when it was posted."""

    __tablename__ = "porch_post_groups"

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True)
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PorchPostMedia(UUIDPKMixin, Base):
    """A photo or video in a post: a file in the poster's own library, with
    this post's own crop / filter (``edit``, ops as ``photos/edits.py``).
    Its ``id`` is what a signed ``porch_*`` media link names."""

    __tablename__ = "porch_post_media"
    __table_args__ = (UniqueConstraint("post_id", "position", name="uq_porch_post_media_position", deferrable=True, initially="DEFERRED"),)

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    alt_text: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    edit: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)


class PorchProfile(Base):
    __tablename__ = "porch_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    bio: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    show_birthday: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    birthday: Mapped[date | None] = mapped_column(Date, nullable=True)
    save_stories_to_photos: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    face_suggestions: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    feed_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    activity_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    welcomed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The audience picker's starting choice: "all" or a list of group ids.
    last_groups: Mapped[Any] = mapped_column(JSONB, nullable=True)
    # Per-kind push modes (on / summary / off), WP-P1.7.
    push: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = ["KINDS", "NOTIFY", "ROLES", "STATUSES", "PorchGroup", "PorchGroupMember", "PorchPost", "PorchPostGroup", "PorchPostMedia", "PorchProfile"]
