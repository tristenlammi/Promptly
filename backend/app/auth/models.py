"""User ORM model."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class User(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # "admin" (full access + can manage users/providers) or "user" (chat only,
    # restricted by allowed_models).
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, default="user", server_default="user"
    )

    # Per-user whitelist of model IDs surfaced in the chat model picker.
    # NULL  = full access to the admin's curated pool (providers.enabled_models).
    # []    = explicit "no access".
    # [...] = subset of the admin's curated pool.
    # Ignored for admins (they always see everything).
    allowed_models: Mapped[list[str] | None] = mapped_column(
        JSONB, nullable=True, default=None
    )

    # User settings: default_model, default_search_on, preferred_search_provider, theme, ...
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # ------------------------------------------------------------------
    # Account security state (added in 0007_security_foundation)
    # ------------------------------------------------------------------
    # Counter of consecutive failed login attempts. Reset to 0 on success.
    # When it reaches the configured threshold, ``locked_at`` is set and
    # subsequent logins are refused until an admin unlocks the account.
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Non-null = account is locked. Cleared by admin unlock.
    locked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Hard-disabled by an admin. Refused at login *and* at every
    # authenticated request (no waiting for the access token to expire).
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Force the user through a password-change screen on next login.
    # Set when an admin creates an account (so the temp password isn't
    # sticky) or after an admin reset.
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Embedded in every JWT (`tv` claim). When the value here doesn't
    # match the value in the token, the token is rejected. Bumping it
    # is how we instantly log a user out everywhere — used on lockout,
    # disable, password change, MFA reset, and the explicit "log out
    # everywhere" button.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Surfaced in the user's own profile + admin user table so suspicious
    # logins are easy to notice.
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    last_login_ip: Mapped[str | None] = mapped_column(
        String(64), nullable=True, default=None
    )

    # ------------------------------------------------------------------
    # MFA enrollment status (added in 0008_mfa)
    # ------------------------------------------------------------------
    # Denormalised mirror of ``user_mfa_secrets.method`` (only set after
    # the user has *verified* their first code). NULL → not enrolled.
    # Kept here so the login hot path can answer "do I need to challenge
    # this user?" with a single SELECT, no joins.
    mfa_enrolled_method: Mapped[str | None] = mapped_column(
        String(16), nullable=True, default=None
    )
    mfa_enrolled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    # ------------------------------------------------------------------
    # Quota overrides (added in 0009_phase3_quotas)
    # ------------------------------------------------------------------
    # NULL on every column means "fall back to the org-wide default"
    # configured in ``app_settings``. A non-NULL value here always wins
    # (including 0, which is "this user gets nothing"). All three are
    # BIGINT so ``cap > used`` comparisons can never overflow.
    storage_cap_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, default=None
    )
    daily_token_budget: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, default=None
    )
    monthly_token_budget: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, default=None
    )

    @property
    def has_mfa(self) -> bool:
        return self.mfa_enrolled_method is not None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_locked(self) -> bool:
        return self.locked_at is not None

    def __repr__(self) -> str:
        return f"<User id={self.id} username={self.username!r} role={self.role}>"
