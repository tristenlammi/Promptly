"""Notes: a Google Keep import is an import job of its own kind.

The job reads a Takeout like any other but brings in only the Keep notes
(``app/imports/keep.py``, Notes N1.6).

Revision ID: 0265_notes_keep_import
Revises: 0264_notes_transcribe
"""
from alembic import op

revision = "0265_notes_keep_import"
down_revision = "0264_notes_transcribe"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_import_jobs_source", "import_jobs", type_="check")
    op.create_check_constraint("ck_import_jobs_source", "import_jobs", "source IN ('takeout', 'folder', 'apple', 'keep')")


def downgrade() -> None:
    op.execute("DELETE FROM import_jobs WHERE source = 'keep'")
    op.drop_constraint("ck_import_jobs_source", "import_jobs", type_="check")
    op.create_check_constraint("ck_import_jobs_source", "import_jobs", "source IN ('takeout', 'folder', 'apple')")
