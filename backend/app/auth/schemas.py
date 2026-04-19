"""Pydantic schemas for the auth module."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

UserRole = Literal["admin", "user"]


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)


class SetupRequest(BaseModel):
    """First-run bootstrap payload.

    Identical in shape to RegisterRequest but handled by a dedicated endpoint
    that is only callable while the DB has zero admins. The resulting user is
    promoted straight to `role="admin"`.
    """

    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)


class SetupStatusResponse(BaseModel):
    requires_setup: bool


class LoginRequest(BaseModel):
    """Login payload.

    Historically the field was ``identifier`` (email or username). The frontend
    sends ``email`` — accept both for backwards compatibility and clamp to a
    single canonical ``identifier`` attribute for the router to consume.
    """

    model_config = ConfigDict(populate_by_name=True)

    identifier: str = Field(default="", min_length=0, max_length=320)
    email: str | None = Field(default=None, max_length=320)
    password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def _coerce_identifier(self) -> "LoginRequest":
        if not self.identifier and self.email:
            self.identifier = self.email
        if not self.identifier:
            raise ValueError("identifier or email is required")
        return self


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    username: str
    role: UserRole
    # NULL = full access to the admin's curated pool. Admins effectively
    # ignore this field (they always see everything).
    allowed_models: list[str] | None = None
    settings: dict[str, Any]
    created_at: datetime
    # Surfaced so the frontend can route the user to a password-change
    # screen on next login when the admin reset their password.
    must_change_password: bool = False
    # Shown in the user's own profile.
    last_login_at: datetime | None = None


class UserPreferencesUpdate(BaseModel):
    """Body for ``PATCH /api/auth/me/preferences``.

    Every field is optional — the endpoint merges the supplied keys
    into ``user.settings``, leaving everything else untouched. Keep the
    set of recognised keys narrow on purpose: ``settings`` is a JSONB
    grab-bag and we don't want random clients dumping arbitrary blobs
    into it. Adding a new preference is a one-line edit here.

    Currently tracked:

    * ``default_tools_enabled`` — initial state of the per-chat Tools
      toggle. Defaults to ON for new accounts so the AI can actually
      use the artefact tools without the user discovering a hidden
      switch first.
    * ``default_web_search_mode`` — initial state of the per-chat Web
      Search three-mode picker. One of ``"off"`` | ``"auto"`` |
      ``"always"``. Defaults to ``"auto"`` for new accounts: the model
      decides per turn via the ``web_search`` tool, which is the right
      balance between "always pay for search" and "user has to remember
      to flip a switch before asking a current-events question".
    * ``location`` — free-form locality string (e.g.
      ``"Sunshine Coast, QLD, Australia"``). Surfaces silently in the
      chat system prompt as ambient context so the model "just knows"
      the user's region without anyone having to retell it. Capped at
      120 chars to keep the prompt overhead negligible. Pass an empty
      string to clear.
    * ``timezone`` — IANA zone name (e.g. ``"Australia/Brisbane"``).
      Drives the "current local time" snippet of the same ambient
      context block. Validated against the host's ``zoneinfo`` DB at
      patch time so an invalid value doesn't silently reach the
      prompt builder. Pass an empty string to clear.
    """

    model_config = ConfigDict(extra="forbid")

    default_tools_enabled: bool | None = None
    default_web_search_mode: Literal["off", "auto", "always"] | None = None
    # ``...`` here would force the field to always be present; instead
    # we accept ``None`` (no change) and ``""`` (clear). The field
    # validators normalise both inputs.
    location: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("location")
    @classmethod
    def _normalise_location(cls, v: str | None) -> str | None:
        # Trim whitespace so ``"  "`` round-trips to a clear, and so
        # leading/trailing spaces never leak into the system prompt.
        if v is None:
            return None
        v = v.strip()
        return v  # empty string means "clear this field"

    @field_validator("timezone")
    @classmethod
    def _validate_timezone(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if v == "":
            return ""
        try:
            ZoneInfo(v)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(
                f"Unknown timezone {v!r} — must be a valid IANA zone name "
                "(e.g. 'Australia/Brisbane')."
            ) from exc
        return v


class AuthResponse(BaseModel):
    """Login / register response — user + access token in one payload.

    The ``status`` discriminator lets the frontend type-narrow:

    * ``"ok"``                       — real session, ``access_token``
                                        + ``user`` populated.
    * ``"mfa_required"``             — second factor needed; ``user`` /
                                        ``access_token`` are absent and
                                        ``challenge_token`` carries the
                                        short-lived JWT to POST at
                                        /auth/mfa/verify.
    * ``"mfa_enrollment_required"``  — first-factor OK but the user has
                                        no method enrolled while
                                        ``app_settings.mfa_required`` is
                                        on. Walk them through the
                                        enrollment wizard with
                                        ``enrollment_token``.
    """

    status: Literal["ok", "mfa_required", "mfa_enrollment_required"] = "ok"
    user: UserResponse | None = None
    access_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    # MFA challenge fields. Only populated when status != "ok".
    challenge_token: str | None = None
    enrollment_token: str | None = None
    method: Literal["totp", "email"] | None = None
    # Masked email destination shown when method == "email".
    email_hint: str | None = None
