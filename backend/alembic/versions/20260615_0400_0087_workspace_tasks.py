"""First-class workspace task list.

Adds ``workspace_tasks`` — a standalone, workspace-level to-do list
(distinct from the TipTap checkboxes inside notes). The overview "home"
renders the open ones so a workspace doubles as a lightweight planner.

Revision ID: 0087_workspace_tasks
Revises: 0086_workspace_item_archive
Create Date: 2026-06-15 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0087_workspace_tasks"
down_revision: Union[str, Sequence[str], None] = "0086_workspace_item_archive"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ``id`` carries no server default — the ORM mixin generates UUIDs
    # Python-side (``default=uuid.uuid4``), matching workspace_items.
    op.create_table(
        "workspace_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column(
            "done",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        # Float so a drag inserts between neighbours by midpoint.
        sa.Column(
            "position", sa.Float(), nullable=False, server_default="0"
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_workspace_tasks_workspace", "workspace_tasks", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workspace_tasks_workspace", table_name="workspace_tasks"
    )
    op.drop_table("workspace_tasks")
