"""Phase 12 (E.1) — Add email integration fields to app_settings.

Adds:
  email_integration_enabled       — org-wide kill switch (default false)
  google_oauth_client_id          — admin-provisioned Google Cloud app
  google_oauth_client_secret_enc  — Fernet-encrypted client secret
  email_triage_provider_id        — FK to model_providers (local default)
  email_triage_model_id           — model within that provider
  email_triage_daily_token_cap    — budget guard for triage LLM calls
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "0066_app_settings_email"
down_revision = "0065_email_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "email_integration_enabled",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("google_oauth_client_id", sa.String(256), nullable=True),
    )
    # Fernet-encrypted at rest (same pattern as smtp_password_encrypted)
    op.add_column(
        "app_settings",
        sa.Column("google_oauth_client_secret_enc", sa.Text, nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "email_triage_provider_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("email_triage_model_id", sa.String(255), nullable=True),
    )
    # NULL = no cap (careful — leave this unconfigured only on small private instances)
    op.add_column(
        "app_settings",
        sa.Column("email_triage_daily_token_cap", sa.BigInteger, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "email_triage_daily_token_cap")
    op.drop_column("app_settings", "email_triage_model_id")
    op.drop_column("app_settings", "email_triage_provider_id")
    op.drop_column("app_settings", "google_oauth_client_secret_enc")
    op.drop_column("app_settings", "google_oauth_client_id")
    op.drop_column("app_settings", "email_integration_enabled")
