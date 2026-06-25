"""MCP connectors (Phase 10a).

Admin-configured remote MCP servers + the workspace-scoping join.

Revision ID: 0110_mcp_connectors
Revises: 0109_conversation_chunks
Create Date: 2026-06-26 00:00:00

NB: keep the revision id short — ``alembic_version.version_num`` is
``varchar(32)``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0110_mcp_connectors"
down_revision: Union[str, Sequence[str], None] = "0109_conversation_chunks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mcp_connectors",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=40), nullable=False, unique=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("auth_header_name", sa.String(length=64), nullable=True),
        sa.Column("auth_value_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "availability",
            sa.String(length=16),
            nullable=False,
            server_default="global",
        ),
        sa.Column("allowed_tools", JSONB(), nullable=True),
        sa.Column(
            "tool_catalog",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("tools_refreshed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_table(
        "workspace_mcp_connectors",
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "connector_id",
            UUID(as_uuid=True),
            sa.ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("workspace_mcp_connectors")
    op.drop_table("mcp_connectors")
