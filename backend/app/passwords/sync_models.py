"""Browser sync: open tabs, sent tabs, history and the reading list (passwords/SYNC.md).

Every blob is encrypted on the client under a key only the person's own devices
can derive, bound to the record's kind, device and slot. The server sees which
device a record belongs to, a padded size, the day a history bucket is for, and
when each was written. Never a title or an address.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, LargeBinary, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin


class PwSyncState(Base):
    """One per person: a counter that orders their writes, and how long history is kept."""

    __tablename__ = "pw_sync_state"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    history_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90, server_default="90")


class PwSyncRecord(CreatedAtMixin, Base):
    """``kind`` is tabs, history, reading or sent. ``device_id`` is the browser a tabs or
    history record came from, or the device a sent tab is for; reading list entries have
    none. ``slot`` is empty for tabs, a ``YYYY-MM-DD`` day for history, and the entry's
    own id for reading and sent."""

    __tablename__ = "pw_sync_records"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", "device_id", "slot", name="uq_pw_sync_record_slot"),
        Index("ix_pw_sync_records_user_kind_rev", "user_id", "kind", "rev"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pw_devices.id", ondelete="CASCADE"), nullable=True)
    slot: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")
    blob: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
