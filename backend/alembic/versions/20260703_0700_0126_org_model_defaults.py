"""org_model_defaults: per-org model-role defaults

Introduces a per-org overrides table for the "which model fills role X?"
defaults (chat / vision-relay / research / study / assessor). These reference
org-scoped BYOK providers, so a single global default can't serve every tenant.

Backfill: copy the current *global* ``app_settings`` model-default pairs into
the platform admin's org (the account that configured them — its providers are
what those ids point at) so the operator's own tenant keeps working after the
cutover. Other orgs start unconfigured and set their own.

Revision ID: 0126_org_model_defaults
Revises: 0125_connector_org
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0126_org_model_defaults"
down_revision: Union[str, Sequence[str], None] = "0125_connector_org"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PAIRS = [
    "default_chat",
    "vision_relay",
    "research",
    "study",
    "study_assessor",
]


def upgrade() -> None:
    cols = [
        sa.Column(
            "org_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    ]
    for name in _PAIRS:
        cols.append(
            sa.Column(
                f"{name}_provider_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
                nullable=True,
            )
        )
        cols.append(sa.Column(f"{name}_model_id", sa.String(255), nullable=True))
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

    # Backfill: for the org(s) that a platform admin (role='admin') belongs to,
    # seed the row from the current global app_settings pairs. DISTINCT ON keeps
    # one row per org even if (hypothetically) an org had >1 admin. Only fires
    # when the global defaults are actually set — otherwise inserts NULLs, which
    # is harmless (equivalent to "unconfigured").
    pair_cols = ", ".join(
        f"s.{name}_provider_id, s.{name}_model_id" for name in _PAIRS
    )
    insert_cols = ", ".join(
        f"{name}_provider_id, {name}_model_id" for name in _PAIRS
    )
    op.execute(
        sa.text(
            f"""
            INSERT INTO org_model_defaults (org_id, {insert_cols})
            SELECT DISTINCT ON (u.org_id) u.org_id, {pair_cols}
            FROM users u
            CROSS JOIN app_settings s
            WHERE u.role = 'admin'
              AND u.org_id IS NOT NULL
              AND s.id = '00000000-0000-0000-0000-000000000001'
            ORDER BY u.org_id, u.created_at ASC
            ON CONFLICT (org_id) DO NOTHING
            """
        )
    )


def downgrade() -> None:
    op.drop_table("org_model_defaults")
