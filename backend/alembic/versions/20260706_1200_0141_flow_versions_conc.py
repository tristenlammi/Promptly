"""Flow version history + concurrency policy for automations (A3).

Two trust-and-scale additions:

* ``tasks.concurrency`` — overlap policy (``allow`` default | ``skip``). When
  ``skip``, the scheduler passes on a fire while a run for the task is still
  pending/running, so a slow run can't stack up on the next tick.
* ``flow_graph_versions`` — one snapshot per graph save so an edit can be
  undone across saves and the history browsed/restored (only the newest N per
  task are kept; older ones swept on save).

Revision ID: 0141_flow_versions_conc
Revises: 0140_ws_tree_placement
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0141_flow_versions_conc"
down_revision: Union[str, Sequence[str], None] = "0140_ws_tree_placement"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "concurrency",
            sa.String(length=8),
            nullable=False,
            server_default="allow",
        ),
    )
    op.create_table(
        "flow_graph_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("graph", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("summary", sa.String(length=140), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_flow_graph_versions_task_id", "flow_graph_versions", ["task_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_flow_graph_versions_task_id", table_name="flow_graph_versions"
    )
    op.drop_table("flow_graph_versions")
    op.drop_column("tasks", "concurrency")
