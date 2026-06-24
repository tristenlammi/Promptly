"""Add a one-line title/summary to task runs.

Runs in the Tasks rail were indistinguishable (a wall of identical
"DD Mon · Done" rows). ``task_runs.title`` holds a short summary derived
from each run's output so the user can find a specific edition.

Revision ID: 0107_task_run_title
Revises: 0106_drop_email_attachments
Create Date: 2026-06-24 01:00:00

NB: keep the revision id short — ``alembic_version.version_num`` is
``varchar(32)``, so a longer id overflows when alembic records the head.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0107_task_run_title"
down_revision: Union[str, Sequence[str], None] = "0106_drop_email_attachments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_runs",
        sa.Column("title", sa.String(length=140), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_runs", "title")
