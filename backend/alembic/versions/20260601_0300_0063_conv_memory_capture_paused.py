"""Add memory_capture_paused to conversations (Phase 9).

Per-conversation toggle that pauses auto-memory capture without touching
the global memory_mode setting. Useful for sensitive conversations where
the user doesn't want facts extracted.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0063_conv_memory_capture_paused"
down_revision = "0062_memory_usage_signals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "memory_capture_paused",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "memory_capture_paused")
