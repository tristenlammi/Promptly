"""Drop all multi-tenant org plumbing (revert to single-tenant self-host).

Promptly is now a free, self-hosted, single-tenant app: one admin manages a
shared pool of providers / models / connectors / groups that every user sees.
The hosted-SaaS org (tenant) layer built in 0120-0127 is removed wholesale:

  * ``organizations`` table + ``org_model_defaults`` table.
  * ``org_id`` (+ its index/FK) on users, model_providers, custom_models,
    user_groups, mcp_connectors.
  * ``users.org_role``, ``users.clerk_user_id`` (Clerk auth is gone), and the
    ``deleted_at`` soft-delete clocks on users + organizations.
  * Per-org slug/name uniqueness reverts to GLOBAL uniqueness.

Irreversible in practice — the org data is discarded. ``downgrade`` recreates
the *structure* (all-NULL columns / empty tables) so alembic history stays
navigable, but it cannot restore the dropped rows.

Revision ID: 0128_drop_org
Revises: 0127_deletion_grace
Create Date: 2026-07-04 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0128_drop_org"
down_revision: Union[str, Sequence[str], None] = "0127_deletion_grace"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- soft-delete clocks (0127) ---------------------------------------
    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_column("users", "deleted_at")
    # organizations.deleted_at + its index go away with the table below.

    # --- org_model_defaults table (0126) ---------------------------------
    op.drop_table("org_model_defaults")

    # --- mcp_connectors.org_id (0125) — revert to global slug uniqueness --
    op.drop_constraint(
        "uq_mcp_connectors_org_slug", "mcp_connectors", type_="unique"
    )
    op.drop_constraint(
        "fk_mcp_connectors_org_id_organizations",
        "mcp_connectors",
        type_="foreignkey",
    )
    op.drop_index("ix_mcp_connectors_org_id", table_name="mcp_connectors")
    op.drop_column("mcp_connectors", "org_id")
    op.create_unique_constraint(
        "uq_mcp_connectors_slug", "mcp_connectors", ["slug"]
    )

    # --- user_groups.org_id (0124) — revert to global name uniqueness -----
    op.drop_constraint("uq_user_groups_org_name", "user_groups", type_="unique")
    op.drop_constraint(
        "fk_user_groups_org_id_organizations", "user_groups", type_="foreignkey"
    )
    op.drop_index("ix_user_groups_org_id", table_name="user_groups")
    op.drop_column("user_groups", "org_id")
    op.create_unique_constraint(
        "uq_user_groups_name", "user_groups", ["name"]
    )

    # --- custom_models.org_id (0123) — revert to global name uniqueness ---
    op.drop_constraint(
        "uq_custom_models_org_name", "custom_models", type_="unique"
    )
    op.drop_constraint(
        "fk_custom_models_org_id_organizations",
        "custom_models",
        type_="foreignkey",
    )
    op.drop_index("ix_custom_models_org_id", table_name="custom_models")
    op.drop_column("custom_models", "org_id")
    op.create_unique_constraint(
        "uq_custom_models_name", "custom_models", ["name"]
    )

    # --- model_providers.org_id (0122) -----------------------------------
    op.drop_constraint(
        "fk_model_providers_org_id_organizations",
        "model_providers",
        type_="foreignkey",
    )
    op.drop_index("ix_model_providers_org_id", table_name="model_providers")
    op.drop_column("model_providers", "org_id")

    # --- users.org_id / org_role + organizations table (0121) ------------
    op.drop_constraint(
        "fk_users_org_id_organizations", "users", type_="foreignkey"
    )
    op.drop_index("ix_users_org_id", table_name="users")
    op.drop_column("users", "org_role")
    op.drop_column("users", "org_id")
    op.drop_index(
        "ix_organizations_clerk_org_id", table_name="organizations"
    )
    op.drop_table("organizations")

    # --- users.clerk_user_id (0120) — Clerk auth removed -----------------
    op.drop_index("ix_users_clerk_user_id", table_name="users")
    op.drop_column("users", "clerk_user_id")


def downgrade() -> None:
    """Recreate the org *structure* (no data). Mirrors 0120-0127 upgrades,
    minus the backfills — the dropped org rows cannot be restored."""
    # --- users.clerk_user_id (0120) --------------------------------------
    op.add_column(
        "users",
        sa.Column("clerk_user_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_users_clerk_user_id", "users", ["clerk_user_id"], unique=True
    )

    # --- organizations + users.org_id/org_role (0121) --------------------
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("clerk_org_id", sa.String(length=255), nullable=True),
        sa.Column(
            "name",
            sa.String(length=255),
            nullable=False,
            server_default="Organization",
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
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_organizations_clerk_org_id",
        "organizations",
        ["clerk_org_id"],
        unique=True,
    )
    op.create_index(
        "ix_organizations_deleted_at",
        "organizations",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
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

    # --- model_providers.org_id (0122) -----------------------------------
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

    # --- custom_models.org_id (0123) -------------------------------------
    op.drop_constraint(
        "uq_custom_models_name", "custom_models", type_="unique"
    )
    op.add_column(
        "custom_models",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_custom_models_org_id", "custom_models", ["org_id"])
    op.create_foreign_key(
        "fk_custom_models_org_id_organizations",
        "custom_models",
        "organizations",
        ["org_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint(
        "uq_custom_models_org_name", "custom_models", ["org_id", "name"]
    )

    # --- user_groups.org_id (0124) ---------------------------------------
    op.drop_constraint("uq_user_groups_name", "user_groups", type_="unique")
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
    op.create_unique_constraint(
        "uq_user_groups_org_name", "user_groups", ["org_id", "name"]
    )

    # --- mcp_connectors.org_id (0125) ------------------------------------
    op.drop_constraint(
        "uq_mcp_connectors_slug", "mcp_connectors", type_="unique"
    )
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
    op.create_unique_constraint(
        "uq_mcp_connectors_org_slug", "mcp_connectors", ["org_id", "slug"]
    )

    # --- org_model_defaults table (0126) ---------------------------------
    _pairs = [
        "default_chat",
        "vision_relay",
        "research",
        "study",
        "study_assessor",
    ]
    cols = [
        sa.Column(
            "org_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    ]
    for name in _pairs:
        cols.append(
            sa.Column(
                f"{name}_provider_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
                nullable=True,
            )
        )
        cols.append(
            sa.Column(f"{name}_model_id", sa.String(255), nullable=True)
        )
    cols.append(
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        )
    )
    cols.append(
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        )
    )
    op.create_table("org_model_defaults", *cols)

    # --- soft-delete clock on users (0127) -------------------------------
    op.add_column(
        "users",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_users_deleted_at",
        "users",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )
