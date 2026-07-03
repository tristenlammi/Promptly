"""Org-scope user groups (tenant ownership).

Adds ``user_groups.org_id`` so an org admin's groups are their own tenant's.
Backfills from the creator's org; slug uniqueness moves global -> per-org.

Revision ID: 0124_group_org
Revises: 0123_custom_model_org
Create Date: 2026-07-03 05:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0124_group_org"
down_revision: Union[str, Sequence[str], None] = "0123_custom_model_org"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_groups",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_user_groups_org_id", "user_groups", ["org_id"])
    op.create_foreign_key(
        "fk_user_groups_org_id_organizations",
        "user_groups",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.execute(
        """
        UPDATE user_groups g
        SET org_id = u.org_id
        FROM users u
        WHERE g.created_by = u.id AND u.org_id IS NOT NULL
        """
    )
    op.drop_constraint("user_groups_name_key", "user_groups", type_="unique")
    op.create_unique_constraint(
        "uq_user_groups_org_name", "user_groups", ["org_id", "name"]
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_user_groups_org_name", "user_groups", type_="unique"
    )
    op.create_unique_constraint(
        "user_groups_name_key", "user_groups", ["name"]
    )
    op.drop_constraint(
        "fk_user_groups_org_id_organizations", "user_groups", type_="foreignkey"
    )
    op.drop_index("ix_user_groups_org_id", table_name="user_groups")
    op.drop_column("user_groups", "org_id")
