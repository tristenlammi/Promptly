"""One connection between two things anywhere in Promptly (0234_links)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin


class EntityLink(UUIDPKMixin, Base):
    """``source`` mentions / is linked to ``target``.

    ``mention`` rows belong to their source's text (rewritten whenever it's
    saved or sent); ``link`` rows are made by hand, are two-way, and are
    stored once with the pair in a canonical order. No titles here — each
    side is read live, as the viewer can see it."""

    __tablename__ = "entity_links"
    __table_args__ = (
        CheckConstraint("link_type IN ('mention', 'link')", name="ck_entity_links_type"),
        UniqueConstraint("link_type", "source_kind", "source_id", "target_kind", "target_id", name="uq_entity_links"),
    )

    source_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    source_id: Mapped[str] = mapped_column(String(120), nullable=False)
    target_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    target_id: Mapped[str] = mapped_column(String(120), nullable=False)
    link_type: Mapped[str] = mapped_column(String(8), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
