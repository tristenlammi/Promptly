"""Versions for every uploaded file (WP-8.1, Part C §5.8).

Uploading a file with a name already in the folder and choosing Replace used
to move the old one to the trash — a new row, so its shares, star, comments
and links went with it. Now the file stays the same file and its old bytes
become a version (``kind='blob'``), as PDFs saved in the viewer already do
(WP-6.5). An AI document re-rendered from its edited source (and the source
itself) keeps what it replaces the same way, and so will a WebDAV PUT
(WP-8.4).

Revision ID: 0203_upload_versions
Revises: 0202_media_derivatives
"""
from alembic import op

revision = "0203_upload_versions"
down_revision = "0202_media_derivatives"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard','pdf','blob')"
    )
    op.drop_constraint("ck_file_versions_source", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_source",
        "file_versions",
        "source IN ('auto','manual','restore','import','pre_ai','shrink_guard','edit','upload','generated','dav')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM file_versions WHERE kind = 'blob' OR source IN ('upload','generated','dav')")
    op.drop_constraint("ck_file_versions_source", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_source",
        "file_versions",
        "source IN ('auto','manual','restore','import','pre_ai','shrink_guard','edit')",
    )
    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard','pdf')"
    )
