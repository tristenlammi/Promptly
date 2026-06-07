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


class DirectoryUser(BaseModel):
    """Minimal user row surfaced by the ``@``-picker in share dialogs.

    Deliberately shaped like :class:`app.chat.shares.ShareUserBrief`
    (``user_id`` / ``username`` / ``email``) so the existing share
    creation flow can send the same payload back. Sensitive fields
    (role, settings, login telemetry) are omitted — the directory is
    available to every authenticated user, not just admins, so we
    only expose what's needed to pick someone to share with.
    """

    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    username: str
    email: EmailStr


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
    * ``default_model_id`` / ``default_provider_id`` — preferred model
      every NEW chat starts with. Stored as strings (provider id is a
      UUID, kept stringly to round-trip cleanly through JSONB and the
      ``""``-means-clear convention shared by the other prefs). The
      pair is treated atomically by the frontend — choosing a default
      always sends both. Existing chats are unaffected; the picker on
      a loaded conversation reflects ``conversation.model_id`` /
      ``provider_id`` instead, so swapping models mid-chat doesn't
      leak into the next new chat.
    """

    model_config = ConfigDict(extra="forbid")

    default_tools_enabled: bool | None = None
    default_web_search_mode: Literal["off", "auto", "always"] | None = None
    # ``...`` here would force the field to always be present; instead
    # we accept ``None`` (no change) and ``""`` (clear). The field
    # validators normalise both inputs.
    location: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)
    default_model_id: str | None = Field(default=None, max_length=128)
    default_provider_id: str | None = Field(default=None, max_length=64)
    # Per-user interface curation: the set of *optional* top-level nav
    # surfaces this user has chosen to hide from their sidebar. Purely
    # cosmetic — hiding a section doesn't disable the underlying feature
    # or its routes, it just declutters the nav. Unknown keys are dropped
    # so a stale client can't poison the list. ``[]`` = show everything.
    hidden_nav: list[str] | None = None
    # Master switch for cross-chat memory (Phase 6). When off, the
    # post-turn extraction pass is skipped and saved facts are not
    # injected into the system prompt. Absent = on (the default).
    # Retained for backwards compatibility; ``memory_mode`` supersedes it.
    memory_enabled: bool | None = None
    # Memory behaviour (supersedes ``memory_enabled``):
    #   * ``"off"``    — never inject, never auto-capture.
    #   * ``"auto"``   — inject saved facts AND auto-capture durable ones.
    #   * ``"manual"`` — inject saved facts, but only the user adds them;
    #     the post-turn auto-capture pass is skipped. Lets a user curate
    #     their own persona without the AI volunteering facts.
    memory_mode: Literal["off", "auto", "manual"] | None = None
    # Conversations the user has hidden from *their own* sidebar. Used as
    # a "remove from my history" that never touches another user's copy
    # (e.g. a chat that reached them before per-chat sharing was retired,
    # which they don't own and so can't delete). Stored as id strings.
    hidden_conversations: list[str] | None = None
    # Account-wide custom system prompt. Free-text persona / standing
    # instructions ("always reply in British English", "be terse") that
    # get injected into the system prompt of EVERY new chat. The global
    # counterpart to per-conversation ``system_prompt`` and per-project
    # ``instructions``; both of those take precedence over this. ``None``
    # = no change, ``""`` (or whitespace-only) clears it. Capped to keep
    # the per-turn prompt overhead bounded.
    custom_system_prompt: str | None = Field(default=None, max_length=8000)

    @field_validator("hidden_nav")
    @classmethod
    def _clean_hidden_nav(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        allowed = {"projects", "study", "tasks"}
        # Preserve order, dedupe, and drop anything outside the optional
        # set (Chat + Files are core and can never be hidden).
        seen: list[str] = []
        for item in v:
            key = str(item).strip().lower()
            if key in allowed and key not in seen:
                seen.append(key)
        return seen

    @field_validator("hidden_conversations")
    @classmethod
    def _clean_hidden_conversations(
        cls, v: list[str] | None
    ) -> list[str] | None:
        if v is None:
            return None
        # Dedupe, keep insertion order, cap the list so a buggy client
        # can't bloat the settings blob. Values are opaque id strings.
        seen: list[str] = []
        for item in v:
            key = str(item).strip()
            if key and key not in seen:
                seen.append(key)
            if len(seen) >= 500:
                break
        return seen

    @field_validator("location")
    @classmethod
    def _normalise_location(cls, v: str | None) -> str | None:
        # Trim whitespace so ``"  "`` round-trips to a clear, and so
        # leading/trailing spaces never leak into the system prompt.
        if v is None:
            return None
        v = v.strip()
        return v  # empty string means "clear this field"

    @field_validator("custom_system_prompt")
    @classmethod
    def _normalise_custom_system_prompt(cls, v: str | None) -> str | None:
        # Trim so a whitespace-only paste collapses to ``""`` (which the
        # merge layer treats as "clear"), and stray leading/trailing
        # newlines never bloat the system prompt.
        if v is None:
            return None
        return v.strip()

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
