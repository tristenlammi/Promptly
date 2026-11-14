"""Rooms: delivered ticks, muting for a while, and two server settings.

``room_members.delivered_seq``: how far a conversation's messages are known
to have reached one of that person's devices (``app/rooms/receipts.py``).
``room_members.muted_until`` / ``room_space_members.muted_until``: "mute for
an hour / 8 hours / until tomorrow" on a room or a whole space.
``app_settings.rooms_read_receipts``: Sent / Delivered / Seen in
conversations, for the server (on). ``app_settings.rooms_default_notify``:
the level a person starts with in a space they join ("all").

Revision ID: 0470_rooms_receipts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0470_rooms_receipts"
down_revision = "0455_push_covered_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("room_members", sa.Column("delivered_seq", sa.BigInteger(), nullable=False, server_default="0"))
    # What's been read has been delivered.
    op.execute("UPDATE room_members SET delivered_seq = last_read_seq")
    op.add_column("room_members", sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("room_space_members", sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("app_settings", sa.Column("rooms_read_receipts", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("app_settings", sa.Column("rooms_default_notify", sa.String(8), nullable=False, server_default="all"))


def downgrade() -> None:
    op.drop_column("app_settings", "rooms_default_notify")
    op.drop_column("app_settings", "rooms_read_receipts")
    op.drop_column("room_space_members", "muted_until")
    op.drop_column("room_members", "muted_until")
    op.drop_column("room_members", "delivered_seq")
