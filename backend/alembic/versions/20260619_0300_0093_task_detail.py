"""Card detail: description + subtasks on workspace tasks.

Kanban v2 (card detail panel). Adds:

* ``workspace_tasks.description`` — free markdown card body.
* ``workspace_tasks.subtasks``    — JSON checklist (``[{id, text, done}]``).

Revision ID: 0093_task_detail
Revises: 0092_workspace_board_item
Create Date: 2026-06-19 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0093_task_detail"
down_revision: Union[str, Sequence[str], None] = "0092_workspace_board_item"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks", sa.Column("description", sa.Text(), nullable=True)
    )
    op.add_column(
        "workspace_tasks",
        sa.Column("subtasks", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "subtasks")
    op.drop_column("workspace_tasks", "description")
