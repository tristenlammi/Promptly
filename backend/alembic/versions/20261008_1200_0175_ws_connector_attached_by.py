"""Remember who attached a connector to a workspace (R-156).

Revision ID: 0175_ws_connector_attached_by
Revises: 0174_mcp_connector_health
"""
from alembic import op
import sqlalchemy as sa

revision = "0175_ws_connector_attached_by"
down_revision = "0174_mcp_connector_health"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspace_mcp_connectors",
        sa.Column("attached_by_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("workspace_mcp_connectors", "attached_by_admin")
