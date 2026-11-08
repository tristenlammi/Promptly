"""Passwords: browser sync of open tabs, sent tabs, history and the reading list.

Revision ID: 0260_pw_browsersync
Revises: 0259_pw_alerts
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0260_pw_browsersync"
down_revision = "0259_pw_alerts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pw_sync_state",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("rev", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("history_days", sa.Integer(), nullable=False, server_default="90"),
    )
    op.create_table(
        "pw_sync_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pw_devices.id", ondelete="CASCADE"), nullable=True),
        sa.Column("slot", sa.String(40), nullable=False, server_default=""),
        sa.Column("blob", sa.LargeBinary(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("rev", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "kind", "device_id", "slot", name="uq_pw_sync_record_slot"),
    )
    op.create_index("ix_pw_sync_records_user_kind_rev", "pw_sync_records", ["user_id", "kind", "rev"])


def downgrade() -> None:
    op.drop_index("ix_pw_sync_records_user_kind_rev", table_name="pw_sync_records")
    op.drop_table("pw_sync_records")
    op.drop_table("pw_sync_state")
