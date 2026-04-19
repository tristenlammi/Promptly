"""ORM model for the ``error_events`` table.

One row per captured exception (any 5xx, plus any explicit
``logger.error`` call once the :class:`DbErrorHandler` is installed).
Grouping into "issues" happens at query time via ``fingerprint``.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ErrorEvent(Base):
    __tablename__ = "error_events"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    level: Mapped[str] = mapped_column(String(16), nullable=False)
    logger: Mapped[str] = mapped_column(String(128), nullable=False)
    exception_class: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    stack: Mapped[str | None] = mapped_column(Text, nullable=True)

    route: Mapped[str | None] = mapped_column(String(255), nullable=True)
    method: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    extra: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    def __repr__(self) -> str:
        return (
            f"<ErrorEvent id={self.id} level={self.level} "
            f"logger={self.logger} class={self.exception_class}>"
        )
