"""Connectors can be switched off per chat (R-161).

Revision ID: 0176_conv_disabled_connectors
Revises: 0175_ws_connector_attached_by
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0176_conv_disabled_connectors"
down_revision = "0175_ws_connector_attached_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversations", sa.Column("disabled_connector_ids", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("conversations", "disabled_connector_ids")
