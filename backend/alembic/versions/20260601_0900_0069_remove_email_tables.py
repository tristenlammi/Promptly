"""Remove email & calendar integration tables and app_settings columns.

Revision ID: 0069_remove_email_tables
Revises: 0068_calendar_events
Create Date: 2026-06-01 09:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0069_remove_email_tables"
down_revision = "0068_calendar_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop tables in dependency order (FK constraints first)
    op.drop_table("calendar_events")
    op.drop_table("email_chunks")
    op.drop_table("email_messages")
    op.drop_table("email_contacts")
    op.drop_table("email_accounts")

    # Remove email columns from app_settings
    op.drop_column("app_settings", "email_triage_daily_token_cap")
    op.drop_column("app_settings", "email_triage_model_id")
    op.drop_column("app_settings", "email_triage_provider_id")
    op.drop_column("app_settings", "google_oauth_client_secret_enc")
    op.drop_column("app_settings", "google_oauth_client_id")
    op.drop_column("app_settings", "email_integration_enabled")


def downgrade() -> None:
    # Re-add app_settings columns
    op.add_column(
        "app_settings",
        sa.Column("email_integration_enabled", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column("app_settings", sa.Column("google_oauth_client_id", sa.String(256), nullable=True))
    op.add_column("app_settings", sa.Column("google_oauth_client_secret_enc", sa.Text(), nullable=True))
    op.add_column("app_settings", sa.Column("email_triage_provider_id", sa.UUID(), nullable=True))
    op.add_column("app_settings", sa.Column("email_triage_model_id", sa.String(255), nullable=True))
    op.add_column("app_settings", sa.Column("email_triage_daily_token_cap", sa.BigInteger(), nullable=True))
    # Note: email tables not restored in downgrade — use earlier migrations.
