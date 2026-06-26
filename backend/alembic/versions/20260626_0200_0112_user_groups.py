"""User groups + connector group/workspace scoping (Phase 10 — Groups).

Adds ``user_groups`` + ``user_group_members`` (admin-managed teams) and a
``connector_groups`` join so a connector can be granted to specific groups.
Generalises connector availability from ``global|workspace`` to
``global|restricted`` — a restricted connector is reachable via its granted
groups (identity) and/or attached workspaces (context).

Revision ID: 0112_user_groups
Revises: 0111_connector_kind
Create Date: 2026-06-26 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0112_user_groups"
down_revision: Union[str, Sequence[str], None] = "0111_connector_kind"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_groups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False, unique=True),
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
        "user_group_members",
        sa.Column(
            "group_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user_groups.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )
    op.create_index(
        "ix_user_group_members_user_id", "user_group_members", ["user_id"]
    )
    op.create_table(
        "connector_groups",
        sa.Column(
            "connector_id",
            UUID(as_uuid=True),
            sa.ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "group_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user_groups.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )
    # Generalise availability: the old 'workspace' value becomes 'restricted'
    # (its workspace attachments still scope it; groups can now be added too).
    op.execute(
        "UPDATE mcp_connectors SET availability = 'restricted' "
        "WHERE availability = 'workspace'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE mcp_connectors SET availability = 'workspace' "
        "WHERE availability = 'restricted'"
    )
    op.drop_table("connector_groups")
    op.drop_index("ix_user_group_members_user_id", "user_group_members")
    op.drop_table("user_group_members")
    op.drop_table("user_groups")
