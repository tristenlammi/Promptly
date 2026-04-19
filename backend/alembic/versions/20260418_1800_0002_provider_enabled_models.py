"""Add model_providers.enabled_models whitelist.

When NULL the provider exposes its entire fetched catalog (backward-compatible
default). When set to a JSON array of model IDs, only those IDs appear in
/api/models/available — letting users curate which of (e.g.) OpenRouter's 300+
models show up in the chat model picker.

Revision ID: 0002_provider_enabled_models
Revises: 0001_initial
Create Date: 2026-04-18 18:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_provider_enabled_models"
down_revision: Union[str, Sequence[str], None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_providers",
        sa.Column(
            "enabled_models",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("model_providers", "enabled_models")
