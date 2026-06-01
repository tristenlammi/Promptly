"""Add research_provider_id + research_model_id to app_settings (Phase 11).

Allows admins to designate a specific model for Deep Research runs, separate
from the default chat model. When set, every research job uses this model
regardless of what the user has selected in the chat picker.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "0064_app_settings_research_model"
down_revision = "0063_conv_memory_capture_paused"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "research_provider_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("research_model_id", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "research_model_id")
    op.drop_column("app_settings", "research_provider_id")
