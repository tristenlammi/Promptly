"""Item trash + card custom fields (S-tier Batch 8).

* ``workspace_items.trashed_at`` — soft-delete staging. "Delete" in the
  tree now moves an item (and its subtree) here instead of destroying
  it; a Trash section restores or purges, and anything older than 30
  days is purged lazily. Trashed items vanish from the tree, the AI
  map, retrieval, search, and the overview — but nothing is torn down
  until purge.
* ``workspace_tasks.fields`` — per-card values for the board's custom
  field registry (definitions live in the board item's ``config.fields``
  the same way labels do). ``{field_id: value}``.

Revision ID: 0138_trash_fields
Revises: 0137_meetings
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0138_trash_fields"
down_revision: Union[str, Sequence[str], None] = "0137_meetings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_workspace_items_trashed_at", "workspace_items", ["trashed_at"]
    )
    op.add_column(
        "workspace_tasks",
        sa.Column("fields", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "fields")
    op.drop_index("ix_workspace_items_trashed_at", table_name="workspace_items")
    op.drop_column("workspace_items", "trashed_at")
