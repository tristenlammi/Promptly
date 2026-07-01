"""Task runs capture per-node outputs (Automations Phase 1 — run inspector).

Adds ``task_runs.node_runs`` (nullable JSONB): a list of what each node in the
flow produced during this run — one entry per AI step (its output + tokens) and
the terminal output node (what it did). Powers the "click a run → see each
node's output" inspector. NULL for older runs (and Simple single-step runs that
predate this).

Revision ID: 0118_task_run_node_runs
Revises: 0117_task_flow_graph
Create Date: 2026-06-27 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0118_task_run_node_runs"
down_revision: Union[str, Sequence[str], None] = "0117_task_flow_graph"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_runs",
        sa.Column("node_runs", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_runs", "node_runs")
