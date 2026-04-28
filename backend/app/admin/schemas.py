"""Pydantic schemas for the admin user-management API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

UserRole = Literal["admin", "user"]


class AdminUserResponse(BaseModel):
    """Expanded view of a user for the admin panel."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    username: str
    role: UserRole
    # NULL = full access to the admin-curated pool. Admins always have
    # full access regardless of this field.
    allowed_models: list[str] | None = None
    created_at: datetime

    # ----- Security state (Phase 1) -----
    failed_login_attempts: int = 0
    locked_at: datetime | None = None
    disabled: bool = False
    must_change_password: bool = False
    last_login_at: datetime | None = None
    last_login_ip: str | None = None

    # ----- Quota overrides (Phase 3) -----
    # NULL on any of these means "use the org-wide default from
    # app_settings". Admins may set 0 to revoke a user's spend
    # without disabling them outright (useful during offboarding).
    storage_cap_bytes: int | None = None
    daily_token_budget: int | None = None
    monthly_token_budget: int | None = None


class AdminUserUsageDay(BaseModel):
    """One row of the per-user daily usage rollup."""

    day: datetime  # serialised as date — Pydantic accepts both
    prompt_tokens: int
    completion_tokens: int
    messages_sent: int

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class AdminUserUsageResponse(BaseModel):
    """Per-user usage snapshot returned by ``GET /admin/users/{id}/usage``.

    The recent-history list is bounded so the admin UI doesn't have to
    paginate; ``daily_total`` and ``monthly_total`` are the values
    actually used for budget enforcement so the UI can render the same
    "X / Y" gauge the chat sees.
    """

    daily_used: int
    daily_cap: int | None
    monthly_used: int
    monthly_cap: int | None
    storage_used_bytes: int
    storage_cap_bytes: int | None
    history: list[AdminUserUsageDay]


