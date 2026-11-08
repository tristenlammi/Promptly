"""Expiry reminders: the one Passwords table that knowingly holds plaintext.

Each row is a Calendar event and/or a task made for one vault item's expiry date,
after the person turned it on. It holds what Calendar and Tasks already show: a
short label and the date. Nothing else from the item, and never a number or secret
(the client and ``reminders.clean_label`` both strip them). ``test_passwords_alerts``
pins these columns, so anything added here is a deliberate change.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class PwReminder(UUIDPKMixin, CreatedAtMixin, Base):
    """``item_id`` isn't a foreign key: an item can go (purged, its vault deleted, the
    person removed) in ways that don't pass through sync, and the hourly sweep then
    takes the event and task away too."""

    __tablename__ = "pw_reminders"
    __table_args__ = (UniqueConstraint("user_id", "item_id", name="uq_pw_reminders_user_item"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    item_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    expires_on: Mapped[date] = mapped_column(Date, nullable=False)
    weeks: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    calendar: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    task: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # The event on the day, and the heads-up event some weeks before. NULL once deleted in Calendar.
    event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True)
    early_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True)
    task_file_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


__all__ = ["PwReminder"]
