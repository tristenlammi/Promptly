"""Calls WP-D5: calls and quiet hours.

Calls always ring through quiet hours (the owner's decision). This adds the
opt-in to silence them: ``push_preferences.call_quiet_hold`` ("Don't ring
me during quiet hours"). When it's on, a call during your quiet hours
doesn't ring; it rings out to a missed call, told when quiet hours end.
Off by default.

Revision ID: 0284_calls_quiet_hold
Revises: 0283_calls_missed_seen
"""
import sqlalchemy as sa
from alembic import op

revision = "0284_calls_quiet_hold"
down_revision = "0283_calls_missed_seen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "push_preferences",
        sa.Column("call_quiet_hold", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("push_preferences", "call_quiet_hold")
