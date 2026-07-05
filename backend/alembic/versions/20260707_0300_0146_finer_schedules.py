"""Automations E-batch: finer schedules.

* ``tasks.interval_minutes`` — "every N minutes" step (frequency="minutes").
* ``tasks.weekdays`` — weekly multi-day set (0=Mon…6=Sun); non-empty
  supersedes the single ``weekday``.

Revision ID: 0146_finer_schedules
Revises: 0145_msg_tool_calls
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0146_finer_schedules"
down_revision: Union[str, Sequence[str], None] = "0145_msg_tool_calls"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks", sa.Column("interval_minutes", sa.Integer(), nullable=True)
    )
    op.add_column(
        "tasks",
        sa.Column("weekdays", postgresql.ARRAY(sa.Integer()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tasks", "weekdays")
    op.drop_column("tasks", "interval_minutes")
