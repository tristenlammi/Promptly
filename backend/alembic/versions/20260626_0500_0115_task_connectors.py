"""Tasks gain a home workspace + per-task MCP connector grants.

Adds ``tasks.workspace_id`` (nullable; SET NULL on workspace delete) so a
scheduled task can live in a workspace's navigator, and a
``task_connectors`` join so a run can call an explicit set of MCP
connectors.

Revision ID: 0115_task_connectors
Revises: 0114_group_models
Create Date: 2026-06-26 05:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0115_task_connectors"
down_revision: Union[str, Sequence[str], None] = "0114_group_models"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_tasks_workspace_id", "tasks", ["workspace_id"])
    op.create_table(
        "task_connectors",
        sa.Column(
            "task_id",
            UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "connector_id",
            UUID(as_uuid=True),
            sa.ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("task_connectors")
    op.drop_index("ix_tasks_workspace_id", "tasks")
    op.drop_column("tasks", "workspace_id")
