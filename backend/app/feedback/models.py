"""A message someone wrote to this server's admins (``feedback_messages``, 0424)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin


class FeedbackMessage(UUIDPKMixin, Base):
    """The words and who wrote them, nothing about where they were in the
    app. SET NULL on the sender: the admin keeps what they were told after
    an account is removed."""

    __tablename__ = "feedback_messages"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    # When an admin marked it read; NULL = unread.
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
