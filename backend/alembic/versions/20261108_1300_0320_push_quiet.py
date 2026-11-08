"""Quiet hours and the daily summary, for every app.

``push_preferences`` gets one quiet-hours setting (start/end in the
person's own time zone, an optional weekend pair), the categories set to
"Daily summary", and the day the summary last went out. ``push_held`` keeps
the pushes held back until quiet hours end or the summary goes.

Revision ID: 0320_push_quiet
Revises: 0260_pw_browsersync
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0320_push_quiet"
down_revision = "0260_pw_browsersync"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("push_preferences", sa.Column("quiet_enabled", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("push_preferences", sa.Column("quiet_start", sa.Time(), nullable=False, server_default="22:00"))
    op.add_column("push_preferences", sa.Column("quiet_end", sa.Time(), nullable=False, server_default="07:00"))
    op.add_column("push_preferences", sa.Column("quiet_weekend_start", sa.Time(), nullable=True))
    op.add_column("push_preferences", sa.Column("quiet_weekend_end", sa.Time(), nullable=True))
    op.add_column(
        "push_preferences",
        sa.Column("summary_categories", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.add_column("push_preferences", sa.Column("summary_sent_on", sa.Date(), nullable=True))
    op.create_table(
        "push_held",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("url", sa.String(500), nullable=True),
        sa.Column("tag", sa.String(200), nullable=True),
        sa.Column("extra", postgresql.JSONB(), nullable=True),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reason", sa.String(8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("reason IN ('quiet', 'summary')", name="ck_push_held_reason"),
    )
    op.create_index("ix_push_held_user_reason", "push_held", ["user_id", "reason"])


def downgrade() -> None:
    op.drop_index("ix_push_held_user_reason", table_name="push_held")
    op.drop_table("push_held")
    for col in (
        "summary_sent_on",
        "summary_categories",
        "quiet_weekend_end",
        "quiet_weekend_start",
        "quiet_end",
        "quiet_start",
        "quiet_enabled",
    ):
        op.drop_column("push_preferences", col)
