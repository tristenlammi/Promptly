"""ORM models for the MFA tables introduced by migration 0008."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


# Canonical method strings — kept as module constants so the auth flow,
# the schemas, and the audit log all reference the same literal.
METHOD_TOTP: Final[str] = "totp"
METHOD_EMAIL: Final[str] = "email"

# Purpose tags for the email_otp_challenges table.
OTP_PURPOSE_LOGIN: Final[str] = "login"
OTP_PURPOSE_ENROLLMENT: Final[str] = "enrollment"


class UserMfaSecret(UUIDPKMixin, Base):
    """One row per user when MFA enrollment has been started.

    The presence of a row does *not* by itself mean the user is
    enrolled — that's tracked by ``enrolled_at`` (and mirrored to
    ``users.mfa_enrolled_method`` once verification succeeds). This
    distinction matters: an attacker who somehow inserts a row here
    must still pass the "verify the first code" step before the login
    flow will gate on it.
    """

    __tablename__ = "user_mfa_secrets"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    # Fernet-encrypted base32 string. NULL for email-method users.
    totp_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_address: Mapped[str | None] = mapped_column(String(320), nullable=True)
    enrolled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    @property
    def is_enrolled(self) -> bool:
        return self.enrolled_at is not None

    def __repr__(self) -> str:
        return (
            f"<UserMfaSecret user={self.user_id} method={self.method} "
            f"enrolled={self.is_enrolled}>"
        )


class MfaBackupCode(UUIDPKMixin, CreatedAtMixin, Base):
    """One of (typically) ten one-shot recovery codes for a user."""

    __tablename__ = "mfa_backup_codes"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # bcrypt hash of the plaintext code. Plaintext is shown to the
    # user exactly once (right after they're generated) and never
    # stored anywhere.
    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    @property
    def is_used(self) -> bool:
        return self.used_at is not None


class MfaTrustedDevice(UUIDPKMixin, CreatedAtMixin, Base):
    """A device the user has marked as trusted to skip MFA for 30 days.

    The plaintext token lives in an HttpOnly cookie on the device; the
    DB only stores its sha256 hash, so a stolen DB dump can't be
    replayed against an active session.
    """

    __tablename__ = "mfa_trusted_devices"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    token_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    label: Mapped[str] = mapped_column(
        String(512), nullable=False, default="", server_default=""
    )
    ip: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    @property
    def is_expired(self) -> bool:
        from datetime import datetime as _dt
        from datetime import timezone as _tz

        return self.expires_at <= _dt.now(_tz.utc)


class EmailOtpChallenge(UUIDPKMixin, CreatedAtMixin, Base):
    """A short-lived one-time code emailed to the user.

    Two purposes:

    * ``login``      — issued during the MFA challenge step for users
                       whose enrolled method is ``email``.
    * ``enrollment`` — issued during the email-method enrollment wizard
                       to prove the user owns the address.

    A code is invalid once any of: ``expires_at`` is in the past,
    ``consumed_at`` is non-NULL, or ``attempts >= MAX_ATTEMPTS``.
    """

    __tablename__ = "email_otp_challenges"

    MAX_ATTEMPTS: Final[int] = 5

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # sha256 of the plaintext 6-digit code.
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ip: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )

    @property
    def is_consumed(self) -> bool:
        return self.consumed_at is not None
