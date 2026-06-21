"""Workspace memory mode: tri-state off/auto/manual.

Adds ``workspaces.memory_mode`` mirroring the account-level memory toggle:
``off`` (not maintained or injected), ``auto`` (librarian auto-maintains),
``manual`` (used + hand-managed, no auto-runs). Backfills ``auto`` for any
workspace that already had ``auto_memory_enabled = true``; everything else
defaults to ``off``. ``auto_memory_enabled`` is retained as a synced mirror.

Revision ID: 0103_workspace_memory_mode
Revises: 0102_workspace_memory_model
Create Date: 2026-06-21 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0103_workspace_memory_mode"
down_revision: Union[str, Sequence[str], None] = "0102_workspace_memory_model"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "memory_mode",
            sa.String(length=16),
            nullable=False,
            server_default="off",
        ),
    )
    # Backfill: existing auto-memory workspaces become "auto".
    op.execute(
        "UPDATE workspaces SET memory_mode = 'auto' "
        "WHERE auto_memory_enabled = true"
    )


def downgrade() -> None:
    op.drop_column("workspaces", "memory_mode")
