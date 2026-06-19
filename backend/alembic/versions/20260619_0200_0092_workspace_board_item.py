"""Make the Kanban board an addable workspace item.

The board moves off the workspace home into the navigator tree as a
first-class item (``kind='board'``). Tasks now belong to a specific board
item via ``workspace_tasks.board_item_id`` (FK ``workspace_items.id``,
CASCADE) instead of being one flat list per workspace.

Data migration: every workspace that already has tasks gets a default
"Board" item, and its existing tasks are reassigned to it so nothing is
lost.

Revision ID: 0092_workspace_board_item
Revises: 0091_workspace_task_board
Create Date: 2026-06-19 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0092_workspace_board_item"
down_revision: Union[str, Sequence[str], None] = "0091_workspace_task_board"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks",
        sa.Column(
            "board_item_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
    )
    op.create_foreign_key(
        "fk_workspace_tasks_board_item_id_items",
        "workspace_tasks",
        "workspace_items",
        ["board_item_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_workspace_tasks_board_item_id",
        "workspace_tasks",
        ["board_item_id"],
    )

    # One default "Board" item per workspace that currently has tasks.
    op.execute(
        """
        INSERT INTO workspace_items (id, workspace_id, kind, title, position)
        SELECT gen_random_uuid(), s.workspace_id, 'board', 'Board', 0
        FROM (SELECT DISTINCT workspace_id FROM workspace_tasks) AS s
        """
    )
    # Reassign existing tasks to their workspace's new board item.
    op.execute(
        """
        UPDATE workspace_tasks t
        SET board_item_id = wi.id
        FROM workspace_items wi
        WHERE wi.workspace_id = t.workspace_id
          AND wi.kind = 'board'
          AND t.board_item_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_workspace_tasks_board_item_id", "workspace_tasks")
    op.drop_constraint(
        "fk_workspace_tasks_board_item_id_items",
        "workspace_tasks",
        type_="foreignkey",
    )
    op.drop_column("workspace_tasks", "board_item_id")
