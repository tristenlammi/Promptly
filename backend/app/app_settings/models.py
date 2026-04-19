"""ORM model for the single ``app_settings`` row."""
from __future__ import annotations

import uuid
from datetime import datetime

from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Hardcoded primary key for the singleton row. Must match the value
# seeded by Alembic migration 0007.
SINGLETON_APP_SETTINGS_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


class AppSettings(Base):
    """One row, always present. Loaded with ``db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)``."""

    __tablename__ = "app_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=SINGLETON_APP_SETTINGS_ID
    )

    # ----- MFA -----
    # Master switch. Off by default. When the admin flips it on, every
    # user without MFA already enrolled is force-routed to enrollment
    # on their next login. Existing sessions are not invalidated.
    mfa_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # ----- SMTP (used for 2FA emails + future transactional mail) -----
    smtp_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    smtp_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Fernet-encrypted at rest. NULL when no SMTP server is configured.
    smtp_password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    smtp_use_tls: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    smtp_from_address: Mapped[str | None] = mapped_column(String(320), nullable=True)
    smtp_from_name: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # ----- Org-wide quota defaults (Phase 3) -----
    # Applied to any user whose own override on ``users`` is NULL.
    # NULL here too means "no limit at all" — so a fresh deploy keeps
    # the existing behaviour until an admin sets a number.
    default_storage_cap_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    default_daily_token_budget: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    default_monthly_token_budget: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    # { "<user_uuid>": {"daily": "YYYY-MM-DD", "monthly": "YYYY-MM"} }
    # Tracks which 80% admin-warning emails have already gone out so
    # we don't notify on every chat turn after the threshold trips.
    # The key is the period that's been alerted; bumping period reopens
    # alerting automatically.
    budget_alerts_sent: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # ----- Bookkeeping -----
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    @property
    def smtp_configured(self) -> bool:
        """True when we have at least the bare minimum to send mail."""
        return bool(
            self.smtp_host
            and self.smtp_port
            and self.smtp_from_address
        )

    def __repr__(self) -> str:
        return (
            f"<AppSettings mfa_required={self.mfa_required} "
            f"smtp_configured={self.smtp_configured}>"
        )
