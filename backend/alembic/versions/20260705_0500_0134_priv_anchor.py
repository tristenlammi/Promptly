"""Private items + anchored/resolvable comments.

Batch-3 finale schema:

* ``workspace_items.visibility`` — "workspace" (default, everyone in the
  room) or "private" (creator-only draft: hidden from other members'
  trees, item fetches, AND the shared RAG pool).
* ``workspace_items.created_by`` — who made the item. Backfilled to the
  workspace owner (pre-0134 rows have no better answer) and required for
  private visibility + activity-feed attribution.
* ``workspace_item_comments.quote`` — the selected note text a comment
  anchors to (text-quote anchoring survives the bleach/CRDT pipeline
  where editor marks would not).
* ``workspace_item_comments.resolved_at`` — resolve/unresolve threads.

Revision ID: 0134_priv_anchor
Revises: 0133_notifications
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0134_priv_anchor"
down_revision: Union[str, Sequence[str], None] = "0133_notifications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column(
            "visibility",
            sa.String(length=16),
            nullable=False,
            server_default="workspace",
        ),
    )
    op.add_column(
        "workspace_items",
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Pre-0134 items: the workspace owner is the only defensible author.
    op.execute(
        "UPDATE workspace_items SET created_by = "
        "(SELECT user_id FROM workspaces WHERE workspaces.id = workspace_items.workspace_id)"
    )

    op.add_column(
        "workspace_item_comments",
        sa.Column("quote", sa.Text(), nullable=True),
    )
    op.add_column(
        "workspace_item_comments",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_item_comments", "resolved_at")
    op.drop_column("workspace_item_comments", "quote")
    op.drop_column("workspace_items", "created_by")
    op.drop_column("workspace_items", "visibility")
