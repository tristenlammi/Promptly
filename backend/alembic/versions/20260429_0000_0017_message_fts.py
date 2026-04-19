"""Full-text search column + GIN index on messages.

Adds a generated ``tsvector`` column (``content_tsv``) on ``messages``
populated from ``content`` using the English text-search configuration,
plus a GIN index for sub-millisecond ``@@`` lookups. Generated columns
mean the application never has to write to ``content_tsv`` — Postgres
keeps it in sync with ``content`` automatically. Powers Phase 4a's
sidebar search box (``GET /api/conversations/search``).

We use the ``english`` text search config because it ships with every
Postgres install and gives reasonable stemming (``running`` matches
``run``) without any extra dictionaries to seed. Self-hosters in other
languages can swap to e.g. ``simple`` by running an out-of-band ALTER
on the column expression — out of scope here.

Revision ID: 0017_message_fts
Revises: 0016_usage_and_message_cost
Create Date: 2026-04-29 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0017_message_fts"
down_revision: Union[str, Sequence[str], None] = "0016_usage_and_message_cost"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Generated column: ``STORED`` (not ``VIRTUAL``) so the GIN index
    # has something to point at. ``coalesce`` keeps tsvector_to_tsquery
    # NULL-safe for legacy rows where content was empty.
    op.execute(
        """
        ALTER TABLE messages
        ADD COLUMN content_tsv tsvector
        GENERATED ALWAYS AS (
            to_tsvector('english', coalesce(content, ''))
        ) STORED;
        """
    )
    op.execute(
        """
        CREATE INDEX ix_messages_content_tsv
        ON messages USING GIN (content_tsv);
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_messages_content_tsv;")
    op.execute("ALTER TABLE messages DROP COLUMN IF EXISTS content_tsv;")
