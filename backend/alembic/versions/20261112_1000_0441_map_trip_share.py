"""P Maps: share one trip, and a notification switch for it.

``map_shares.trip`` marks sharing that is for one drive only: it ends when the
phone says the trip is over, and lapses a while after the arrival time if it
never does. ``push_preferences.maps`` is the switch for "Sam is sharing a trip
with you".

Revision ID: 0441_map_trip_share
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0441_map_trip_share"
down_revision = "0370_talk_followup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("map_shares", sa.Column("trip", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("push_preferences", sa.Column("maps", sa.Boolean(), nullable=False, server_default=sa.text("true")))


def downgrade() -> None:
    op.drop_column("push_preferences", "maps")
    op.drop_column("map_shares", "trip")
