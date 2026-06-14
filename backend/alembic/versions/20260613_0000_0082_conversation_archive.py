"""Conversation archive — soft-hide chats from the sidebar/search.

Adds a nullable ``archived_at`` timestamp to ``conversations``. NULL
means the chat is active (shows in the sidebar + global search); a set
timestamp moves it to the dedicated Archive page, where it can be read,
restored, or permanently deleted. Soft-archive keeps the row (and all
its messages) intact — unlike the hard DELETE, which is now only
reachable from the Archive page.

A partial index on ``(user_id, archived_at)`` keeps both the "active
list" (archived_at IS NULL) and the "archive list" (archived_at IS NOT
NULL) lookups cheap without bloating the index with the common NULL case.

Revision ID: 0082_conversation_archive
Revises: 0081_comprehension_confirmed
Create Date: 2026-06-13 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0082_conversation_archive"
down_revision: Union[str, Sequence[str], None] = "0081_comprehension_confirmed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_conversations_user_archived",
        "conversations",
        ["user_id", "archived_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversations_user_archived", table_name="conversations"
    )
    op.drop_column("conversations", "archived_at")
