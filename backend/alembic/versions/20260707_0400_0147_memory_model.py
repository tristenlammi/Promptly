"""Memory follow-ups: dedicated extraction/consolidation model.

Adds the ``memory_provider_id`` / ``memory_model_id`` pair to
``app_settings`` — same shape as the research/study/assessor pairs.
When set, memory capture and consolidation run on this model instead of
riding whatever model the conversation happens to use (predictable cost,
predictable JSON-op quality). NULL = current behaviour (conversation
model for capture; default chat model for consolidation).

Revision ID: 0147_memory_model
Revises: 0146_finer_schedules
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0147_memory_model"
down_revision: Union[str, Sequence[str], None] = "0146_finer_schedules"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "memory_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "model_providers.id",
                ondelete="SET NULL",
                name="fk_app_settings_memory_provider",
            ),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("memory_model_id", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "memory_model_id")
    op.drop_column("app_settings", "memory_provider_id")
