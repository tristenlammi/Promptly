"""Add saved_prompts — reusable prompt templates (Phase 3.1).

Per-user prompt library surfaced via ``/`` in the composer and managed
from the account page. Owned by exactly one user (cascade-delete with
the account); no sharing in v1.

Revision ID: 0053_saved_prompts
Revises: 0052_msg_feedback
Create Date: 2026-05-29 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0053_saved_prompts"
down_revision: Union[str, Sequence[str], None] = "0052_msg_feedback"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saved_prompts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_saved_prompts_user_id", "saved_prompts", ["user_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_saved_prompts_user_id", table_name="saved_prompts")
    op.drop_table("saved_prompts")
