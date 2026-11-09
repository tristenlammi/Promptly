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
    # A poll's closing time (0271); NULL: never closes, or not a poll.
    poll_closes_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
    # The local day today's birthday pushes went (0272): claimed once a day.
    birthday_pushed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ------------------------------------------------------------------ talking (0271)


class PorchComment(UUIDPKMixin, CreatedAtMixin, Base):
    """A comment on a post, or a reply to one (``parent_id``: one level
    only — a reply to a reply hangs off the same top comment). Deleting
    one marks it (``deleted_at``) so a thread's replies keep their place."""

    __tablename__ = "porch_comments"

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("porch_comments.id", ondelete="CASCADE"), nullable=True)
    body: Mapped[str] = mapped_column(String(2000), nullable=False)
    mentions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PorchReaction(Base):
    """One person's reaction (one of a small fixed set of emoji) to a post or
    a comment. ``post_id`` is the post it's on either way."""

    __tablename__ = "porch_reactions"

    target_type: Mapped[str] = mapped_column(String(8), primary_key=True)  # post | comment
    target_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PorchPollOption(UUIDPKMixin, Base):
    __tablename__ = "porch_poll_options"
    __table_args__ = (UniqueConstraint("post_id", "position", name="uq_porch_poll_options_position"),)

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False)


class PorchPollVote(Base):
    """One vote each, changeable until the poll closes."""

    __tablename__ = "porch_poll_votes"

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    option_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_poll_options.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


TAG_STATUSES = ("pending", "approved", "declined")


class PorchTag(UUIDPKMixin, CreatedAtMixin, Base):
    """Someone tagged on one photo of a post, at a point (``box`` ``{x, y}``,
    shares of the picture as posted). It shows only once they say yes."""

    __tablename__ = "porch_tags"
    __table_args__ = (UniqueConstraint("media_id", "tagged_user_id", name="uq_porch_tags_media_user"),)

    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False)
    media_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_post_media.id", ondelete="CASCADE"), nullable=False)
    tagged_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tagged_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    box: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="pending", server_default="pending")
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PorchSave(Base):
    """Saved posts: a private collection."""

    __tablename__ = "porch_saves"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PorchAlert(Base):
    """"Notify me when they post" (pushes: WP-P1.7)."""

    __tablename__ = "porch_alerts"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PorchReport(UUIDPKMixin, CreatedAtMixin, Base):
    """A post or comment reported to the admins of the group it was seen in
    (``group_id``; NULL = Everyone, whose admins are the server admins).
    One row per reporter and group (WP-P1.7, WP-P2.0)."""

    __tablename__ = "porch_reports"

    reporter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # The group it was reported in (0392); NULL = Everyone.
    group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("porch_groups.id", ondelete="CASCADE"), nullable=True)
    target_type: Mapped[str] = mapped_column(String(8), nullable=False)  # post | comment (| story, later)
    target_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="open", server_default="open")
    handled_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    handled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # What the admin wrote when they handled it (0272); a removal's reason
    # is also kept with the removal, where the poster sees it.
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")


class PorchRemoval(UUIDPKMixin, CreatedAtMixin, Base):
    """A post or comment an admin took down (0272): a comment, gone for
    everyone (``scope='all'``), or a post taken out of one group only —
    Everyone by a server admin (``scope='everyone'``) or one of the poster's
    groups by its admins (``scope='group'``, ``group_id``; 0392). A post
    left in no group is deleted. The poster sees it in Activity with the
    reason; nobody else is told."""

    __tablename__ = "porch_removals"

    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    target_type: Mapped[str] = mapped_column(String(8), nullable=False)  # post | comment
    target_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    post_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=True)
    scope: Mapped[str] = mapped_column(String(8), nullable=False, default="all", server_default="all")
    group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("porch_groups.id", ondelete="SET NULL"), nullable=True)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    # A few words of what was removed, so the poster knows which one.
    snippet: Mapped[str] = mapped_column(String(200), nullable=False, default="", server_default="")
    removed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


# ------------------------------------------------------------------ stories (0393, WP-P2.1)

STORY_KINDS = ("photo", "video", "text")


class PorchStory(UUIDPKMixin, CreatedAtMixin, Base):
    """A photo, video or text story, gone from view 24 hours after it was
    posted (``expires_at``; read-time, no job). The row stays for your own
    archive and highlights. Who sees it: :func:`app.porch.access.visible_story`."""

    __tablename__ = "porch_stories"

    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    # Your own library photo or video; purging it ends the story.
    file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=True)
    # Its 9:16 crop for this story only (``photos/edits.py`` ops).
    edit: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    text: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    background: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Stickers: [{type: text|mention|place, x, y, scale, rotate, style, ...}].
    overlays: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    mentions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    alt_text: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PorchStoryGroup(Base):
    """The groups a story went to, fixed when it was posted."""

    __tablename__ = "porch_story_groups"

    story_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_stories.id", ondelete="CASCADE"), primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True)


class PorchStoryView(Base):
    """Someone saw a story. Only the poster ever sees the list."""

    __tablename__ = "porch_story_views"

    story_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("porch_stories.id", ondelete="CASCADE"), primary_key=True)
    viewer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = [
    "KINDS", "NOTIFY", "ROLES", "STATUSES", "STORY_KINDS", "TAG_STATUSES", "PorchAlert", "PorchComment", "PorchGroup", "PorchGroupMember",
    "PorchPollOption", "PorchPollVote", "PorchPost", "PorchPostGroup", "PorchPostMedia", "PorchProfile", "PorchReaction", "PorchRemoval",
    "PorchReport", "PorchSave", "PorchStory", "PorchStoryGroup", "PorchStoryView", "PorchTag",
]
