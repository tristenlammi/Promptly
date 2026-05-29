"""Add messages.feedback + messages.feedback_reason — response feedback.

Phase 2.5 chat feature: a per-response quality signal (thumbs up/down)
with an optional short reason on thumbs-down. Stored directly on the
message row (mirrors Study mode's ``whiteboard_exercises.ai_feedback``
column pattern) so it surfaces in ``MessageResponse`` without a join.
``feedback`` is ``"up"`` / ``"down"`` / NULL; ``feedback_reason`` is a
free-text note, NULL unless the rater left one.

Revision ID: 0052_msg_feedback
Revises: 0051_conv_sys_prompt
Create Date: 2026-05-29 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0052_msg_feedback"
down_revision: Union[str, Sequence[str], None] = "0051_conv_sys_prompt"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("feedback", sa.String(length=8), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("feedback_reason", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "feedback_reason")
    op.drop_column("messages", "feedback")
