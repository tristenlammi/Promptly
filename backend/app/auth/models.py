"""User + Organization ORM models."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class Organization(UUIDPKMixin, CreatedAtMixin, Base):
    """A tenant. Every account is an Organization (a solo user is just a 1-seat
    org). Shadow of a Clerk Organization — Clerk owns membership/billing; this
    row anchors app-side foreign keys (providers, workspaces) and the seat/plan
    mirror. Auto-created for each account at sign-up (Clerk 'create first
    organization automatically')."""

    __tablename__ = "organizations"

    clerk_org_id: Mapped[str | None] = mapped_column(
        String(255), unique=True, nullable=True, index=True, default=None
    )
    name: Mapped[str] = mapped_column(
        String(255), nullable=False, default="Organization"
    )
    # Mirror of the Clerk subscription so the backend can gate without a Clerk
    # API call per request. Synced by billing webhooks (later step).
    plan: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    seat_limit: Mapped[int | None] = mapped_column(
        Integer, nullable=True, default=None
    )
    # Org-wide storage cap (bytes). NULL → fall back to the app default.
    storage_cap_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, default=None
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


class User(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # External identity link when AUTH_PROVIDER="clerk". NULL for built-in
    # (password) accounts. Unique so a Clerk user maps to exactly one local
    # shadow row. The local row still owns all app-specific state (role,
    # allowed_models, quotas, org membership); Clerk only owns authentication.
    clerk_user_id: Mapped[str | None] = mapped_column(
        String(255), unique=True, nullable=True, index=True, default=None
    )

    # Tenant membership. Every account belongs to exactly one Organization (its
    # own solo org, or the org they were invited to). NULL only transiently
    # before the org is synced. ``org_role`` = "admin" (owner / can configure
    # providers + invite) or "member" (uses inherited models, no settings).
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        default=None,
    )
    org_role: Mapped[str | None] = mapped_column(
        String(16), nullable=True, default=None
    )

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
        """True if a brute-force lockout is currently in force.

        Lockouts auto-expire ``LOCKOUT_COOLDOWN_MINUTES`` after ``locked_at``
        (0 = never, i.e. permanent until an admin unlock). The stale
        ``locked_at`` row isn't cleared here — the next login attempt (or an
        admin unlock) does that. This property only stops an already-expired
        lock from refusing live requests in ``get_current_user``.
        """
        if self.locked_at is None:
            return False
        from app.config import get_settings

        cooldown = get_settings().LOCKOUT_COOLDOWN_MINUTES
        if cooldown <= 0:
            return True
        from datetime import datetime, timedelta, timezone

        expires_at = self.locked_at + timedelta(minutes=cooldown)
        return datetime.now(timezone.utc) < expires_at

    def __repr__(self) -> str:
        return f"<User id={self.id} username={self.username!r} role={self.role}>"
