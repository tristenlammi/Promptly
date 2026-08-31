"""MCP connectors: which wire transport the server speaks.

Streamable-HTTP is the current standard and stays the default, so every
existing connector keeps working untouched. ``sse`` is the older
transport that plenty of real servers still expose — Home Assistant's
Model Context Protocol Server integration among them — and without this
column those servers simply can't be connected at all.

Revision ID: 0163_mcp_transport
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0163_mcp_transport"
down_revision = "0162_commands"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mcp_connectors",
        sa.Column(
            "transport",
            sa.String(8),
            nullable=False,
            server_default="http",
        ),
    )


def downgrade() -> None:
    op.drop_column("mcp_connectors", "transport")
