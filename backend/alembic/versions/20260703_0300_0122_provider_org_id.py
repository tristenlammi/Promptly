"""Org-level BYOK: model_providers.org_id (tenant ownership).

Providers become owned by the tenant (Organization): an org admin configures
them once and every member inherits the models. ``org_id`` NULL + ``user_id``
NULL = a platform system provider (embedder etc.), never visible to tenants.

Backfills org_id from each provider's owning user's org so existing per-user
BYOK providers become their org's providers.

Revision ID: 0122_provider_org_id
Revises: 0121_organizations
Create Date: 2026-07-03 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0122_provider_org_id"
down_revision: Union[str, Sequence[str], None] = "0121_organizations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_providers",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_model_providers_org_id", "model_providers", ["org_id"]
    )
    op.create_foreign_key(
        "fk_model_providers_org_id_organizations",
        "model_providers",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # Backfill: a provider owned by a user who belongs to an org becomes that
    # org's provider. System providers (user_id NULL) and providers whose owner
    # has no org stay org_id NULL.
    op.execute(
        """
        UPDATE model_providers mp
        SET org_id = u.org_id
        FROM users u
        WHERE mp.user_id = u.id AND u.org_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_model_providers_org_id_organizations",
        "model_providers",
        type_="foreignkey",
    )
    op.drop_index("ix_model_providers_org_id", table_name="model_providers")
    op.drop_column("model_providers", "org_id")
