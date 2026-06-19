"""Board labels: per-board label registry + per-card label refs.

Kanban v2 (labels). Adds:

* ``workspace_items.config``  — generic JSON config used by board items to
  hold ``{labels: [{id, name, color}], ...}`` (and, later, custom columns).
* ``workspace_tasks.labels``  — JSON list of label ids the card carries.

Revision ID: 0094_board_labels
Revises: 0093_task_detail
Create Date: 2026-06-19 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0094_board_labels"
down_revision: Union[str, Sequence[str], None] = "0093_task_detail"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column("config", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "workspace_tasks",
        sa.Column("labels", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "labels")
    op.drop_column("workspace_items", "config")
