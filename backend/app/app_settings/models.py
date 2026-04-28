"""ORM model for the single ``app_settings`` row."""
from __future__ import annotations

import uuid
from datetime import datetime

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
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

    # ----- Custom Models embedding provider (Phase RAG-1) -----
    # Workspace-level choice the admin makes once during the setup
    # wizard ("How should we embed knowledge for Custom Models?").
    # Both fields nullable so a fresh install starts in "not yet
    # configured" state and the wizard / Custom Models panel
    # surfaces a banner instead of silently picking something.
    #
    # ``embedding_provider_id``  — points at any ``ModelProvider``
    #   that exposes an ``/embeddings`` endpoint. Includes the
    #   bundled internal Ollama provider for local embeddings.
    # ``embedding_model_id``     — model id within that provider's
    #   catalog (e.g. ``text-embedding-3-small`` for OpenAI,
    #   ``nomic-embed-text`` for the local Ollama).
    # ``embedding_dim``          — the vector dimension that model
    #   produces. Tracked separately so the ingester picks the right
    #   ``knowledge_chunks.embedding_<dim>`` column without round-
    #   tripping to the provider on every chunk.
    embedding_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    embedding_model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    embedding_dim: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # ----- Public origins (replaces the old static .env ALLOWED_ORIGINS) -----
    # JSON array of fully-qualified origins (scheme + host [+ :port]) the
    # CORS middleware will accept in addition to the always-allowed
    # localhost defaults. Populated by the first-run wizard ("How will
    # people reach Promptly?") and editable later under Admin → Settings.
    # Empty array on a fresh install — the wizard prompts for it on the
    # second step, but if the operator skips that step they can still
    # reach the app on http://localhost:8087 indefinitely.
    public_origins: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )

    # ----- VAPID keypair (Web Push) -----
    # Auto-generated by the bootstrap on first container boot if any
    # value is NULL — see ``provision_vapid_keys``. Replaces the old
    # ``VAPID_PUBLIC_KEY`` / ``VAPID_PRIVATE_KEY`` / ``VAPID_CONTACT``
    # env vars so a fresh install gets working push notifications with
    # zero manual key generation.
    #
    # ``vapid_public_key`` is the base64url-encoded uncompressed SEC1
    # point the browser expects as ``applicationServerKey``.
    # ``vapid_private_key`` is the PKCS#8 PEM that ``pywebpush`` signs
    # JWTs with. ``vapid_contact`` is the mailto:/https: URI required by
    # push services so they know who to contact for abuse reports.
    vapid_public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    vapid_private_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    vapid_contact: Mapped[str | None] = mapped_column(String(255), nullable=True)

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
