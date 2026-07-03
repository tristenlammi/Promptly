"""Organizations (tenants) + user membership.

Every account is an Organization (a solo user = a 1-seat org). Shadow of a Clerk
Organization: Clerk owns membership/billing, this anchors app-side FKs + a
seat/plan/storage mirror. Adds ``users.org_id`` + ``users.org_role``.

Revision ID: 0121_organizations
Revises: 0120_clerk_user_id
Create Date: 2026-07-03 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0121_organizations"
down_revision: Union[str, Sequence[str], None] = "0120_clerk_user_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("clerk_org_id", sa.String(length=255), nullable=True),
        sa.Column(
            "name", sa.String(length=255), nullable=False, server_default="Organization"
        ),
        sa.Column("plan", sa.String(length=64), nullable=True),
        sa.Column("seat_limit", sa.Integer(), nullable=True),
        sa.Column("storage_cap_bytes", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_organizations_clerk_org_id",
        "organizations",
        ["clerk_org_id"],
        unique=True,
    )
    op.add_column(
        "users",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "users", sa.Column("org_role", sa.String(length=16), nullable=True)
    )
    op.create_index("ix_users_org_id", "users", ["org_id"])
    op.create_foreign_key(
        "fk_users_org_id_organizations",
        "users",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_users_org_id_organizations", "users", type_="foreignkey"
    )
    op.drop_index("ix_users_org_id", table_name="users")
    op.drop_column("users", "org_role")
    op.drop_column("users", "org_id")
    op.drop_index("ix_organizations_clerk_org_id", table_name="organizations")
    op.drop_table("organizations")
