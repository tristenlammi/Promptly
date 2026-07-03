"""Org-scope Custom Models (tenant ownership).

Adds ``custom_models.org_id`` so an org admin's assistants are shared with their
members and never visible to other tenants. Backfills org_id from the creator's
org, and makes the slug unique per-org instead of globally.

Revision ID: 0123_custom_model_org
Revises: 0122_provider_org_id
Create Date: 2026-07-03 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0123_custom_model_org"
down_revision: Union[str, Sequence[str], None] = "0122_provider_org_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "custom_models",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_custom_models_org_id", "custom_models", ["org_id"]
    )
    op.create_foreign_key(
        "fk_custom_models_org_id_organizations",
        "custom_models",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # Backfill from the creator's org.
    op.execute(
        """
        UPDATE custom_models cm
        SET org_id = u.org_id
        FROM users u
        WHERE cm.created_by = u.id AND u.org_id IS NOT NULL
        """
    )
    # Slug uniqueness moves from global to per-org.
    op.drop_constraint("custom_models_name_key", "custom_models", type_="unique")
    op.create_unique_constraint(
        "uq_custom_models_org_name", "custom_models", ["org_id", "name"]
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_custom_models_org_name", "custom_models", type_="unique"
    )
    op.create_unique_constraint(
        "custom_models_name_key", "custom_models", ["name"]
    )
    op.drop_constraint(
        "fk_custom_models_org_id_organizations",
        "custom_models",
        type_="foreignkey",
    )
    op.drop_index("ix_custom_models_org_id", table_name="custom_models")
    op.drop_column("custom_models", "org_id")
