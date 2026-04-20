"""Study exam per-unit telemetry: grader notes keyed by unit id.

One additive column on ``study_exams`` so the final-exam grader can
leave a short, structured note on every unit it touched, and the
topic page can surface an "Exam breakdown" section:

* ``unit_notes`` — JSONB dict of ``{unit_id: "1-2 sentence grader
  note"}``. Populated when the tutor emits the ``grade`` exam action
  with a ``unit_notes`` field; nullable for any pre-existing graded
  exam that was scored before this migration ran.

Revision ID: 0024_exam_unit_notes
Revises: 0023_prereq_reason
Create Date: 2026-04-20 06:05:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024_exam_unit_notes"
down_revision: Union[str, Sequence[str], None] = "0023_prereq_reason"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_exams",
        sa.Column(
            "unit_notes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("study_exams", "unit_notes")
