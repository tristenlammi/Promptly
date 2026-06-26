"""Per-user connector grants (Phase 10 — Groups follow-up).

Adds ``connector_users`` so a ``restricted`` connector can be granted to
specific individual users directly, alongside group + workspace scoping.

Revision ID: 0113_connector_users
Revises: 0112_user_groups
Create Date: 2026-06-26 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0113_connector_users"
down_revision: Union[str, Sequence[str], None] = "0112_user_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "connector_users",
        sa.Column(
            "connector_id",
            UUID(as_uuid=True),
            sa.ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
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
        "ix_connector_users_user_id", "connector_users", ["user_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_connector_users_user_id", "connector_users")
    op.drop_table("connector_users")
