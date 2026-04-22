"""Conversation summary cache — for @chat-name references.

Phase C of the "project memory" work introduces ``@[title](id)``
mention tokens in the composer. When the user sends a message that
contains one, the chat router prepends a summary of the referenced
conversation to the model-facing context so the AI has the right
background without the user having to copy-paste.

Generating that summary from scratch on every turn would be
expensive (another LLM call per mention) and wasteful (the chat
probably hasn't changed between mentions). So we cache the summary
on the conversation row itself:

* ``summary_text`` — the Markdown memo produced by the summariser,
  or ``NULL`` if one's never been generated.
* ``summary_generated_at`` — the timestamp we generated at. The
  cache is considered stale whenever the conversation's latest
  ``messages.created_at`` is newer; at that point the resolver
  regenerates in-place on next mention.

Both columns are nullable; every pre-existing conversation starts
with no cache and lazily fills one the first time it's referenced.
No backfill is needed.

Revision ID: 0030_conversation_summary_cache
Revises: 0029_compare_groups
Create Date: 2026-04-22 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0030_conversation_summary_cache"
down_revision: Union[str, Sequence[str], None] = "0029_compare_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("summary_text", sa.Text(), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "summary_generated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "summary_generated_at")
    op.drop_column("conversations", "summary_text")
