"""Rooms uploads: a file its uploader removed.

``room_attachments.removed_at``: the person who sent a file took it out of
their Rooms uploads (Files → Rooms uploads). The bytes are deleted; the row
stays so the message can say "File removed" instead of losing the file
without a word.

Revision ID: 0490_room_att_removed
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0490_room_att_removed"
down_revision = "0476_home"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("room_attachments", sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True))
    # "Your Rooms uploads, newest first" and the storage sum.
    op.create_index("ix_room_attachments_uploader", "room_attachments", ["uploader_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_room_attachments_uploader", table_name="room_attachments")
    op.drop_column("room_attachments", "removed_at")
