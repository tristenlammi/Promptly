"""Add conversations.title_refined flag (deeper re-title pass).

Adds a one-shot boolean so the auto-titler can sharpen a conversation's
title once it reaches ~5 messages (richer context) without re-titling on
every subsequent turn. Defaults to false for existing rows.

Revision ID: 0059_conv_title_refined
Revises: 0058_msg_embeddings
Create Date: 2026-05-30 05:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0059_conv_title_refined"
down_revision: Union[str, Sequence[str], None] = "0058_msg_embeddings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "title_refined",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "title_refined")
