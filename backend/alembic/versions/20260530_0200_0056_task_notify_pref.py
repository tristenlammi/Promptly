"""Add task_complete notification preference (Phase 1 — T.3).

Adds ``push_preferences.task_complete`` so users can toggle "tell me when
a scheduled task finishes" independently of the other categories.

Revision ID: 0056_task_notify
Revises: 0055_tasks
Create Date: 2026-05-30 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0056_task_notify"
down_revision: Union[str, Sequence[str], None] = "0055_tasks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "push_preferences",
        sa.Column(
            "task_complete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade() -> None:
    op.drop_column("push_preferences", "task_complete")
