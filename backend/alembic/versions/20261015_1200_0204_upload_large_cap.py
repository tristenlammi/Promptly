"""The largest single upload, for resumable uploads (WP-8.2).

Ordinary uploads stay capped at the request size (100 MB — Cloudflare's
limit too); bigger files go through tusd in chunks, up to this cap, which
an admin sets (NULL = the 10 GB default).

Revision ID: 0204_upload_large_cap
Revises: 0203_upload_versions
"""
from alembic import op
import sqlalchemy as sa

revision = "0204_upload_large_cap"
down_revision = "0203_upload_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("max_upload_bytes_large", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("app_settings", "max_upload_bytes_large")
