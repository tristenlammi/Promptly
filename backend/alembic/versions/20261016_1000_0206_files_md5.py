"""MD5 alongside SHA-256 and SHA-1, for WebDAV sync clients (WP-8.4).

rclone's owncloud mode compares MD5 when ``rclone check`` runs; with only
SHA-1 it couldn't compare anything. Filled as files are written, and for
older ones by the hourly hash backfill.

Revision ID: 0206_files_md5
Revises: 0205_app_passwords
"""
from alembic import op
import sqlalchemy as sa

revision = "0206_files_md5"
down_revision = "0205_app_passwords"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("md5", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("files", "md5")
