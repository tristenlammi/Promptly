"""Add study_provider_id / study_model_id + assessor pair to app_settings.

Allows admins to designate a specific model for Study teaching turns,
separate from the default chat model. When set, every Study session
(unit kickoff, per-turn chat, final exam) uses this model regardless of
what the user has selected, keeping the teaching quality consistent.

The optional assessor pair is reserved for the Phase-1 independent
assessor pass: a cheaper, fast model that grades practice reps against a
rubric without needing to be the teacher.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "0072_app_settings_study_model"
down_revision = "0071_project_roles_memory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "study_provider_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("study_model_id", sa.String(255), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "study_assessor_provider_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("study_assessor_model_id", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "study_assessor_model_id")
    op.drop_column("app_settings", "study_assessor_provider_id")
    op.drop_column("app_settings", "study_model_id")
    op.drop_column("app_settings", "study_provider_id")
