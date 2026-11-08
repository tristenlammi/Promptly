"""ORM models for Web Push subscriptions + per-user category prefs.

Both models are intentionally narrow — the notifications feature
doesn't need fan-out, aggregation, or delivery receipts; the push
service itself handles retries and eventual delivery. All we store
is "who subscribed from where" and "what categories do they still
want to hear about"."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, String, Text, Time, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin


class Notification(UUIDPKMixin, Base):
    """One inbox row — the durable copy of a ``notify_user`` event.

    Push is the real-time nudge; this is what the in-app Inbox reads so
    mentions / assignments / invites / automation outcomes can be caught
    up on later. Rows are cheap and pruned per-user beyond a cap (see
    ``dispatch._persist``)."""

    __tablename__ = "notifications"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # mention | assignment | invite | task_complete | shared_message | …
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # In-app deep link, relative ("/workspaces/<id>?item=…").
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Who triggered it — the inbox row's avatar. SET NULL so account
    # deletion doesn't erase other people's history.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True
    )
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )


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
    export_ready: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    import_done: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    shared_message: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    task_complete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Collaboration events (0133): someone @-mentioned you, assigned you a
    # card, or invited you to a workspace. These gate the *push* only — the
    # inbox row is always written.
    mention: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    assignment: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    invite: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Reminders an item file asked for (0229).
    item_reminder: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Messages in Rooms (0230).
    room_message: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    mail: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # New-device approvals and shared-vault invites (0254). No vault data in these.
    passwords: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Calendar invites, changes and reminders (0231).
    calendar: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Notes (0261): someone shared a note with you. Reminders come from Tasks.
    notes: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Quiet hours (0320), in the person's own time zone. One setting for all
    # of Promptly; ``dispatch.RULES`` says which categories they may hold.
    # The weekend pair, when set, is used for quiet periods that end on a
    # Saturday or Sunday (Friday and Saturday nights).
    quiet_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    quiet_start: Mapped[time] = mapped_column(
        Time, nullable=False, default=time(22, 0), server_default="22:00"
    )
    quiet_end: Mapped[time] = mapped_column(
        Time, nullable=False, default=time(7, 0), server_default="07:00"
    )
    quiet_weekend_start: Mapped[time | None] = mapped_column(Time, nullable=True)
    quiet_weekend_end: Mapped[time | None] = mapped_column(Time, nullable=True)
    # Categories set to "Daily summary" instead of instant (0320).
    summary_categories: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    # The local day the daily summary last went out — claimed once a day.
    summary_sent_on: Mapped[date | None] = mapped_column(Date, nullable=True)
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


class PushHeld(UUIDPKMixin, Base):
    """A push kept back (0320): by quiet hours (``reason='quiet'``, sent when
    they end) or because its category is set to the daily summary
    (``reason='summary'``). ``notifications/loops.py`` sends them on as one
    push per app, or as counts in the daily summary — never stranger text
    in the summary. Push only: the inbox row was written when it happened."""

    __tablename__ = "push_held"
    __table_args__ = (Index("ix_push_held_user_reason", "user_id", "reason"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    tag: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The service worker's extra fields (icon, line, a per-app ``kind``).
    extra: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str] = mapped_column(String(8), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )
