"""Drive search: filenames indexed without English stemming (WP-5.4).

``files.content_tsv`` ran filenames through the ``english`` config, so a
non-English name was stemmed and stop-worded as if it were English
("Rechnungen_2025.pdf", "facturas mayo") and matched poorly, and prefix
matching on names worked on stems. Names now go in with the ``simple``
config (lower-cased words, nothing dropped), split on ``.`` ``_`` ``-`` so
"Q3_budget.pdf" is the words q3 / budget / pdf; file text keeps ``english``.
Search queries both (``app.files.search_query``).

Rebuilding a generated column rewrites the table once.

Revision ID: 0195_files_tsv_simple
Revises: 0194_file_proposals
"""
from alembic import op

revision = "0195_files_tsv_simple"
down_revision = "0194_file_proposals"
branch_labels = None
depends_on = None


def _rebuild(name_config: str, *, split_names: bool) -> None:
    # Split names on "." "_" "-" first, so "mayo.txt" / "Q3_budget" are
    # words ("mayo", "budget"), not one file-name token.
    name_expr = (
        r"regexp_replace(coalesce(filename, ''), '[._\-]+', ' ', 'g')"
        if split_names
        else "coalesce(filename, '')"
    )
    op.execute("DROP INDEX IF EXISTS ix_files_content_tsv;")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS content_tsv;")
    op.execute(
        f"""
        ALTER TABLE files
        ADD COLUMN content_tsv tsvector
        GENERATED ALWAYS AS (
            setweight(to_tsvector('{name_config}', {name_expr}), 'A') ||
            setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
        ) STORED;
        """
    )
    op.execute("CREATE INDEX ix_files_content_tsv ON files USING GIN (content_tsv);")


def upgrade() -> None:
    _rebuild("simple", split_names=True)


def downgrade() -> None:
    _rebuild("english", split_names=False)
