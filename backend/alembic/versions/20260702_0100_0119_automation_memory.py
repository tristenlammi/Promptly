"""Memory node state (Automations — cross-run memory / sticky note).

Adds ``automation_node_memory``: one row per (task, memory node) holding a
rolling list of the last N runs' captured values so a flow can remember state
across runs (compare-to-last-time, running logs, counters).

Revision ID: 0119_automation_memory
Revises: 0118_task_run_node_runs
Create Date: 2026-07-02 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0119_automation_memory"
down_revision: Union[str, Sequence[str], None] = "0118_task_run_node_runs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "automation_node_memory",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("node_id", sa.String(length=64), nullable=False),
        sa.Column(
            "entries", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("task_id", "node_id", name="uq_automation_memory"),
    )
    op.create_index(
        "ix_automation_node_memory_task_id",
        "automation_node_memory",
        ["task_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_automation_node_memory_task_id", table_name="automation_node_memory"
    )
    op.drop_table("automation_node_memory")
