"""ORM model for cross-chat memory (Roadmap v2 — Phase 6).

``UserMemory`` is a single durable fact about a user that should persist
across every conversation — e.g. a stated preference, role, or recurring
piece of context. Rows are injected (most-recent-first, capped) into the
chat system prompt and managed by the user from account settings.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, Text
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

    def __repr__(self) -> str:
        return f"<UserMemory id={self.id} user={self.user_id} src={self.source}>"
