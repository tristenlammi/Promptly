"""Temporary chats — ephemeral and 1-hour TTL conversations.

Adds two columns to ``conversations`` so the chat router can mark a
conversation as short-lived and the listing endpoint can transparently
hide it once it expires:

* ``temporary_mode`` — ``NULL`` for permanent chats (the overwhelming
  majority), ``'ephemeral'`` for "delete on navigate-away" chats, or
  ``'one_hour'`` for "auto-delete 1h after the last message" chats.
  Stored as VARCHAR rather than a Postgres ENUM so we can add new TTL
  policies later without DDL pain.
* ``expires_at`` — wall-clock deadline after which a background
  sweeper hard-deletes the row. ``NULL`` for permanent chats.
  Set at create time and (for ``one_hour``) refreshed on every new
  message. Listing endpoints lazy-filter ``expires_at < now()`` so
  the user never sees a stale row even between sweeper runs.

Both columns default to NULL so the migration is a pure ADD COLUMN —
existing chats remain permanent.

Revision ID: 0020_temporary_chats
Revises: 0019_conversation_branching
Create Date: 2026-04-19 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0020_temporary_chats"
down_revision: Union[str, Sequence[str], None] = "0019_conversation_branching"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "temporary_mode",
            sa.String(length=16),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    # Partial index — most rows are permanent (NULL expires_at), so a
    # full index would be wasteful. The sweeper and the lazy filter
    # both query ``WHERE expires_at IS NOT NULL AND expires_at < now()``;
    # the partial index keeps that scan cheap as the row count grows.
    op.create_index(
        "ix_conversations_expires_at",
        "conversations",
        ["expires_at"],
        postgresql_where=sa.text("expires_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversations_expires_at",
        table_name="conversations",
    )
    op.drop_column("conversations", "expires_at")
    op.drop_column("conversations", "temporary_mode")
