"""In-thread regeneration versioning — message tree (Phase 2.6).

Adds ``messages.parent_id`` (self-FK lineage) and
``conversations.active_leaf_message_id`` (the currently-visible leaf).
Backfills both so existing conversations become a plain linear chain
ordered by ``created_at`` — fully compatible with the pre-versioning
behaviour.

Revision ID: 0054_msg_versioning
Revises: 0053_saved_prompts
Create Date: 2026-05-29 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0054_msg_versioning"
down_revision: Union[str, Sequence[str], None] = "0053_saved_prompts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_messages_parent_id", "messages", ["parent_id"])
    op.create_foreign_key(
        "fk_messages_parent_id",
        "messages",
        "messages",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column(
        "conversations",
        sa.Column(
            "active_leaf_message_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_conversations_active_leaf_message_id",
        "conversations",
        "messages",
        ["active_leaf_message_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Backfill parent_id: each message's parent is the previous message
    # in the same conversation by (created_at, id).
    op.execute(
        """
        WITH ordered AS (
            SELECT
                id,
                LAG(id) OVER (
                    PARTITION BY conversation_id
                    ORDER BY created_at, id
                ) AS prev_id
            FROM messages
        )
        UPDATE messages m
        SET parent_id = o.prev_id
        FROM ordered o
        WHERE m.id = o.id
          AND o.prev_id IS NOT NULL
        """
    )

    # Backfill active_leaf_message_id: the last message per conversation.
    op.execute(
        """
        WITH last_msg AS (
            SELECT DISTINCT ON (conversation_id)
                conversation_id,
                id
            FROM messages
            ORDER BY conversation_id, created_at DESC, id DESC
        )
        UPDATE conversations c
        SET active_leaf_message_id = last_msg.id
        FROM last_msg
        WHERE c.id = last_msg.conversation_id
        """
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_conversations_active_leaf_message_id",
        "conversations",
        type_="foreignkey",
    )
    op.drop_column("conversations", "active_leaf_message_id")
    op.drop_constraint("fk_messages_parent_id", "messages", type_="foreignkey")
    op.drop_index("ix_messages_parent_id", table_name="messages")
    op.drop_column("messages", "parent_id")
