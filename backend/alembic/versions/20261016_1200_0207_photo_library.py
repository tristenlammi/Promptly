"""The photo library (WP-9.1, Part E PH-1).

``photo_assets``: one row per photo or video in someone's library — when it
was taken (the instant, and the wall-clock time where it was taken, which
orders the timeline and makes its days), whether it's the hidden half of a
Live Photo, and whether it's archived. Filled from ``file_media`` here and
kept in step as files are read (the media worker) or their date is edited.

``file_folders.hide_from_photos``: a folder (and everything in it) left out
of Photos.

Revision ID: 0207_photo_library
Revises: 0206_files_md5
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0207_photo_library"
down_revision = "0206_files_md5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_assets",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("taken_local", sa.DateTime(timezone=False), nullable=False),
        sa.Column("live_hidden", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("kind IN ('image', 'video')", name="ck_photo_assets_kind"),
    )
    op.create_index(
        "ix_photo_assets_timeline", "photo_assets",
        ["user_id", sa.text("taken_local DESC"), sa.text("file_id DESC")],
    )
    op.add_column(
        "file_folders",
        sa.Column("hide_from_photos", sa.Boolean, nullable=False, server_default=sa.text("false")),
    )
    op.execute(
        """
        INSERT INTO photo_assets (file_id, user_id, kind, taken_at, taken_local, live_hidden)
        SELECT f.id, f.user_id, CASE WHEN fm.kind = 'video' THEN 'video' ELSE 'image' END,
               COALESCE(fm.taken_at_override, fm.taken_at, f.client_mtime, f.created_at),
               (COALESCE(fm.taken_at_override, fm.taken_at, f.client_mtime, f.created_at) AT TIME ZONE 'UTC')
                 + make_interval(mins => CASE WHEN fm.taken_at_override IS NULL THEN COALESCE(fm.tz_offset, 0) ELSE 0 END),
               (fm.kind = 'video' AND fm.live_pair_file_id IS NOT NULL)
        FROM file_media fm
        JOIN files f ON f.id = fm.file_id
        WHERE fm.kind IN ('image', 'video', 'raw') AND fm.extracted_at IS NOT NULL AND f.user_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("file_folders", "hide_from_photos")
    op.drop_index("ix_photo_assets_timeline", table_name="photo_assets")
    op.drop_table("photo_assets")
