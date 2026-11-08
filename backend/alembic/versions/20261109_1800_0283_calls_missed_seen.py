"""Calls WP-D4: the missed-calls badge.

``call_participants.seen_at``: when you saw a call you missed (opened the
Calls tab, or called that conversation since). The badge counts the missed
calls you haven't seen. Calls missed before this migration count as seen.

Revision ID: 0283_calls_missed_seen
Revises: 0282_calls_dm
"""
import sqlalchemy as sa
from alembic import op

revision = "0283_calls_missed_seen"
down_revision = "0282_calls_dm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("call_participants", sa.Column("seen_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE call_participants SET seen_at = now() WHERE ring = 'missed'")
    # The badge's count: your missed calls not seen yet.
    op.create_index(
        "ix_call_participants_missed_unseen",
        "call_participants",
        ["user_id"],
        postgresql_where=sa.text("ring = 'missed' AND seen_at IS NULL AND NOT hidden"),
    )


def downgrade() -> None:
    op.drop_index("ix_call_participants_missed_unseen", table_name="call_participants")
    op.drop_column("call_participants", "seen_at")
