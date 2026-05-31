"""Add times_used + last_used_at to user_memories (Memory Overhaul Phase 3.1).

``times_used`` counts how many chat turns have retrieved this fact into the
system prompt. ``last_used_at`` is stamped each time. Together they let the
retrieval layer break ties between semantically equidistant facts and help
the eviction policy at the 200-fact cap prefer rarely-used auto facts over
frequently-used ones.

Revision ID: 0062_memory_usage_signals
Revises: 0061_memory_category_pinned
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0062_memory_usage_signals"
down_revision: str = "0061_memory_category_pinned"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_memories",
        sa.Column(
            "times_used",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "user_memories",
        sa.Column("last_used_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    # Most-used retrieval tie-breaking: index on (user_id, times_used DESC).
    op.execute(
        "CREATE INDEX ix_user_memories_user_times_used "
        "ON user_memories (user_id, times_used DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_user_memories_user_times_used")
    op.drop_column("user_memories", "last_used_at")
    op.drop_column("user_memories", "times_used")
