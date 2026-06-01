"""Phase 12 (E.3) — Calendar events table + calendar sync token.

Adds:
  calendar_events  — mirrored Google Calendar events (read-only sync)
  email_accounts.calendar_sync_token  — incremental sync cursor
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

revision = "0068_calendar_events"
down_revision = "0067_email_attachments_folder"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add incremental sync cursor to email_accounts
    op.add_column(
        "email_accounts",
        sa.Column("calendar_sync_token", sa.Text, nullable=True),
    )

    op.create_table(
        "calendar_events",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("account_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("email_accounts.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("user_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("provider_event_id", sa.String(256), nullable=False),
        sa.Column("title", sa.Text, nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("all_day", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("location", sa.Text, nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("attendees", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("meet_link", sa.Text, nullable=True),
        sa.Column("status", sa.String(32), nullable=True),   # confirmed | tentative | cancelled
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_calendar_events_account_id", "calendar_events", ["account_id"])
    op.create_index("ix_calendar_events_user_id", "calendar_events", ["user_id"])
    op.create_index("ix_calendar_events_start_at", "calendar_events", ["start_at"])
    op.create_index(
        "ix_calendar_events_provider_unique",
        "calendar_events",
        ["account_id", "provider_event_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("calendar_events")
    op.drop_column("email_accounts", "calendar_sync_token")
