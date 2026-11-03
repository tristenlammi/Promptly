"""Today — ORM: what each person opened lately (``recent_opens``)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RecentOpen(Base):
    """One thing one person opened, at its latest open. ``kind`` is one of
    :data:`app.today.recents.KINDS`; ``entity_id`` the id in that app
    (a file, a chat, a room, a workspace item). ``title`` is a snapshot,
    refreshed on read."""

    __tablename__ = "recent_opens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(24), primary_key=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = ["RecentOpen"]
