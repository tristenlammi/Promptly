"""Tasks gain an optional persisted flow graph (Automations Phase 1).

Adds ``tasks.flow_graph`` (nullable JSONB). NULL means "this is a plain Simple
task — derive the trigger→AI→output graph from the existing columns on demand."
A non-NULL value is an Advanced flow: the stored node graph is the source of
truth for the editor, and the runner executes it. Existing rows stay NULL, so
this is a no-op for every current task.

Revision ID: 0117_task_flow_graph
Revises: 0116_retrieval_tutor_score
Create Date: 2026-06-27 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0117_task_flow_graph"
down_revision: Union[str, Sequence[str], None] = "0116_retrieval_tutor_score"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("flow_graph", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tasks", "flow_graph")
