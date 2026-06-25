"""Add connector kind (Phase 10b — native UniFi/Omada connectors).

Lets a connector be a remote MCP server (kind='mcp', the default) or a
native first-party appliance connector (kind='unifi'|'omada') that calls
the appliance's official API directly. Reuses the whole connector model
(availability, workspace scoping, allow-list); only dispatch + catalog
differ per kind.

Revision ID: 0111_connector_kind
Revises: 0110_mcp_connectors
Create Date: 2026-06-26 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0111_connector_kind"
down_revision: Union[str, Sequence[str], None] = "0110_mcp_connectors"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mcp_connectors",
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="mcp",
        ),
    )


def downgrade() -> None:
    op.drop_column("mcp_connectors", "kind")
