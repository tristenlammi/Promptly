"""Saved prompt (reusable template) ORM model — Phase 3.1."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class SavedPrompt(UUIDPKMixin, TimestampMixin, Base):
    """A user's reusable prompt / template, invokable via ``/`` in the
    composer. Owned by exactly one user; no sharing in v1."""

    __tablename__ = "saved_prompts"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Short label shown in the slash menu + manage list.
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    # The prompt text inserted into the composer when picked.
    body: Mapped[str] = mapped_column(Text, nullable=False)

    def __repr__(self) -> str:
        return f"<SavedPrompt id={self.id} title={self.title!r}>"
