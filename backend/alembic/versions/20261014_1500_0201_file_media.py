"""Photo and video metadata (WP-7.3, Part C §4.3).

``file_media`` — one row per image or video file, filled on the worker by
ExifTool (``-stay_open``) and ffprobe: when it was taken (and how we know:
``exif`` / ``quicktime`` / ``sidecar`` / ``client`` / ``upload``), the UTC
offset, where, its size and orientation, the camera, a video's duration and
codec, the Live Photo pairing (Apple ContentIdentifier) and whether it's a
Samsung / Google motion photo. ``thumbhash`` and ``derivative_state`` are
for the media worker (WP-7.4). People can correct the date and location
(``*_override``) without touching the original.

``files.client_mtime`` — the file's modified time on the device it was
uploaded from (sent with the upload), the fallback "taken" date.

Revision ID: 0201_file_media
Revises: 0200_integrity_guards
"""
from alembic import op
import sqlalchemy as sa

revision = "0201_file_media"
down_revision = "0200_integrity_guards"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("client_mtime", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "file_media",
        sa.Column("file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("taken_at_source", sa.String(16), nullable=True),
        sa.Column("tz_offset", sa.SmallInteger(), nullable=True),
        sa.Column("lat", sa.Float(), nullable=True),
        sa.Column("lon", sa.Float(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("orientation", sa.SmallInteger(), nullable=True),
        sa.Column("make", sa.String(64), nullable=True),
        sa.Column("model", sa.String(96), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("codec", sa.String(32), nullable=True),
        sa.Column("content_identifier", sa.String(64), nullable=True),
        sa.Column("live_pair_file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("motion_video_file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("motion_embedded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("thumbhash", sa.String(64), nullable=True),
        sa.Column("derivative_state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("taken_at_override", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lat_override", sa.Float(), nullable=True),
        sa.Column("lon_override", sa.Float(), nullable=True),
        sa.Column("location_hidden", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("extracted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('image','video','raw')", name="ck_file_media_kind"),
        sa.CheckConstraint(
            "taken_at_source IS NULL OR taken_at_source IN ('exif','quicktime','sidecar','client','upload')",
            name="ck_file_media_taken_source",
        ),
    )
    op.create_index("ix_file_media_taken", "file_media", ["taken_at"])
    op.create_index(
        "ix_file_media_content_id",
        "file_media",
        ["content_identifier"],
        postgresql_where=sa.text("content_identifier IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_file_media_content_id", table_name="file_media")
    op.drop_index("ix_file_media_taken", table_name="file_media")
    op.drop_table("file_media")
    op.drop_column("files", "client_mtime")
