"""Connectors remember whether they work (R-158).

Revision ID: 0174_mcp_connector_health
Revises: 0173_message_context_usage
"""
from alembic import op
import sqlalchemy as sa

revision = "0174_mcp_connector_health"
down_revision = "0173_message_context_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mcp_connectors", sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("mcp_connectors", sa.Column("last_error", sa.Text(), nullable=True))
    op.add_column("mcp_connectors", sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "mcp_connectors",
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    for col in ("consecutive_failures", "last_error_at", "last_error", "last_ok_at"):
        op.drop_column("mcp_connectors", col)
