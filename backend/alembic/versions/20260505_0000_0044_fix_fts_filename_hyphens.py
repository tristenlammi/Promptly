"""Files — full-text search index: handle hyphenated filenames.

The original ``files.content_tsv`` generated column (added in 0036)
tokenised the filename component with Postgres's ``english`` text
search config straight off ``coalesce(filename, '')``. The
``english`` config's tokeniser breaks on whitespace but treats
hyphens as part of a single compound token, which means a file
named ``quarterly-report.pdf`` produced the lexemes ``quarterly``
and ``report`` *as one token* — searching for the natural-language
phrase ``quarterly report`` did **not** match. Browsing users
overwhelmingly expect those two queries to be equivalent.

This migration rebuilds the generated column with a pre-tokenise
``replace(filename, '-', ' ')`` so hyphens act as word separators
on the filename side, matching how users actually search for files.
The content-body component is unchanged: hyphens inside extracted
document text are not a UX problem (and replacing them there would
mangle technical strings inside docs).

Because ``content_tsv`` is a STORED generated column, we have to:

1. Drop the GIN index that references it.
2. Drop the column itself.
3. Recreate the column with the new generation expression.
4. Recreate the GIN index.

Postgres recomputes every row's tsvector on column add, so the
backfill happens transparently inside the same migration step — no
separate UPDATE pass needed.

Downgrade reverses the rebuild, restoring 0036's original
expression. This is a one-line change to the generation formula; no
data is lost in either direction.

Revision ID: 0044_fix_fts_filename_hyphens
Revises: 0043_grant_can_edit
Create Date: 2026-05-05 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0044_fix_fts_filename_hyphens"
down_revision: Union[str, None] = "0043_grant_can_edit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Drop the dependent index first — Postgres refuses to drop a
    #    generated column while an index still references it.
    op.execute("DROP INDEX IF EXISTS ix_files_content_tsv;")
    # 2) Drop the column with the old generation expression.
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS content_tsv;")
    # 3) Recreate the column with the hyphen-aware filename
    #    tokenisation. Body tokenisation stays as-is on purpose.
    op.execute(
        """
        ALTER TABLE files
        ADD COLUMN content_tsv tsvector
        GENERATED ALWAYS AS (
            setweight(
                to_tsvector(
                    'english',
                    coalesce(replace(filename, '-', ' '), '')
                ),
                'A'
            )
            ||
            setweight(
                to_tsvector('english', coalesce(content_text, '')),
                'B'
            )
        ) STORED;
        """
    )
    # 4) Rebuild the GIN index so ``@@`` lookups stay sub-millisecond.
    op.execute(
        """
        CREATE INDEX ix_files_content_tsv
        ON files USING GIN (content_tsv);
        """
    )


def downgrade() -> None:
    # Mirror image — drop, then recreate with 0036's original
    # (non-hyphen-aware) generation expression.
    op.execute("DROP INDEX IF EXISTS ix_files_content_tsv;")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS content_tsv;")
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
