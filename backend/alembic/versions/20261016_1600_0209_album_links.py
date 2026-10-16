"""Public album links (WP-9.5): a share link can point at an album.

Revision ID: 0209_album_links
Revises: 0208_photo_albums
"""
from alembic import op

revision = "0209_album_links"
down_revision = "0208_photo_albums"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("file_share_links_resource_type_check", "file_share_links", type_="check")
    op.create_check_constraint(
        "file_share_links_resource_type_check", "file_share_links", "resource_type IN ('file','folder','album')"
    )


def downgrade() -> None:
    op.execute("UPDATE file_share_links SET revoked_at = COALESCE(revoked_at, now()) WHERE resource_type = 'album'")
    op.execute("DELETE FROM file_share_links WHERE resource_type = 'album'")
    op.drop_constraint("file_share_links_resource_type_check", "file_share_links", type_="check")
    op.create_check_constraint(
        "file_share_links_resource_type_check", "file_share_links", "resource_type IN ('file','folder')"
    )
