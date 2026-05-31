"""ORM model for cross-chat memory (Roadmap v2 — Phase 6).

``UserMemory`` is a single durable fact about a user that should persist
across every conversation — e.g. a stated preference, role, or recurring
piece of context. Rows are injected (most-recent-first, capped) into the
chat system prompt and managed by the user from account settings.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class UserMemory(UUIDPKMixin, TimestampMixin, Base):
    """One remembered fact about a user."""

    __tablename__ = "user_memories"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # The fact itself, phrased as a short standalone statement.
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # How it got here: ``manual`` (user typed it / said "remember this")
    # vs ``auto`` (lifted by the post-turn extraction pass). Surfaced in
    # the management UI so a user can tell what the model inferred.
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="auto", server_default="auto"
    )

    # The conversation a captured fact originated from, for provenance.
    # Kept as a bare UUID (no hard FK) so deleting a chat doesn't
    # cascade-delete the memory it produced — the fact outlives the chat.
    source_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        nullable=True
    )

    # Category tag (Phase 2.1) — one of the four controlled values in
    # ``MEMORY_CATEGORIES`` (identity | preferences | projects | context)
    # or NULL for uncategorised facts. Set by the extraction model; the
    # user can also edit it manually. Stored as a plain string so it
    # survives future category additions without a migration.
    category: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Pinned facts (Phase 2.1) are always injected into every chat's
    # system prompt, regardless of the top-K retrieval cap. Intended for
    # the handful of things the user absolutely wants the assistant to
    # know at all times (e.g. their name, their primary language).
    pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Usage signals (Phase 3.1). Incremented each time this fact is
    # retrieved and injected into a chat's system prompt. Used to break
    # tie-breaks in retrieval (more-used facts preferred) and to guide
    # eviction at the 200-fact cap (rarely-used auto facts evicted first).
    times_used: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Semantic-retrieval embedding (Memory Overhaul Phase 1). The actual
    # ``embedding_768`` / ``embedding_1536`` pgvector columns exist in the
    # DB (migration 0060) but are NOT mapped here — like message_embeddings,
    # they're read/written via raw SQL with text-literal casts, since the
    # app image ships no pgvector Python type. We map only the scalar
    # bookkeeping columns. ``content_hash`` (md5 of embedded text) detects
    # edits; ``embed_dim`` records which vector column is populated. Both
    # NULL until embedded (or forever when embeddings aren't configured).
    embed_dim: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(32), nullable=True)

    def __repr__(self) -> str:
        return f"<UserMemory id={self.id} user={self.user_id} src={self.source}>"
