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

    # DeepSeek-only reasoning knob. The chat router attaches
    # ``thinking`` + ``reasoning_effort`` request fields to the
    # outbound payload when the active provider is DeepSeek and this
    # column is non-NULL; otherwise it stays out of the wire shape so
    # non-DeepSeek providers don't choke on unknown params.
    #   * NULL    — fall back to the provider's API-side default. Also
    #               the right state for every non-DeepSeek conversation.
    #   * "off"   — send ``thinking: {"type": "disabled"}`` (fast,
    #               non-thinking V4).
    #   * "low" / "medium" / "high" — send ``thinking: enabled`` plus
    #               the matching ``reasoning_effort`` value.
    # Free-form ``varchar(8)`` instead of a Postgres ENUM so a future
    # DeepSeek API revision (or a different provider that adopts the
    # same shape) can introduce new effort levels without DDL.
    reasoning_effort: Mapped[str | None] = mapped_column(
        String(8), nullable=True, default=None
    )

    # Phase 1 — per-conversation custom instructions / system prompt.
    # A free-text steer ("answer concisely", "you're a Rust expert")
    # the owner can set without spinning up a Project. Merged into the
    # outbound system prompt by the chat router (it takes precedence
    # over the project-level prompt but sits under tool/personal-context
    # layers). NULL / blank = no per-chat steer.
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Phase 9 — per-conversation memory capture pause. When True, the
    # auto-capture pass is skipped for this chat. Existing memories are
    # still injected normally; this only stops new facts being extracted.
    memory_capture_paused: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # When True the user has renamed the conversation themselves and the
    # server must not auto-regenerate the title after subsequent turns. Set
    # by the title-PATCH endpoint; cleared only if we reset the conversation.
    title_manually_set: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # True once we've re-generated the title with deeper context (around
    # the 5-message mark). One-shot: the first auto-title fires after the
    # opening exchange off thin context; this lets us sharpen it once the
    # conversation has a real shape, without re-titling on every turn.
    title_refined: Mapped[bool] = mapped_column(
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

    # Phase 2.6 — in-thread regeneration versioning. Points at the
    # currently-visible leaf message; the visible thread is reconstructed
    # by walking ``Message.parent_id`` from this leaf up to the root and
    # reversing. NULL on legacy/empty conversations, in which case the
    # readers fall back to plain ``created_at`` ordering. Self-heals via
    # the 0054 backfill migration. ``SET NULL`` on delete so dropping the
    # leaf row never dangles the FK.
    active_leaf_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
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

    # Phase C summary cache (migration 0030). Populated lazily by
    # :func:`app.chat.summariser.get_or_generate_summary` the first
    # time another chat references this one via ``@[title](id)``.
    # Treated as stale when the latest message's ``created_at`` is
    # newer than ``summary_generated_at``; the resolver regenerates
    # in-place at that point.
    summary_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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

    # RAG indexing lifecycle — mirrors ``custom_model_files`` so the
    # project Files tab can render the same "indexing… → ready / failed"
    # chips. ``queued`` until the background ingester picks the file up;
    # only text-extractable files (PDF / text) are ever indexed (images
    # stay on the attachment/vision path and keep status ``queued``,
    # which the retrieval layer simply ignores).
    indexing_status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="queued",
        server_default="queued",
    )
    indexing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    indexed_content_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Message(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Phase 2.6 — in-thread regeneration versioning. The message that
    # immediately precedes this one in its lineage. Messages sharing a
    # ``parent_id`` are *sibling versions* (e.g. the original answer and
    # a regenerated one, or an original user turn and an edited copy).
    # NULL only for the conversation's root message. ``SET NULL`` on
    # delete so deleting a parent doesn't cascade away its alternatives.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # 'user' | 'assistant' | 'system'
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # DeepSeek thinking-mode chain-of-thought. Captured from
    # ``delta.reasoning_content`` on streamed responses and replayed
    # to DeepSeek on subsequent turns — the API 400s on tool-call
    # follow-up turns when this is missing (see migration
    # ``0049_msgs_reasoning`` for the docs link). Other providers
    # don't emit it (column stays NULL) and don't accept it as input
    # (stripped in ``provider.py`` before send for non-DeepSeek
    # requests). Populated only on ``role = "assistant"`` rows.
    reasoning_content: Mapped[str | None] = mapped_column(Text, nullable=True)

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

    # Stamped by the in-place edit endpoint so the UI can render a
    # subtle "edited" badge on retroactively rewritten assistant
    # replies. NULL on every row that's still in its original state.
    # The edit-and-resend flow does NOT touch this column (it
    # rewrites text + re-streams a fresh assistant turn, which is
    # semantically a regenerated message rather than an edited one).
    edited_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Phase 2.5 — per-response quality signal. ``"up"`` / ``"down"`` /
    # NULL (no rating). Set by the conversation owner via the thumbs
    # affordance on assistant replies; ``feedback_reason`` carries the
    # optional short note captured on a thumbs-down. Both NULL on user /
    # system rows and on un-rated assistant replies.
    feedback: Mapped[str | None] = mapped_column(String(8), nullable=True)
    feedback_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<Message id={self.id} role={self.role}>"


class ProjectShare(UUIDPKMixin, TimestampMixin, Base):
    """Invite / membership row for shared chat projects (migration 0031).

    Same ``pending → accepted`` / ``pending → declined`` lifecycle, a
    unique ``(project_id, invitee_user_id)`` constraint, and the same
    "delete the row to revoke" policy.

    Semantically this is a *much bigger grant* than a single-chat
    share, though: accepting a project invite gives the invitee
    **complete access** to every conversation under that project
    (past + future), the project's pinned files, and the system-
    prompt settings. The resolver in ``app/chat/shares.py`` walks
    this table as a second path alongside conversation-level
    shares when answering "can this user read this conversation?".
    """

    __tablename__ = "project_shares"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chat_projects.id", ondelete="CASCADE"), nullable=False
    )
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "invitee_user_id",
            name="uq_project_shares_project_invitee",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ProjectShare id={self.id} project={self.project_id} "
            f"invitee={self.invitee_user_id} status={self.status!r}>"
        )


class MessageEmbedding(TimestampMixin, Base):
    """Per-message embedding vector for semantic conversation search
    (Phase 7).

    One row per indexed message, populated asynchronously by the
    background semantic indexer. Stores the vector in the column matching
    the workspace embedding dim (``embedding_768`` / ``embedding_1536``,
    mirroring ``knowledge_chunks``); those columns are managed via raw
    SQL and intentionally not mapped here. ``content_hash`` lets the
    indexer detect edits and re-embed only what changed.
    """

    __tablename__ = "message_embeddings"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    content_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    embed_dim: Mapped[int] = mapped_column(Integer, nullable=False)

    def __repr__(self) -> str:
        return (
            f"<MessageEmbedding msg={self.message_id} dim={self.embed_dim}>"
        )
