"""PDF versions (WP-6.5).

A PDF filled in, annotated or reorganised in the viewer is saved as new
bytes, and what it replaces becomes a version — the same history (name it,
keep it, restore it) the office files have. A PDF version is a blob, not an
editor state: ``file_versions.storage_path`` points at it in the owner's
bucket. Blobs are immutable — a save writes new bytes to a new path and the
file row moves to it — so a version is just the old path, and a pruned
version's blob is collected by the orphan sweep like any unreferenced one.

Revision ID: 0197_pdf_versions
Revises: 0196_files_collab_epoch
"""
from alembic import op
import sqlalchemy as sa

revision = "0197_pdf_versions"
down_revision = "0196_files_collab_epoch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file_versions", sa.Column("storage_path", sa.String(1024), nullable=True))
    op.create_index(
        "ix_file_versions_storage_path",
        "file_versions",
        ["storage_path"],
        postgresql_where=sa.text("storage_path IS NOT NULL"),
    )
    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard','pdf')"
    )
    op.drop_constraint("ck_file_versions_source", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_source",
        "file_versions",
        "source IN ('auto','manual','restore','import','pre_ai','shrink_guard','edit')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM file_versions WHERE kind = 'pdf' OR source = 'edit'")
    op.drop_constraint("ck_file_versions_source", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_source",
        "file_versions",
        "source IN ('auto','manual','restore','import','pre_ai','shrink_guard')",
    )
    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard')"
    )
    op.drop_index("ix_file_versions_storage_path", table_name="file_versions")
    op.drop_column("file_versions", "storage_path")
