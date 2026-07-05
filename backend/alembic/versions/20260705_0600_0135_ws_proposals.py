"""Workspace write-back proposals (Batch 4.1).

Chat can now *propose* changes to its workspace — create a note, add
board cards, append to a note — but never applies them itself. Each
tool call lands here as a pending row; the user sees a preview card in
the chat and explicitly applies or dismisses it. The approval gate is
the point: workspace chats stay read-only until a human says otherwise.

Revision ID: 0135_ws_proposals
Revises: 0134_priv_anchor
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0135_ws_proposals"
down_revision: Union[str, Sequence[str], None] = "0134_priv_anchor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_proposals",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Whoever owns the chat turn that produced the proposal — the only
        # account allowed to apply it.
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # create_note | add_cards | append_note
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        # pending | applied | dismissed
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        # Where the applied change landed (item id) for click-through.
        sa.Column("applied_item_id", UUID(as_uuid=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_ws_proposals_conversation",
        "workspace_proposals",
        ["conversation_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_ws_proposals_conversation", table_name="workspace_proposals")
    op.drop_table("workspace_proposals")
