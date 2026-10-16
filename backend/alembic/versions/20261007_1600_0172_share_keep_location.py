"""Share links strip photo location unless told to keep it (WP-0.5, D13).

Originals are now stored byte-exact (with their GPS); a share link serves a
metadata-free copy of a photo unless ``keep_location`` is set on it.

Revision ID: 0172_share_keep_location
Revises: 0171_automation_safety
"""
from alembic import op
import sqlalchemy as sa

revision = "0172_share_keep_location"
down_revision = "0171_automation_safety"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "file_share_links",
        sa.Column("keep_location", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("file_share_links", "keep_location")
