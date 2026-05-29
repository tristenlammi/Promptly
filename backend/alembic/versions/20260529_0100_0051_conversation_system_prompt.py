"""Add conversations.system_prompt — per-conversation custom instructions.

Phase 1 chat feature: a free-text steer ("answer concisely", "you're a
Rust expert") that lives on the conversation itself, without requiring a
Project. The chat router merges it into the outbound system prompt (it
takes precedence over the project-level prompt but sits under the
tool/personal-context layers). NULL / blank means no per-chat steer.

Revision ID: 0051_conv_sys_prompt
Revises: 0050_drop_conv_shares
Create Date: 2026-05-29 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0051_conv_sys_prompt"
down_revision: Union[str, Sequence[str], None] = "0050_drop_conv_shares"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("system_prompt", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversations", "system_prompt")
