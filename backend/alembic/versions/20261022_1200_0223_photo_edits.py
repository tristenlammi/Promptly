"""Photo edits (PH-7): crop, rotate, flip and light adjustments, kept as a
record beside the untouched original.

The grid and viewer show renditions made with the edit
(``thumb.edit.webp`` / ``preview.edit.webp``); everything that reads a
photo for understanding still reads the original's. Revert deletes the
row and those renditions.

Revision ID: 0223_photo_edits
Revises: 0222_photo_cleanup
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0223_photo_edits"
down_revision = "0222_photo_cleanup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_edits",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ops", postgresql.JSONB, nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("photo_edits")
