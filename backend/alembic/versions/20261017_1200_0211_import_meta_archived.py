"""An imported photo Google had archived stays archived (WP-10.2).

Revision ID: 0211_import_meta_archived
Revises: 0210_import_jobs
"""
from alembic import op
import sqlalchemy as sa

revision = "0211_import_meta_archived"
down_revision = "0210_import_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file_import_meta", sa.Column("archived", sa.Boolean, nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("file_import_meta", "archived")
