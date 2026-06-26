"""User groups grant models (role bundle).

Adds ``user_groups.allowed_models`` (JSONB list of model ids). A group's
models are UNIONed into each member's own model access, so a group acts as a
role bundle: connectors + models.

Revision ID: 0114_group_models
Revises: 0113_connector_users
Create Date: 2026-06-26 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0114_group_models"
down_revision: Union[str, Sequence[str], None] = "0113_connector_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_groups",
        sa.Column(
            "allowed_models",
            JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("user_groups", "allowed_models")
