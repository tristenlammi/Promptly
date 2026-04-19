"""Conversation branching — fork a chat from any point.

Adds three columns to ``conversations`` so the UI can show a
"Branched from" chip and the API can answer "where did this fork
come from?" without an extra metadata table:

* ``parent_conversation_id`` — UUID of the chat the fork was made
  from. ``ON DELETE SET NULL`` so deleting the original keeps the
  branch readable; the chip just hides itself.
* ``parent_message_id`` — UUID of the specific message the fork
  point was anchored to. Same SET NULL rationale.
* ``branched_at`` — when the fork happened. Surfaced in the chip
  hover for context ("forked yesterday").

All three are nullable; the vast majority of conversations are not
branches and stay all-NULL forever. No DB-side defaults — the chat
router populates them when it creates a branch.

Revision ID: 0019_conversation_branching
Revises: 0018_conversation_shares
Create Date: 2026-05-01 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0019_conversation_branching"
down_revision: Union[str, Sequence[str], None] = "0018_conversation_shares"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "parent_conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "parent_message_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "branched_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_conversations_parent_conversation_id",
        "conversations",
        ["parent_conversation_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversations_parent_conversation_id",
        table_name="conversations",
    )
    op.drop_column("conversations", "branched_at")
    op.drop_column("conversations", "parent_message_id")
    op.drop_column("conversations", "parent_conversation_id")
