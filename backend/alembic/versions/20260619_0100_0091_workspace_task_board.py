"""Kanban fields for workspace tasks.

Adds the columns that turn the flat workspace to-do list into a board:

* ``workspace_tasks.status``   — ``todo`` | ``doing`` | ``done`` column.
* ``workspace_tasks.priority`` — ``low`` | ``medium`` | ``high`` accent.
* ``workspace_tasks.due_at``   — optional due date/time.

Existing rows are backfilled: a done task lands in the ``done`` column,
everything else in ``todo``; priority defaults to ``medium``.

Revision ID: 0091_workspace_task_board
Revises: 0090_chat_workspace_context
Create Date: 2026-06-19 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0091_workspace_task_board"
down_revision: Union[str, Sequence[str], None] = "0090_chat_workspace_context"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks",
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="todo",
        ),
    )
    op.add_column(
        "workspace_tasks",
        sa.Column(
            "priority",
            sa.String(length=16),
            nullable=False,
            server_default="medium",
        ),
    )
    op.add_column(
        "workspace_tasks",
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Backfill status from the legacy done flag so existing tasks land in
    # the right column.
    op.execute(
        "UPDATE workspace_tasks SET status = 'done' WHERE done = true"
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "due_at")
    op.drop_column("workspace_tasks", "priority")
    op.drop_column("workspace_tasks", "status")
