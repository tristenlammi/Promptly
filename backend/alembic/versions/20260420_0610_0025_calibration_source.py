"""Study calibration source + skip-honesty one-shot timestamp.

Two additive columns on ``study_projects`` so the Phase-3 skip-honesty
check can fire exactly once when the tutor later discovers a gap the
warm-up would have caught:

* ``calibration_source`` — short tag (``skipped`` / ``tutor_set`` /
  ``tutor_insert`` / NULL) recording HOW calibration flipped on for
  this project. Set at the moment calibration flips and never
  overwritten afterwards.
* ``calibration_warning_sent_at`` — timestamp of the one-shot
  ``calibration_warning`` SSE event. Gating column so the "heads up,
  you skipped the warm-up" banner fires at most once per project.
  NULL means "not fired yet"; any value means "already shown".

Revision ID: 0025_calibration_source
Revises: 0024_exam_unit_notes
Create Date: 2026-04-20 06:10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0025_calibration_source"
down_revision: Union[str, Sequence[str], None] = "0024_exam_unit_notes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_projects",
        sa.Column("calibration_source", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "study_projects",
        sa.Column(
            "calibration_warning_sent_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("study_projects", "calibration_warning_sent_at")
    op.drop_column("study_projects", "calibration_source")
