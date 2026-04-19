"""Append-only audit log of security-relevant events.

Every login attempt (success or fail), every lockout / unlock, every
admin override, and every MFA event writes one row here. Surfaced to
admins via ``GET /api/admin/auth-events``.

Kept in its own module so circular imports between the auth router and
the admin router are impossible — both depend on this, neither on each
other.
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


# ---------------------------------------------------------------------
# Canonical event-type strings. Kept as module constants (not an Enum)
# so we never have to migrate an enum type when we add a new one.
# ---------------------------------------------------------------------
EVENT_LOGIN_SUCCESS = "login_success"
EVENT_LOGIN_FAIL = "login_fail"
EVENT_LOGOUT = "logout"
EVENT_LOCKOUT = "lockout"
EVENT_UNLOCK = "unlock"
EVENT_DISABLE = "disable"
EVENT_ENABLE = "enable"
EVENT_PASSWORD_CHANGE = "password_change"
EVENT_PASSWORD_RESET_BY_ADMIN = "password_reset_by_admin"
EVENT_FORCE_LOGOUT_ALL = "force_logout_all"
EVENT_TOKEN_REFRESH = "token_refresh"
EVENT_REFRESH_REJECTED = "refresh_rejected"
# Reserved for Phase 2 (MFA). Defined here so the audit log enum is a
# single source of truth — the MFA module just imports them.
EVENT_MFA_ENROLLED = "mfa_enrolled"
EVENT_MFA_VERIFIED = "mfa_verified"
EVENT_MFA_FAIL = "mfa_fail"
EVENT_MFA_RESET = "mfa_reset"
EVENT_MFA_BACKUP_USED = "mfa_backup_used"
EVENT_MFA_DEVICE_TRUSTED = "mfa_device_trusted"
EVENT_MFA_DEVICE_REVOKED = "mfa_device_revoked"
EVENT_APP_SETTINGS_CHANGED = "app_settings_changed"

# Emitted when the rate limiter rejects a request. Surfaced in the audit
# log so admins can spot brute-force / spray attempts at a glance even
# when the underlying account never gets close to a lockout.
EVENT_RATE_LIMITED = "rate_limited"

# ---------------------------------------------------------------------
# Phase 3 — file safety + spend hardening
# ---------------------------------------------------------------------
# Upload was rejected by the magic-byte sniffer, the filename validator,
# or the per-user storage cap. ``detail`` carries a short reason
# ("mime_mismatch", "bad_filename", "storage_cap").
EVENT_FILE_UPLOAD_REJECTED = "file_upload_rejected"

# A user message was refused because the user has hit their daily or
# monthly token budget. ``detail`` carries the period + the cap.
EVENT_BUDGET_EXCEEDED = "budget_exceeded"

# Best-effort SSRF guard fired — outbound HTTP refused because the
# resolved address landed in a private / link-local / loopback range.
# ``detail`` carries the (truncated) target URL and the resolved IP.
EVENT_SSRF_BLOCKED = "ssrf_blocked"

# ---------------------------------------------------------------------
# Phase A1 — AI tool calling
# ---------------------------------------------------------------------
# A registered chat-tool was invoked successfully. ``detail`` carries
# the tool name + a short hash of the arguments (never the full
# payload — that can contain user content). One row per dispatch so
# admins can see which tools are in use and at what rate.
EVENT_TOOL_INVOKED = "tool_invoked"

# A tool dispatch raised an error. ``detail`` carries the tool name
# and the exception class — never the message, which can leak
# internals. Useful for spotting consistently-broken tools without
# trawling stdout.
EVENT_TOOL_FAILED = "tool_failed"

# ---------------------------------------------------------------------
# Phase A3 — generated-file source editor
# ---------------------------------------------------------------------
# A user edited the Markdown source of an AI-generated artefact via
# the side-panel editor and triggered an in-place re-render. ``detail``
# carries the rendered file id + the new source byte count. One row
# per save; users can edit the same doc many times in a session.
EVENT_GENERATED_SOURCE_EDITED = "generated_source_edited"

# Re-rendering the PDF after a source edit failed. The source row has
# already been overwritten at this point — the user keeps their text
# changes but the rendered child is now stale. ``detail`` carries the
# source / rendered file ids and the exception class.
EVENT_GENERATED_RERENDER_FAILED = "generated_rerender_failed"


class AuthEvent(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "auth_events"

    # SET NULL on user delete so the audit trail survives account
    # removal — we still want to know "someone deleted the account at
    # this time, after these failed logins."
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # The identifier the caller *typed* on a login attempt. Kept even
    # when no matching user exists so we can spot enumeration / spray
    # attacks.
    identifier: Mapped[str] = mapped_column(
        String(320), nullable=False, default="", server_default=""
    )
    ip: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )
    user_agent: Mapped[str] = mapped_column(
        String(512), nullable=False, default="", server_default=""
    )
    event_type: Mapped[str] = mapped_column(String(48), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(512), nullable=True)

    def __repr__(self) -> str:
        return (
            f"<AuthEvent {self.event_type} user={self.user_id} "
            f"ident={self.identifier!r} ip={self.ip!r}>"
        )
