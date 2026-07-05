"""Team Learning (Study L3): one-shot due-date reminder stamps.

``study_enrollments.due_reminder_sent_at`` / ``overdue_notice_sent_at``
— the hourly reminder sweep sends each notice exactly once.

Revision ID: 0144_due_reminders
Revises: 0143_material_gaps
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0144_due_reminders"
down_revision: Union[str, Sequence[str], None] = "0143_material_gaps"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_enrollments",
        sa.Column("due_reminder_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "study_enrollments",
        sa.Column(
            "overdue_notice_sent_at", sa.DateTime(timezone=True), nullable=True
        ),
    )


def downgrade() -> None:
    op.drop_column("study_enrollments", "overdue_notice_sent_at")
    op.drop_column("study_enrollments", "due_reminder_sent_at")
