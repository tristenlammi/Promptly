"""Rooms: polls.

A poll is a message (its question, options and settings in ``meta.poll``);
``room_poll_votes`` holds each person's ticks, one row per option, so a vote
is counted once and can be changed.

Revision ID: 0465_room_poll_votes
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0465_room_poll_votes"
down_revision = "0460_rooms_media"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "room_poll_votes",
        sa.Column("message_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("room_messages.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("option", sa.String(8), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_poll_votes_user_id", "room_poll_votes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_room_poll_votes_user_id", table_name="room_poll_votes")
    op.drop_table("room_poll_votes")
