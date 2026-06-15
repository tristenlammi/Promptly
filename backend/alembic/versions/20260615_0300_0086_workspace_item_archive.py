"""Soft-archive for workspace navigator items.

Adds ``workspace_items.archived_at`` — a NULL timestamp = live in the
tree; a set timestamp moves the item (and, for a folder, its subtree) to
the workspace's Archive section. Mirrors the soft-archive pattern already
used by ``workspaces.archived_at`` and ``conversations.archived_at``.

Revision ID: 0086_workspace_item_archive
Revises: 0085_workspace_canvas
Create Date: 2026-06-15 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0086_workspace_item_archive"
down_revision: Union[str, Sequence[str], None] = "0085_workspace_canvas"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_items", "archived_at")
