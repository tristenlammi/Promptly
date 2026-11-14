"""Rooms: server-wide switches for voice messages and polls.

``app_settings.rooms_voice_messages`` (on), ``rooms_voice_max_seconds``
(600), ``rooms_voice_transcripts`` (unset: on with the server's own Whisper,
off with cloud speech-to-text until the admin agrees) and ``rooms_polls``
(on). Read by ``app/rooms/features.py``.

Revision ID: 0466_rooms_voice_poll_set
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0466_rooms_voice_poll_set"
down_revision = "0465_room_poll_votes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("rooms_voice_messages", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("app_settings", sa.Column("rooms_voice_max_seconds", sa.Integer(), nullable=False, server_default="600"))
    op.add_column("app_settings", sa.Column("rooms_voice_transcripts", sa.Boolean(), nullable=True))
    op.add_column("app_settings", sa.Column("rooms_polls", sa.Boolean(), nullable=False, server_default="true"))


def downgrade() -> None:
    for col in ("rooms_polls", "rooms_voice_transcripts", "rooms_voice_max_seconds", "rooms_voice_messages"):
        op.drop_column("app_settings", col)
