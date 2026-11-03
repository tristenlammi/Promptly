"""Trash entries — deleted things from apps that used to hard-delete.

Drive files/folders, workspace items and workspaces already soft-delete
(``trashed_at``); the unified trash reads those in place. Everything else
— a calendar event, an album, a task or contact inside an item file — is
removed from where it lived as before, and a snapshot of it lands here so
it can be put back. Live queries in those apps don't change at all.

``user_id`` is whose trash it shows in (the owner of the thing);
``deleted_by`` is who deleted it (sees it too, when it's someone else).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TrashEntry(Base):
    __tablename__ = "trash_entries"
    __table_args__ = (
        Index("ix_trash_entries_user_deleted", "user_id", "deleted_at"),
        Index("ix_trash_entries_container", "container_id"),
        CheckConstraint(
            "kind IN ('calendar_event', 'album', 'task', 'contact')", name="ck_trash_entries_kind"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # calendar_event | album | task | contact
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # The deleted thing's own id (a uuid, or a record id inside an item file).
    source_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # Where it lived: the calendar, or the item file (no FK — it may go too).
    container_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    # Where it lived, for people ("My calendar", "Tasks · Work").
    location: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    deleted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = ["TrashEntry"]
