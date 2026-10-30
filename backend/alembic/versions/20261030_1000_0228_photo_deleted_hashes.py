"""Photos: what you deleted stays deleted — a phone never sends it back.

When a photo is deleted for good (Empty trash, Delete forever, the 30-day
sweep), its SHA-256 is remembered per person. A phone app checking "do you
have this?" before sending is told to skip it, even after the phone was
re-linked and has forgotten what it already sent.

Revision ID: 0228_photo_deleted_hashes
Revises: 0227_photo_duplicate_of
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0228_photo_deleted_hashes"
down_revision = "0227_photo_duplicate_of"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_deleted_hashes",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("sha256", sa.String(64), primary_key=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("photo_deleted_hashes")
