"""Add conversations.title_manually_set flag.

Tracks whether the user has renamed a conversation themselves. When False the
server is free to overwrite the title with an AI-generated summary after the
first assistant response. When True the title is user-owned and never
auto-regenerated.

Revision ID: 0003_conv_title_manual
Revises: 0002_provider_enabled_models
Create Date: 2026-04-18 20:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_conv_title_manual"
down_revision: Union[str, Sequence[str], None] = "0002_provider_enabled_models"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "title_manually_set",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "title_manually_set")
