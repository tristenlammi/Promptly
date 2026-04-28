"""App settings — public origins + DB-stored VAPID keypair.

Replaces two pieces of static ``.env`` config with database-backed
equivalents so a fresh install can be configured entirely through the
first-run wizard and the admin UI rather than by editing files:

1. ``public_origins`` (JSONB array) — the additional CORS origins the
   backend will accept beyond the always-allowed localhost defaults.
   Populated by the wizard's "How will people reach Promptly?" step.
   Replaces the old ``ALLOWED_ORIGINS`` env var, which is kept as a
   compatibility seed but no longer required.

2. ``vapid_public_key`` / ``vapid_private_key`` / ``vapid_contact``
   (text columns) — the Web Push keypair used by the notifications
   dispatch layer. The backend's bootstrap step now generates a fresh
   keypair on first boot when these are NULL, so a brand-new install
   gets working push notifications with zero manual key generation.
   Replaces the old ``VAPID_PUBLIC_KEY`` / ``VAPID_PRIVATE_KEY`` /
   ``VAPID_CONTACT`` env vars, which still take precedence if set so
   existing deployments keep their existing keypair across upgrades.

All columns are added to the singleton ``app_settings`` row. NULLable
on the VAPID side because the bootstrap fills them in immediately
after the migration runs — having them NULLable means the migration
itself doesn't need to run any side-effect code, keeping the upgrade
purely declarative.

Revision ID: 0040_app_settings_origins_vapid
Revises: 0039_unit_reflection_unique
Create Date: 2026-04-28 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0040_app_settings_origins_vapid"
down_revision: Union[str, None] = "0039_unit_reflection_unique"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "public_origins",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("vapid_public_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("vapid_private_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("vapid_contact", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "vapid_contact")
    op.drop_column("app_settings", "vapid_private_key")
    op.drop_column("app_settings", "vapid_public_key")
    op.drop_column("app_settings", "public_origins")
