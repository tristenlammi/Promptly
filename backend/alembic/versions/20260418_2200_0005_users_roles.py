"""Add role + allowed_models to users for multi-user + admin panel.

- `role` ("admin" | "user") gates the admin panel and /api/models writes.
- `allowed_models` is the per-user whitelist of model IDs surfaced in the
  chat picker. NULL = full access to the admin's curated org-wide pool
  (providers.enabled_models); a list (possibly empty) restricts further.

The existing SINGLE_USER_MODE singleton ("local" / "local@example.com") is
promoted to admin so pre-existing chats + providers remain usable after the
upgrade — no data migration required.

Revision ID: 0005_users_roles
Revises: 0004_msg_metrics
Create Date: 2026-04-18 22:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_users_roles"
down_revision: Union[str, Sequence[str], None] = "0004_msg_metrics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "role",
            sa.String(length=16),
            nullable=False,
            server_default="user",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "allowed_models",
            postgresql.JSONB(),
            nullable=True,
        ),
    )

    # Promote the legacy singleton to admin. Matching on username AND email
    # avoids collateral damage if a real user happened to pick the same name.
    op.execute(
        """
        UPDATE users
        SET role = 'admin'
        WHERE username = 'local' AND email = 'local@example.com'
        """
    )

    # Safety net: if there is exactly one user in the system and no admin yet,
    # they become the admin. Covers deployments where the singleton was
    # renamed manually before this migration ran.
    op.execute(
        """
        UPDATE users
        SET role = 'admin'
        WHERE id = (
            SELECT id FROM users
        )
          AND (SELECT COUNT(*) FROM users) = 1
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
        """
    )


def downgrade() -> None:
    op.drop_column("users", "allowed_models")
    op.drop_column("users", "role")
