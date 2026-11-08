"""Calls: the server-wide voice switches in app_settings (Admin > Calls).

Revision ID: 0280_calls_settings
Revises: 0260_pw_browsersync
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0280_calls_settings"
down_revision = "0260_pw_browsersync"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("calls_enabled", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("app_settings", sa.Column("calls_group_ids", postgresql.JSONB(), nullable=True))
    op.add_column("app_settings", sa.Column("calls_max_participants", sa.Integer(), nullable=False, server_default="30"))
    op.add_column("app_settings", sa.Column("calls_max_stream", sa.String(8), nullable=False, server_default="1080p60"))


def downgrade() -> None:
    for col in ("calls_max_stream", "calls_max_participants", "calls_group_ids", "calls_enabled"):
        op.drop_column("app_settings", col)
