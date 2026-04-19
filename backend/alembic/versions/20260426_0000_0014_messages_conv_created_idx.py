"""Add composite index on messages(conversation_id, created_at).

The conversation history query in :mod:`app.chat.router` always
selects messages by ``conversation_id`` ordered by ``created_at``.
The initial schema only indexed ``conversation_id`` alone, which means
Postgres has to read every matching row and then sort. Adding the
composite index makes ordered fetches O(log N) seek + sequential walk
of the index leaf pages — invisible at 10 messages per chat, real
relief once a long-running family thread crosses a few thousand.

We *keep* the original ``ix_messages_conversation_id`` because some
diagnostic admin queries select by conversation_id without an order
clause, and dropping it would force them through the wider composite.

Revision ID: 0014_messages_conv_created_idx
Revises: 0013_web_search_mode
Create Date: 2026-04-26 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0014_messages_conv_created_idx"
down_revision: Union[str, Sequence[str], None] = "0013_web_search_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_messages_conversation_id_created_at",
        "messages",
        ["conversation_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_conversation_id_created_at", table_name="messages")
