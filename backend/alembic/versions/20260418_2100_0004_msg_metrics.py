"""Add per-assistant-message performance metrics.

Captures what users see in the tooltip next to each AI reply:
  - prompt_tokens / completion_tokens from the provider's usage payload
  - ttft_ms: time between request dispatch and the first streamed token
  - total_ms: end-to-end stream duration (request start -> final token)

All nullable because historical rows don't have them and short-lived provider
errors can still produce a partial message with no usage data.

Revision ID: 0004_msg_metrics
Revises: 0003_conv_title_manual
Create Date: 2026-04-18 21:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_msg_metrics"
down_revision: Union[str, Sequence[str], None] = "0003_conv_title_manual"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("ttft_ms", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("total_ms", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "total_ms")
    op.drop_column("messages", "ttft_ms")
    op.drop_column("messages", "completion_tokens")
    op.drop_column("messages", "prompt_tokens")
