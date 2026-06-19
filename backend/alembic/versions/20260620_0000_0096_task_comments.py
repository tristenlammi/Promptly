"""Card comments + activity thread.

Creates ``workspace_task_comments`` — one chronological thread per Kanban
card mixing user comments (kind='comment') and auto-logged activity
(kind='activity').

Revision ID: 0096_task_comments
Revises: 0095_task_assignee
Create Date: 2026-06-20 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0096_task_comments"
down_revision: Union[str, Sequence[str], None] = "0095_task_assignee"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_task_comments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspace_tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "author_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="comment",
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_workspace_task_comments_task_id",
        "workspace_task_comments",
        ["task_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workspace_task_comments_task_id", "workspace_task_comments"
    )
    op.drop_table("workspace_task_comments")
