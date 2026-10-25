"""Photos: a copy of a photo you already have is hidden, not shown twice.

A phone synced after a Google Takeout sends many photos already in Photos —
often not byte-identical (Google's copy, the phone's original). Each new
photo that is the same picture as one already in the library (the same
file, or taken at the same moment and looking the same) points at it with
``duplicate_of`` and is left out of Photos; the file stays where the phone
put it, so the phone sees it as sent. Deleting the original brings the copy
back (SET NULL).

Revision ID: 0227_photo_duplicate_of
Revises: 0226_photos_folder
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0227_photo_duplicate_of"
down_revision = "0226_photos_folder"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "photo_assets",
        sa.Column(
            "duplicate_of", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True
        ),
    )
    op.create_index(
        "ix_photo_assets_duplicate_of", "photo_assets", ["duplicate_of"], postgresql_where=sa.text("duplicate_of IS NOT NULL")
    )


def downgrade() -> None:
    op.drop_index("ix_photo_assets_duplicate_of", table_name="photo_assets")
    op.drop_column("photo_assets", "duplicate_of")
