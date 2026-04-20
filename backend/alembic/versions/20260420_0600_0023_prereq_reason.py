"""Study prereq insert metadata: reason + batch_id on inserted units.

Two new additive columns on ``study_units`` so the topic page can show
a self-explanatory banner for tutor-inserted prerequisite batches:

* ``prereq_reason`` — one-sentence reason the tutor supplied in the
  ``<unit_action>{"type":"insert_prerequisites", ...}`` payload. Shown
  above the affected UnitCards so the student can see why the plan
  was modified without having to hunt back through chat.
* ``prereq_batch_id`` — shared UUID written on every unit inserted by
  the same emit. Lets the UI group multiple inserts from one tutor
  reply into a single banner (and key localStorage dismissal).

Both are nullable so any existing pre-Phase-2 unit rows stay valid.

Revision ID: 0023_prereq_reason
Revises: 0022_study_calibration
Create Date: 2026-04-20 06:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0023_prereq_reason"
down_revision: Union[str, Sequence[str], None] = "0022_study_calibration"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_units",
        sa.Column("prereq_reason", sa.Text(), nullable=True),
    )
    op.add_column(
        "study_units",
        sa.Column(
            "prereq_batch_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("study_units", "prereq_batch_id")
    op.drop_column("study_units", "prereq_reason")
