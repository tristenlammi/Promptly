"""Photos cleanup (PH-7): what the owner said to keep.

Cleanup suggests duplicates, blurry shots, screenshots and large videos
to move to the trash; "Keep" on one of them is remembered here (per
reason), so it isn't suggested again.

Revision ID: 0222_photo_cleanup
Revises: 0221_photo_memories
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0222_photo_cleanup"
down_revision = "0221_photo_memories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_cleanup_kept",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("reason", sa.String(16), primary_key=True),  # duplicate | blurry | screenshot | large_video
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("photo_cleanup_kept")
