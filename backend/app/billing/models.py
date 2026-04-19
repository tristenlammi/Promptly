"""ORM model for the daily token-usage rollup.

One row per ``(user_id, day)``. Updated by ``billing.usage.record_usage``
after every successful stream. Aggregations for budget enforcement and
the admin "usage" view are read straight off this table — no SUM over
the ``messages`` table on the hot path.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, func
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UsageDaily(Base):
    """Composite-PK rollup keyed by ``(user_id, day)``."""

    __tablename__ = "usage_daily"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)

    # The token figures the LLM reported for the user's turn(s) on
    # ``day``. ``None`` from the provider becomes 0 so a sloppy provider
    # can't poison the rollup by dropping the count.
    prompt_tokens: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    completion_tokens: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )

    # Number of user-initiated chat turns observed on ``day``. Powers
    # the admin "messages today" column without needing a second query.
    messages_sent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    # USD cost in *micros* (1 = $0.000001). Stored as integer so we can
    # SUM() losslessly across millions of rows. The application layer
    # converts to/from float dollars at the API boundary.
    cost_usd_micros: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    @property
    def total_tokens(self) -> int:
        return (self.prompt_tokens or 0) + (self.completion_tokens or 0)

    def __repr__(self) -> str:
        return (
            f"<UsageDaily user={self.user_id} day={self.day} "
            f"prompt={self.prompt_tokens} completion={self.completion_tokens}>"
        )
