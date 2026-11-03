"""Saved event snoozes: "Snooze 10 min" on a calendar reminder survives a restart.

Revision ID: 0238_snooze
Revises: 0237_recents
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0238_snooze"
down_revision = "0237_recents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cal_event_snoozes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("occurrence", sa.DateTime(timezone=True), nullable=False),
        sa.Column("until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "event_id", "occurrence", name="uq_cal_event_snoozes"),
    )
    op.create_index("ix_cal_event_snoozes_event_id", "cal_event_snoozes", ["event_id"])
    op.create_index("ix_cal_event_snoozes_until", "cal_event_snoozes", ["until"])


def downgrade() -> None:
    op.drop_index("ix_cal_event_snoozes_until", table_name="cal_event_snoozes")
    op.drop_index("ix_cal_event_snoozes_event_id", table_name="cal_event_snoozes")
    op.drop_table("cal_event_snoozes")