class AuthEventResponse(BaseModel):
    """One row from the security audit log."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID | None
    identifier: str
    ip: str
    user_agent: str
    event_type: str
    detail: str | None
    created_at: datetime


class PasswordResetRequest(BaseModel):
    """Admin-initiated password reset.

    The new password is set, ``must_change_password`` is flipped on so
    the user is forced to change it on next login, and the user's
    ``token_version`` is bumped so any active session is killed.
    """

    password: str = Field(min_length=8, max_length=128)


class AppSettingsResponse(BaseModel):
    """Admin-visible global app settings.

    SMTP password is never echoed; instead a boolean flag tells the UI
    whether one is currently stored.
    """

    model_config = ConfigDict(from_attributes=True)

    mfa_required: bool

    smtp_host: str | None
    smtp_port: int | None
    smtp_username: str | None
    smtp_use_tls: bool
    smtp_from_address: str | None
    smtp_from_name: str | None
    smtp_password_set: bool
    smtp_configured: bool

    # ----- Phase 3 org-wide quota defaults -----
    # NULL on any of these means "no default — users without a
    # personal override are uncapped".
    default_storage_cap_bytes: int | None = None
    default_daily_token_budget: int | None = None
    default_monthly_token_budget: int | None = None

    # ----- Public origins (CORS allow-list, wizard-driven) -----
    # The fully-qualified origins the operator wants the API to
    # accept cross-origin requests from, in addition to the always-
    # allowed localhost defaults. Empty array on a fresh install —
    # the first-run wizard's "Public URL" step writes the first entry.
    public_origins: list[str] = Field(default_factory=list)

    updated_at: datetime


class AppSettingsUpdate(BaseModel):
    """PATCH payload for ``app_settings``.

    Every field is optional. ``smtp_password`` deserves special care:
      - omitted     → unchanged
      - empty str   → clear the stored password
      - non-empty   → encrypt + store

    The three quota defaults follow the standard "unset = unchanged,
    explicit null = clear (back to unlimited)" convention; the router
    consults ``model_fields_set`` to tell the two apart.
    """

    mfa_required: bool | None = None

    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_username: str | None = Field(default=None, max_length=255)
    smtp_password: str | None = Field(default=None, max_length=512)
    smtp_use_tls: bool | None = None
    smtp_from_address: EmailStr | None = None
    smtp_from_name: str | None = Field(default=None, max_length=128)

    # ge=0 (not ge=1) so an admin can park the org at "0 tokens for
    # everyone unless overridden" during a kill-switch incident.
    default_storage_cap_bytes: int | None = Field(default=None, ge=0)
    default_daily_token_budget: int | None = Field(default=None, ge=0)
    default_monthly_token_budget: int | None = Field(default=None, ge=0)

    # ----- Public origins (CORS allow-list) -----
    # Set from the first-run wizard's "Public URL" step and editable
    # later under Admin → Settings. The list-shape lets a deployment
    # with multiple ingress hostnames (e.g. an internal alias plus a
    # public DNS name) accept both. The router validates each entry
    # is a fully-qualified scheme://host[:port] before persisting.
    public_origins: list[str] | None = Field(default=None, max_length=20)


class AdminUserCreate(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    role: UserRole = "user"
    # None = full access (to the admin-curated pool). Provide a list to
    # restrict. Empty list = no models.
    allowed_models: list[str] | None = None
    # Per-user quota overrides. ``None`` (the default) leaves the user
    # on the org-wide settings; passing a number — including 0 — sets
    # an explicit override at create time.
    storage_cap_bytes: int | None = Field(default=None, ge=0)
    daily_token_budget: int | None = Field(default=None, ge=0)
    monthly_token_budget: int | None = Field(default=None, ge=0)


class AdminUserUpdate(BaseModel):
    """PATCH payload. Unset fields are left unchanged.

    ``allowed_models`` and the three quota fields share the same
    "tri-state" convention: omitted = unchanged, explicit ``null`` =
    revert to the org-wide default, list/integer = explicit override.
    The router consults ``model_fields_set`` to tell omitted from
    explicit-null.
    """

    model_config = ConfigDict(populate_by_name=True)

    email: EmailStr | None = None
    username: str | None = Field(
        default=None, min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$"
    )
    # Optional password reset. Minimum 8 like register.
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: UserRole | None = None
    allowed_models: list[str] | None = None

    # Quota overrides. ``ge=0`` (not ``ge=1``) so an admin can park a
    # user at "no tokens" without disabling the whole account.
    storage_cap_bytes: int | None = Field(default=None, ge=0)
    daily_token_budget: int | None = Field(default=None, ge=0)
    monthly_token_budget: int | None = Field(default=None, ge=0)


class AdminModelOption(BaseModel):
    """Lightweight model row shown in the admin "assign models" picker."""

    model_config = ConfigDict(protected_namespaces=())

    provider_id: uuid.UUID
    provider_name: str
    model_id: str
    display_name: str
    context_window: int | None = None


# --------------------------------------------------------------------
# Analytics (admin "Analytics" tab)
# --------------------------------------------------------------------
# All cost values are returned as float USD already converted from the
# integer ``cost_usd_micros`` columns at the API boundary, so the
# frontend never has to think about micros.


class AnalyticsSummary(BaseModel):
    """Headline numbers for the analytics dashboard.

    All ``*_today`` / ``*_window`` figures are computed against the
    ``usage_daily`` rollup, not the raw ``messages`` table, so the
    cost stays bounded even for very chatty users.
    """

    window_days: int

    total_users: int
    active_users_window: int

    messages_today: int
    messages_window: int

    prompt_tokens_window: int
    completion_tokens_window: int
    total_tokens_window: int

    cost_usd_today: float
    cost_usd_window: float


class AnalyticsTimeseriesPoint(BaseModel):
    """One row per day for the headline trend chart."""

    day: datetime
    messages: int
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float


class AnalyticsUserRow(BaseModel):
    """Per-user roll-up for the "top users" table."""

    user_id: uuid.UUID
    username: str
    email: EmailStr
    messages_window: int
    prompt_tokens_window: int
    completion_tokens_window: int
    cost_usd_window: float
    last_active_at: datetime | None


class AnalyticsModelRow(BaseModel):
    """Per-model roll-up for the "by model" table."""

    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    messages_window: int
    prompt_tokens_window: int
    completion_tokens_window: int
    cost_usd_window: float


# --------------------------------------------------------------------
# Observability (admin "Console" tab)
# --------------------------------------------------------------------
class ErrorEventRow(BaseModel):
    """One captured exception row."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    fingerprint: str
    level: str
    logger: str
    exception_class: str | None
    message: str
    route: str | None
    method: str | None
    status_code: int | None
    request_id: str | None
    user_id: uuid.UUID | None
    resolved_at: datetime | None


class ErrorEventDetail(ErrorEventRow):
    """Single error with its stack + extra payload."""

    stack: str | None
    extra: dict[str, Any] | None


class ErrorGroupRow(BaseModel):
    """One row per unique fingerprint for the grouped issues view."""

    fingerprint: str
    level: str
    logger: str
    exception_class: str | None
    sample_message: str
    occurrences: int
    last_seen_at: datetime
    first_seen_at: datetime
    resolved: bool
