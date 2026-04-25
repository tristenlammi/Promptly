"""Files — full-text search index.

Adds a generated ``content_tsv`` column to ``files`` that stitches
together two weighted parts:

- filename (weight A) — so a match on the name always ranks above a
  match buried in the body.
- ``content_text`` (weight B) — the extracted plain-text payload
  populated by the upload pipeline (see
  ``backend/app/files/extraction.py``). NULL for binary uploads.

Mirrors the pattern used for messages in migration 0017. Stored
generated columns mean Postgres keeps the tsvector in sync
automatically; the app only has to write ``content_text``.

A GIN index on the tsvector makes ``@@`` lookups sub-millisecond
even at tens of thousands of files.

Revision ID: 0036_files_fts
Revises: 0035_files_trash_starred
Create Date: 2026-04-25 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0036_files_fts"
down_revision: Union[str, Sequence[str], None] = "0035_files_trash_starred"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Content column. NULL for unextractable binaries so we don't
    # waste tsvector space on garbage; the filename-only index still
    # catches name matches for those rows.
    op.execute("ALTER TABLE files ADD COLUMN content_text TEXT;")
    # Weighted generated tsvector. ``A`` > ``B`` in ts_rank means
    # ``invoice.pdf`` matches higher than a body with "invoice"
    # scattered through 40 pages. Coalesce keeps us NULL-safe on
    # legacy rows.
    op.execute(
        """
        ALTER TABLE files
        ADD COLUMN content_tsv tsvector
        GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(filename, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
        ) STORED;
        """
    )
    op.execute(
        """
        CREATE INDEX ix_files_content_tsv
        ON files USING GIN (content_tsv);
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_files_content_tsv;")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS content_tsv;")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS content_text;")
