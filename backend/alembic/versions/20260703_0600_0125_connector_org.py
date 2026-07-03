"""Org-scope MCP connectors (tenant ownership) — security-critical.

Adds ``mcp_connectors.org_id`` so a connector's tools are only ever reachable by
members of the OWNING org. Backfills from the creator's org; slug uniqueness
moves global -> per-org. The chat/task tool-resolution path additionally hard-
filters by org_id (see app.mcp.service.connectors_for_turn).

Revision ID: 0125_connector_org
Revises: 0124_group_org
Create Date: 2026-07-03 06:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0125_connector_org"
down_revision: Union[str, Sequence[str], None] = "0124_group_org"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mcp_connectors",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_mcp_connectors_org_id", "mcp_connectors", ["org_id"])
    op.create_foreign_key(
        "fk_mcp_connectors_org_id_organizations",
        "mcp_connectors",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.execute(
        """
        UPDATE mcp_connectors mc
        SET org_id = u.org_id
        FROM users u
        WHERE mc.created_by = u.id AND u.org_id IS NOT NULL
        """
    )
    op.drop_constraint(
        "mcp_connectors_slug_key", "mcp_connectors", type_="unique"
    )
    op.create_unique_constraint(
        "uq_mcp_connectors_org_slug", "mcp_connectors", ["org_id", "slug"]
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_mcp_connectors_org_slug", "mcp_connectors", type_="unique"
    )
    op.create_unique_constraint(
        "mcp_connectors_slug_key", "mcp_connectors", ["slug"]
    )
    op.drop_constraint(
        "fk_mcp_connectors_org_id_organizations",
        "mcp_connectors",
        type_="foreignkey",
    )
    op.drop_index("ix_mcp_connectors_org_id", table_name="mcp_connectors")
    op.drop_column("mcp_connectors", "org_id")
