"""Rooms: delivered ticks and muting for a while.

``room_members.delivered_seq``: how far a conversation's messages are known
to have reached one of that person's devices (``app/rooms/receipts.py``).
``room_members.muted_until`` / ``room_space_members.muted_until``: "mute for
an hour / 8 hours / until tomorrow" on a room or a whole space.

The two server-wide switches that go with these (read receipts on or off, the
level a person starts a space with) are Admin → Rooms settings
(``app/rooms/settings.py``, in ``app_settings.rooms_settings`` from 0460), not
columns.

Revision ID: 0470_rooms_receipts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0470_rooms_receipts"
down_revision = "0465_room_poll_votes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("room_members", sa.Column("delivered_seq", sa.BigInteger(), nullable=False, server_default="0"))
    # What's been read has been delivered.
    op.execute("UPDATE room_members SET delivered_seq = last_read_seq")
    op.add_column("room_members", sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("room_space_members", sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("room_space_members", "muted_until")
    op.drop_column("room_members", "muted_until")
    op.drop_column("room_members", "delivered_seq")
