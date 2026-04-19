"""Phase 3 — file safety + spend hardening.

Schema delta:

* ``users`` — three quota columns. NULL means "no limit" (the org-wide
  default from ``app_settings`` applies); a non-NULL value is a per-user
  override that takes precedence.

  - ``storage_cap_bytes`` — total bytes the user is allowed to occupy
    in the private file pool. Shared-pool blobs (admin-uploaded) don't
    count against any user.
  - ``daily_token_budget`` / ``monthly_token_budget`` — billing-style
    spend caps, summed from the LLM's reported ``prompt_tokens`` +
    ``completion_tokens`` for messages they originated.

* ``app_settings`` — three matching default columns. Filled in by the
  admin from the App Settings panel; applied to every user whose own
  override is NULL.

  - ``budget_alerts_sent`` JSONB — denormalised "we already mailed the
    admins about user X this period" tracker so we don't blast inboxes
    every chat turn once someone crosses 80%.

* ``usage_daily`` — one row per (user, UTC date). Aggregated post-stream
  inside the chat router so we can answer "have I hit my budget this
  month?" with a single indexed range scan instead of summing the whole
  ``messages`` table on every turn.

Revision ID: 0009_phase3_quotas
Revises: 0008_mfa
Create Date: 2026-04-21 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009_phase3_quotas"
down_revision: Union[str, Sequence[str], None] = "0008_mfa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----------------------------------------------------------------
    # users — per-user quota overrides (NULL = inherit org default)
    # ----------------------------------------------------------------
    op.add_column(
        "users",
        sa.Column("storage_cap_bytes", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("daily_token_budget", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("monthly_token_budget", sa.BigInteger(), nullable=True),
    )

    # ----------------------------------------------------------------
    # app_settings — org defaults (NULL = unlimited)
    # ----------------------------------------------------------------
    op.add_column(
        "app_settings",
        sa.Column("default_storage_cap_bytes", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("default_daily_token_budget", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("default_monthly_token_budget", sa.BigInteger(), nullable=True),
    )
    # Tracks "we already warned the admins about user X for period Y"
    # so the 80% notification doesn't fire on every subsequent turn.
    # Shape: { "<user_uuid>": { "daily": "YYYY-MM-DD", "monthly": "YYYY-MM" } }
    op.add_column(
        "app_settings",
        sa.Column(
            "budget_alerts_sent",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    # ----------------------------------------------------------------
    # usage_daily — aggregated chat token usage
    # ----------------------------------------------------------------
    op.create_table(
        "usage_daily",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column(
            "prompt_tokens",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "completion_tokens",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "messages_sent",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # Range scan helper: "give me everything for user X in this month".
    op.create_index(
        "ix_usage_daily_user_day_desc",
        "usage_daily",
        ["user_id", sa.text("day DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_usage_daily_user_day_desc", table_name="usage_daily")
    op.drop_table("usage_daily")
    op.drop_column("app_settings", "budget_alerts_sent")
    op.drop_column("app_settings", "default_monthly_token_budget")
    op.drop_column("app_settings", "default_daily_token_budget")
    op.drop_column("app_settings", "default_storage_cap_bytes")
    op.drop_column("users", "monthly_token_budget")
    op.drop_column("users", "daily_token_budget")
    op.drop_column("users", "storage_cap_bytes")
