"""Albums (WP-9.4, Part E PH-1).

An album holds references to photos — never copies: a photo stays one
file, in its owner's Files, and can be in any number of albums. Members are
viewers or contributors (who add their own photos, kept in their own Files
and counted against their own storage).

Revision ID: 0208_photo_albums
Revises: 0207_photo_library
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0208_photo_albums"
down_revision = "0207_photo_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "albums",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("cover_file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sort", sa.String(8), nullable=False, server_default="newest"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("sort IN ('newest', 'oldest')", name="ck_albums_sort"),
    )
    op.create_index("ix_albums_owner", "albums", ["owner_id"])
    op.create_table(
        "album_items",
        sa.Column("album_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_album_items_file", "album_items", ["file_id"])
    op.create_table(
        "album_members",
        sa.Column("album_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False, server_default="viewer"),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("role IN ('viewer', 'contributor')", name="ck_album_members_role"),
    )
    op.create_index("ix_album_members_user", "album_members", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_album_members_user", table_name="album_members")
    op.drop_table("album_members")
    op.drop_index("ix_album_items_file", table_name="album_items")
    op.drop_table("album_items")
    op.drop_index("ix_albums_owner", table_name="albums")
    op.drop_table("albums")
