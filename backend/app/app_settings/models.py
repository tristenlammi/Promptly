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

    # ----- SSO (OIDC single sign-on) -----
    # Off by default — local username/password login is unchanged unless an
    # admin turns this on. SSO authenticates INVITED users only: the IdP's
    # verified email is matched to an existing account (no auto-provisioning),
    # so it never widens access beyond the admin's user list.
    oidc_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Issuer base URL (e.g. https://accounts.google.com) OR a full
    # .well-known/openid-configuration URL — discovery accepts both.
    oidc_issuer: Mapped[str | None] = mapped_column(String(512), nullable=True)
    oidc_client_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Fernet-encrypted at rest (mirrors ``smtp_password_encrypted``). NULL
    # when SSO isn't configured.
    oidc_client_secret_encrypted: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    # Login-button label ("Sign in with Google"); a default is applied in
    # code when NULL. Scopes default to "openid email profile" when NULL.
    oidc_button_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    oidc_scopes: Mapped[str | None] = mapped_column(String(256), nullable=True)

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

    # ----- Chat tool limits -----
    # Per-turn cap on how many ``web_search`` calls a single assistant
    # turn can fire. Defaults to 5 (matches :data:`MAX_TOOL_HOPS` so the
    # per-tool cap isn't the silently-binding constraint by accident).
    # Range enforced at the API boundary in
    # :class:`app.admin.schemas.AppSettingsUpdate` to 1..20 — anything
    # above ~10 is almost certainly a runaway loop, and 0 would break
    # web search entirely (admins should flip the per-conversation
    # web-search mode to ``"off"`` instead).
    chat_max_web_searches_per_turn: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5, server_default="5"
    )

    # ----- Vision relay -----
    # When a user attaches an image to a chat whose active model can't
    # read images, the chat router routes each image through this
    # designated vision-capable model to produce a text caption, then
    # splices the caption into the user's prompt as text. The original
    # image bytes are *not* forwarded to the main model — only the
    # caption. A pair of SSE chips (``vision_relay_started`` /
    # ``vision_relay_finished``) surfaces what happened in the UI so
    # the user can see they're getting captions rather than direct
    # vision. Both fields nullable: NULL = feature disabled (also the
    # right state on a fresh install).
    #
    # ``vision_relay_provider_id`` — FK to ``model_providers``,
    #   ``ON DELETE SET NULL`` so removing the underlying provider
    #   cleanly disables the relay instead of orphaning the id.
    # ``vision_relay_model_id``    — free-form id within that
    #   provider's catalog (e.g. ``gpt-4o-mini``, ``gemini-2.0-flash``,
    #   ``llava:latest``, or a Promptly custom-model id like
    #   ``custom:<uuid>``).
    vision_relay_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    vision_relay_model_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )

    # ----- Global default chat model -----
    # Workspace-wide fallback used when a user creates a new chat and
    # they haven't picked a personal default on their Account page.
    # Both fields nullable: NULL = "no admin default — fall through to
    # the catalog's first available model" (the historical behaviour).
    # Precedence at conversation creation time:
    #
    #   1. payload.provider_id + payload.model_id  (explicit picker)
    #   2. user.default_provider_id + user.default_model_id  (personal)
    #   3. app_settings.default_chat_*_id  (this admin default)
    #   4. first available model from the catalog
    #
    # The admin default never overrides a personal preference — it only
    # fills in for users who haven't customised one. Same FK shape as
    # the embedding and vision-relay defaults; deleting the provider
    # cleanly disables the default rather than orphaning the row.
    default_chat_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    default_chat_model_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )

    # ----- Deep Research model (Phase 11) -----
    # When set, every Deep Research run uses this model instead of the
    # user's currently-selected chat model. Lets admins point research
    # at a capable pro model (e.g. Claude Opus) while users chat with a
    # faster/cheaper model. Both fields nullable: NULL = use whatever the
    # user has selected. Same FK/ON DELETE shape as the other model pairs.
    research_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    research_model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ----- Memory extraction model -----
    # Optional dedicated model for cross-chat memory work: the post-turn
    # capture pass and the on-demand consolidation pass. Both are small,
    # strict-JSON extraction jobs — favor the fast/cheap tier (Haiku,
    # Gemini Flash, GPT-5-mini). NULL = capture rides the conversation's
    # model (historical behaviour) and consolidation falls back to the
    # default chat model.
    memory_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    memory_model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ----- Image generation model -----
    # The admin-selected model the ``generate_image`` chat tool renders
    # with. Unlike chat models, image-output models are never user-
    # selectable — the tool fires when a user asks for a picture and
    # resolves this one model regardless of the user's chat pick (same
    # "system role" shape as the vision relay). Both fields nullable:
    # NULL = "no default configured", in which case the tool falls back
    # to the first image-capable model in the catalog (historical
    # behaviour). Per-user access is gated separately by
    # ``User.can_generate_images``. Same FK/ON DELETE shape as the other
    # model pairs — deleting the provider cleanly disables the default.
    image_gen_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    image_gen_model_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )

    # ----- Voice model -----
    # Model used for real-time voice-mode turns. Voice prioritises low
    # latency over raw capability, so an admin can pin a fast model (e.g.
    # a Flash/Haiku tier) that overrides the user's chat model *only* on
    # spoken turns — the text conversation is unaffected. Both fields
    # nullable: NULL = voice turns just use the user's current chat model
    # (historical behaviour). Same FK/ON DELETE shape as the other pairs.
    voice_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    voice_model_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
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

    @property
    def vision_relay_configured(self) -> bool:
        """True when the admin has picked both halves of the relay setting.

        The chat router treats either half as NULL as "feature off",
        so callers can use this single boolean instead of repeating
        the ``and``-chain everywhere.
        """
        return bool(self.vision_relay_provider_id and self.vision_relay_model_id)

    @property
    def research_configured(self) -> bool:
        """True when the admin has designated a research model."""
        return bool(self.research_provider_id and self.research_model_id)

    @property
    def memory_configured(self) -> bool:
        """True when the admin has designated a memory extraction model."""
        return bool(self.memory_provider_id and self.memory_model_id)

    @property
    def image_gen_configured(self) -> bool:
        """True when the admin has designated a default image-gen model."""
        return bool(self.image_gen_provider_id and self.image_gen_model_id)

    @property
    def voice_configured(self) -> bool:
        """True when the admin has designated a dedicated voice model."""
        return bool(self.voice_provider_id and self.voice_model_id)

    @property
    def default_chat_configured(self) -> bool:
        """True when the admin has picked both halves of the default
        chat-model setting. Used by the conversation-creation
        fallback chain so the half-configured state collapses to
        "no admin default" instead of crashing when it tries to look
        up a missing provider.
        """
        return bool(self.default_chat_provider_id and self.default_chat_model_id)

    def __repr__(self) -> str:
        return (
            f"<AppSettings mfa_required={self.mfa_required} "
            f"smtp_configured={self.smtp_configured}>"
        )
