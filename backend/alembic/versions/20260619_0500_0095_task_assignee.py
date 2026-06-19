"""Task assignee (Kanban v2).

Adds ``workspace_tasks.assignee_user_id`` (FK ``users.id`` ON DELETE SET
NULL) so a card can be assigned to a workspace member.

Revision ID: 0095_task_assignee
Revises: 0094_board_labels
Create Date: 2026-06-19 05:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0095_task_assignee"
down_revision: Union[str, Sequence[str], None] = "0094_board_labels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks",
        sa.Column(
            "assignee_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
    )
    op.create_foreign_key(
        "fk_workspace_tasks_assignee_user_id_users",
        "workspace_tasks",
        "users",
        ["assignee_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_workspace_tasks_assignee_user_id",
        "workspace_tasks",
        ["assignee_user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workspace_tasks_assignee_user_id", "workspace_tasks"
    )
    op.drop_constraint(
        "fk_workspace_tasks_assignee_user_id_users",
        "workspace_tasks",
        type_="foreignkey",
    )
    op.drop_column("workspace_tasks", "assignee_user_id")
