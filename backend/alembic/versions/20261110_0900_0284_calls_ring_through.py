"""Calls WP-D5: calls and quiet hours.

``push_preferences.call_ring_through``: during your quiet hours a call
doesn't ring you (it becomes a missed call, told when they end) unless this
is on ("Let calls ring during quiet hours"). Off by default, as planned.

Revision ID: 0284_calls_ring_through
Revises: 0283_calls_missed_seen
"""
import sqlalchemy as sa
from alembic import op

revision = "0284_calls_ring_through"
down_revision = "0283_calls_missed_seen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "push_preferences",
        sa.Column("call_ring_through", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("push_preferences", "call_ring_through")
