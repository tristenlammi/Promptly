"""Media derivatives (WP-7.4, Part C §4.5).

The media worker turns each photo and video into renditions under
``derived/<file_id>/`` — a 320 px WebP grid thumbnail, a 1440 px WebP
preview, a video poster and a web-playable H.264 MP4 — plus a ThumbHash
placeholder in the row. They're regenerable and never counted against
anyone's storage.

``file_media`` gains what the worker needs to be the source of truth:
``renditions`` (what it made: name → width/height/bytes), ``derived_bytes``
(shown to admins), ``attempts`` and ``processing_started_at`` (the reaper
puts back jobs stuck in ``processing``). ``derivative_state`` already exists:
pending → processing → ready | failed | skipped.

Revision ID: 0202_media_derivatives
Revises: 0201_file_media
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0202_media_derivatives"
down_revision = "0201_file_media"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file_media", sa.Column("renditions", postgresql.JSONB(), nullable=True))
    op.add_column("file_media", sa.Column("derived_bytes", sa.BigInteger(), nullable=False, server_default="0"))
    op.add_column("file_media", sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"))
    op.add_column("file_media", sa.Column("processing_started_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "ck_file_media_derivative_state",
        "file_media",
        "derivative_state IN ('pending','processing','ready','failed','skipped')",
    )
    op.create_index("ix_file_media_derivative_state", "file_media", ["derivative_state"])


def downgrade() -> None:
    op.drop_index("ix_file_media_derivative_state", table_name="file_media")
    op.drop_constraint("ck_file_media_derivative_state", "file_media", type_="check")
    op.drop_column("file_media", "processing_started_at")
    op.drop_column("file_media", "attempts")
    op.drop_column("file_media", "derived_bytes")
    op.drop_column("file_media", "renditions")
