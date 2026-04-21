"""Chat conversations + messages ORM models."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


class Conversation(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "conversations"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Model reference is stored as a free-form identifier (e.g. "anthropic/claude-3.5-sonnet")
    # so we can keep conversations around even if a provider is deleted.
    model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True
    )

    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    starred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Three-mode preference (Phase D1):
    #   "off"    — never search the web on this conversation
    #   "auto"   — expose the ``web_search`` tool, model decides per turn
    #   "always" — synthesise a forced ``web_search`` call before every
    #              assistant reply (the search appears in the chat as a
    #              tool chip, identical to the auto-mode UX)
    # Stored as a short string instead of a Postgres ENUM so we can add
    # new modes (``"deep"`` etc.) without DDL pain. The router defends
    # against unknown values by falling back to ``"off"``.
    web_search_mode: Mapped[str] = mapped_column(
        String(8), nullable=False, default="off", server_default="off"
    )

    # When True the user has renamed the conversation themselves and the
    # server must not auto-regenerate the title after subsequent turns. Set
    # by the title-PATCH endpoint; cleared only if we reset the conversation.
    title_manually_set: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Phase 4c — branching. Populated when this chat was forked from
    # another via ``POST /conversations/{id}/branch``. ``ON DELETE
    # SET NULL`` on both FKs (declared in the migration) keeps the
    # branch alive if the source chat is later deleted; the UI just
    # hides the "branched from" chip in that case.
    parent_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    parent_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    branched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Temporary chats (Phase Z1):
    #   * NULL          — permanent (the default; existing chats are all NULL).
    #   * "ephemeral"   — deleted as soon as the user navigates away.
    #                     Hidden from the sidebar listing entirely so they
    #                     can't be re-opened. A 24h backstop ``expires_at``
    #                     guards against orphans if the cleanup DELETE fails.
    #   * "one_hour"    — auto-deleted 1 hour after the last message.
    #                     Visible in the sidebar with a clock badge so the
    #                     user can find them while they're alive. The router
    #                     slides ``expires_at`` forward on every send.
    # Free-text VARCHAR rather than a Postgres ENUM so we can add modes
    # (``"one_day"``? ``"private_session"``?) without DDL pain. Unknown
    # values are treated as permanent at the API boundary.
    temporary_mode: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Chat Projects (0027). When non-NULL, this conversation belongs
    # to a project: the project's system prompt + pinned files are
    # mixed into the context on every send, and the chat shows up
    # under that project in the sidebar. NULL means "top-level chat"
    # (today's default). ``ON DELETE SET NULL`` so deleting a project
    # doesn't nuke chat history — the chats resurface at top level.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("chat_projects.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Compare mode (0029). Non-NULL for every column of a side-by-
    # side comparison; each column is a real conversation driven by
    # the normal send/stream pipeline, just linked together into a
    # group. The sidebar filters non-crowned compare columns out so
    # the main conversation list isn't cluttered with pre-crown
    # drafts. ``ON DELETE SET NULL`` so deleting the group detaches
    # columns rather than cascade-deleting history.
    compare_group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("compare_groups.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    def __repr__(self) -> str:
        return f"<Conversation id={self.id} title={self.title!r}>"


class CompareGroup(UUIDPKMixin, TimestampMixin, Base):
    """A side-by-side model-comparison session.

    One group bundles N (2–4) real ``conversations`` rows — one per
    column — and tracks which column the user ultimately "crowned".
    Before crowning, columns are equal peers; after crowning, the
    crowned conversation is treated as a normal chat in the sidebar
    and the losers remain accessible through the Compare archive
    view.
    """

    __tablename__ = "compare_groups"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The original prompt the user typed into the shared composer.
    # Kept for archive preview so the group doesn't need a messages
    # join on listing.
    seed_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    crowned_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<CompareGroup id={self.id} title={self.title!r}>"


class ChatProject(UUIDPKMixin, TimestampMixin, Base):
    """A generic project bundle for non-Study conversations.

    Holds the shared instructions + pinned files + default model used
    by every chat inside it. Distinct from :class:`StudyProject` —
    Study projects are learning paths with units/exams, chat projects
    are ChatGPT/Claude-style bundles for arbitrary ongoing work.
    """

    __tablename__ = "chat_projects"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Shared "instructions" for every chat in the project. Rendered as
    # a ``system`` role message at the top of each send's context so
    # the model obeys them turn-to-turn.
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Optional per-project model override. When NULL we fall back to
    # whatever the user's global picker says at send time.
    default_model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    default_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True
    )
    # NULL = active. A non-NULL timestamp is the single source of
    # truth for "in archive" — same pattern as study_projects.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<ChatProject id={self.id} title={self.title!r}>"


class ChatProjectFile(Base):
    """Pinned-file join row — attaches a :class:`UserFile` to a
    :class:`ChatProject` so every new conversation in the project
    gets the file auto-attached to its send context.

    Composite PK keeps (project, file) unique without a separate row
    id. ``ON DELETE CASCADE`` on both FKs (see the migration) keeps
    the join clean when either side goes away.
    """

    __tablename__ = "chat_project_files"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chat_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"),
        primary_key=True,
    )
    pinned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class Message(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # 'user' | 'assistant' | 'system'
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # Populated when the message was generated with web search on — list of
    # {title, url, snippet} dicts rendered as inline citations.
    sources: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Reserved for study-style messages that embed whiteboard actions; in
    # regular chats this stays null.
    whiteboard_actions: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Per-message performance metrics. Populated only on assistant rows
    # produced via streaming; all null for user / system messages and for
    # any stream that errored before usage was reported.
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Total spend on this single message (completion + tool invocations)
    # in USD micros. ``None`` for messages whose provider didn't report
    # a cost or for non-assistant rows.
    cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    # Attachments that the user picked via the paperclip modal. Stored as a
    # frozen list of lightweight metadata dicts (id, filename, mime_type,
    # size_bytes) so the UI can render chips even after the underlying file
    # row has been deleted. Populated only on `role = "user"` messages.
    attachments: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Author of the message (Phase 4b — shared conversations). For user
    # rows this is whoever actually pressed Send; for assistant / system
    # rows it stays NULL. Backfilled from ``conversations.user_id`` for
    # legacy rows so the UI's "from Jane" chip on shared chats has a
    # stable value to render. ``ON DELETE SET NULL`` keeps the message
    # if the author account is later removed.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    def __repr__(self) -> str:
        return f"<Message id={self.id} role={self.role}>"


class ConversationShare(UUIDPKMixin, TimestampMixin, Base):
    """Invite-or-collaboration row for shared conversations.

    One row per (conversation, invitee) pair. ``status`` walks
    ``pending -> accepted`` (invitee accepted) or
    ``pending -> declined`` (invitee dismissed). Owners revoking simply
    delete the row; the unique constraint on ``(conversation_id,
    invitee_user_id)`` then lets them re-invite later.

    Cost falls naturally on whichever account posts a turn — the chat
    router records usage against the authenticated sender — so this
    table only needs to model identity and consent.
    """

    __tablename__ = "conversation_shares"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # ``pending`` | ``accepted`` | ``declined``. Free-text rather than a
    # Postgres ENUM so we can add states later (``muted``?) without DDL.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "invitee_user_id",
            name="uq_conversation_shares_conv_invitee",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ConversationShare id={self.id} conv={self.conversation_id} "
            f"invitee={self.invitee_user_id} status={self.status!r}>"
        )
