"""Tags — ORM.

* :class:`Tag` — one person's tag (name unique per person, ignoring case).
* :class:`TagAssignment` — a tag on one thing: ``entity_kind`` + ``entity_id``.
  Native kinds use the thing's id (``file``, ``event``, ``album``); things
  inside an Item Store file use ``"<file_id>:<id inside the file>"`` and set
  ``file_id``, so deleting the file drops its tags and the file's access
  rule decides who may see them. A tagged Drive file sets ``file_id`` too.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    # "#rrggbb", or None for the colour picked from the name.
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TagAssignment(Base):
    __tablename__ = "tag_assignments"
    __table_args__ = (
        UniqueConstraint("tag_id", "entity_kind", "entity_id", name="uq_tag_assignments_thing"),
        Index("ix_tag_assignments_entity", "user_id", "entity_kind", "entity_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tag_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    entity_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(120), nullable=False)
    file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
