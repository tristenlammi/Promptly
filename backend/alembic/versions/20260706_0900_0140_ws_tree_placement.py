"""Workspace-tree placement for chats + automations (0140).

Synthesised tree nodes (top-level workspace chats and automations) had no
place to store where the user dragged them, so they were pinned to
recency order at root and couldn't be reordered or filed into folders.
These columns give a ``Conversation`` / ``Task`` the same
``parent + position`` a ``WorkspaceItem`` has:

* ``ws_parent_id`` — the folder (a ``workspace_items`` row) it lives
  under, NULL for root. ``ON DELETE SET NULL`` lifts it back to root if
  the folder is deleted rather than orphaning it.
* ``ws_position`` — float sort key among siblings (same midpoint scheme
  the items tree uses), NULL until first placed.

Both NULL on every existing row = "unplaced" → the historical recency
fallback, so no backfill is needed.

Revision ID: 0140_ws_tree_placement
Revises: 0139_user_secrets
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0140_ws_tree_placement"
down_revision: Union[str, Sequence[str], None] = "0139_user_secrets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("conversations", "tasks"):
        op.add_column(
            table,
            sa.Column("ws_parent_id", sa.Uuid(), nullable=True),
        )
        op.add_column(
            table,
            sa.Column("ws_position", sa.Float(), nullable=True),
        )
        op.create_foreign_key(
            f"fk_{table}_ws_parent",
            table,
            "workspace_items",
            ["ws_parent_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    for table in ("conversations", "tasks"):
        op.drop_constraint(f"fk_{table}_ws_parent", table, type_="foreignkey")
        op.drop_column(table, "ws_position")
        op.drop_column(table, "ws_parent_id")
