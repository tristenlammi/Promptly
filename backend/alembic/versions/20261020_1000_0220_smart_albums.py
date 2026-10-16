"""Smart albums (PH-5): an album that is a saved question ("Always add
Sarah", "Max at the beach") — kept up to date as photos arrive.

The matches are ordinary ``album_items`` (``via_rule``), so sharing,
public links and access work as for any album. A photo the owner takes
out is remembered in ``album_exclusions`` and never put back.

Revision ID: 0220_smart_albums
Revises: 0219_photo_relations
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0220_smart_albums"
down_revision = "0219_photo_relations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("albums", sa.Column("rules", postgresql.JSONB, nullable=True))
    op.add_column("albums", sa.Column("rules_checked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("album_items", sa.Column("via_rule", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.create_table(
        "album_exclusions",
        sa.Column("album_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("album_exclusions")
    op.drop_column("album_items", "via_rule")
    op.drop_column("albums", "rules_checked_at")
    op.drop_column("albums", "rules")
