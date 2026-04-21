"""ORM models for Web Push subscriptions + per-user category prefs.

Both models are intentionally narrow — the notifications feature
doesn't need fan-out, aggregation, or delivery receipts; the push
service itself handles retries and eventual delivery. All we store
is "who subscribed from where" and "what categories do they still
want to hear about"."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin


class PushSubscription(UUIDPKMixin, Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "endpoint", name="uq_push_subscriptions_user_endpoint"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Push service endpoint URL. Opaque to us — FCM, Mozilla autopush,
    # Apple push, ...; ``pywebpush`` picks the right ciphersuite based
    # on the URL host.
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)

    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class PushPreferences(Base):
    __tablename__ = "push_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    study_graded: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    export_ready: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    import_done: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    shared_message: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )
