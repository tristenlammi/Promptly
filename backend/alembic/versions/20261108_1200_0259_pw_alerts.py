"""Passwords: expiry reminders in Calendar and Tasks (pw_reminders), and breach alerts
for people's own email addresses (breach_watch_*, app/breach_watch).

Revision ID: 0259_pw_alerts
Revises: 0258_pw_aliases
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0259_pw_alerts"
down_revision = "0258_pw_aliases"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pw_reminders",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", UUID(as_uuid=True), nullable=False),
        sa.Column("expires_on", sa.Date(), nullable=False),
        sa.Column("weeks", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(60), nullable=False),
        sa.Column("calendar", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("task", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("event_id", UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("early_event_id", UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("task_file_id", UUID(as_uuid=True), nullable=True),
        sa.Column("task_id", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "item_id", name="uq_pw_reminders_user_item"),
    )
    op.create_index("ix_pw_reminders_user_id", "pw_reminders", ["user_id"])
    op.create_index("ix_pw_reminders_item_id", "pw_reminders", ["item_id"])

    op.create_table(
        "breach_watch_config",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("api_key_encrypted", sa.Text(), nullable=True),
        sa.Column("rpm", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("plan", sa.String(60), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(200), nullable=True),
        sa.Column("paused_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "breach_watch_people",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "breach_watch_addresses",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("address", sa.String(320), nullable=False),
        sa.Column("source", sa.String(10), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_check_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "address", name="uq_breach_watch_addresses_user_address"),
    )
    op.create_index("ix_breach_watch_addresses_next", "breach_watch_addresses", ["next_check_at"])
    op.create_table(
        "breach_watch_hits",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("address", sa.String(320), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("breach_date", sa.Date(), nullable=True),
        sa.Column("added_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("found_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "address", "name", name="uq_breach_watch_hits"),
    )
    op.create_index("ix_breach_watch_hits_user_id", "breach_watch_hits", ["user_id"])
    op.create_table(
        "breach_watch_catalog",
        sa.Column("name", sa.String(200), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("domain", sa.String(200), nullable=False, server_default=""),
        sa.Column("data_classes", JSONB(), nullable=False, server_default="[]"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("breach_watch_catalog")
    op.drop_index("ix_breach_watch_hits_user_id", table_name="breach_watch_hits")
    op.drop_table("breach_watch_hits")
    op.drop_index("ix_breach_watch_addresses_next", table_name="breach_watch_addresses")
    op.drop_table("breach_watch_addresses")
    op.drop_table("breach_watch_people")
    op.drop_table("breach_watch_config")
    op.drop_index("ix_pw_reminders_item_id", table_name="pw_reminders")
    op.drop_index("ix_pw_reminders_user_id", table_name="pw_reminders")
    op.drop_table("pw_reminders")
