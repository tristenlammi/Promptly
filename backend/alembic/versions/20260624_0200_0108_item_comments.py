"""Comments on workspace items (Phase 6 — collaboration).

A flat, chronological comment thread attached to a workspace item so
collaborators can leave feedback without editing the item itself.

Revision ID: 0108_item_comments
Revises: 0107_task_run_title
Create Date: 2026-06-24 02:00:00

NB: keep the revision id short — ``alembic_version.version_num`` is
``varchar(32)``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0108_item_comments"
down_revision: Union[str, Sequence[str], None] = "0107_task_run_title"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_item_comments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspace_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "author_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
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
        "ix_workspace_item_comments_item_id",
        "workspace_item_comments",
        ["item_id"],
    )
    op.create_index(
        "ix_workspace_item_comments_workspace_id",
        "workspace_item_comments",
        ["workspace_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_workspace_item_comments_workspace_id", "workspace_item_comments")
    op.drop_index("ix_workspace_item_comments_item_id", "workspace_item_comments")
    op.drop_table("workspace_item_comments")
