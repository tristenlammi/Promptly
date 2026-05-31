"""Add category + pinned to user_memories (Memory Overhaul Phase 2.1).

``category`` tags each fact for grouping in the management UI and
structured injection (identity | preferences | projects | context).
``pinned`` facts are always included in the system prompt regardless of
the top-K retrieval cap — the user's must-know facts.

Revision ID: 0061_memory_category_pinned
Revises: 0060_memory_embeddings
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0061_memory_category_pinned"
down_revision: str = "0060_memory_embeddings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_memories",
        sa.Column("category", sa.String(20), nullable=True, server_default=None),
    )
    op.add_column(
        "user_memories",
        sa.Column(
            "pinned",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
    )
    # Pinned facts are always fetched alongside retrieved ones; this
    # partial index makes that look-up fast (typically a tiny set).
    op.execute(
        "CREATE INDEX ix_user_memories_user_pinned "
        "ON user_memories (user_id) WHERE pinned = true"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_user_memories_user_pinned")
    op.drop_column("user_memories", "pinned")
    op.drop_column("user_memories", "category")
