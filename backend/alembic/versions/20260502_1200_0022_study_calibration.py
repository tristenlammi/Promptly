"""Study calibration: self-reported level + calibration flag + inserted-prereq marker.

Three new columns, all additive, no data rewrites:

* ``study_projects.current_level`` — student's self-reported starting
  level collected in the New Study wizard. One of ``beginner`` /
  ``some_exposure`` / ``refresher``, or NULL if they skipped the field.
  Read by the planner to pace the generated plan and by the unit
  tutor to anchor its register.
* ``study_projects.calibrated`` — whether the Unit 1 diagnostic has
  run on this project. Starts false; flipped true by the tutor
  emitting a ``calibration_complete`` action (or by the prerequisite-
  insertion action carrying ``mark_calibrated: true``). Reset to false
  on plan regeneration. Added in this migration so Phase 3 doesn't
  need a follow-up schema change.
* ``study_units.inserted_as_prereq`` — set true on units the tutor
  inserted mid-plan via ``insert_prerequisites``. Surfaced in the UI
  with an "added by tutor" accent so the student can tell which
  units came from the original plan and which are fill-in
  foundations. Also added now for the same forward-compat reason.

All three are nullable or have safe defaults so rollback is clean.

Revision ID: 0022_study_calibration
Revises: 0021_study_topics_units
Create Date: 2026-05-02 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0022_study_calibration"
down_revision: Union[str, Sequence[str], None] = "0021_study_topics_units"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_projects",
        sa.Column("current_level", sa.String(length=24), nullable=True),
    )
    op.add_column(
        "study_projects",
        sa.Column(
            "calibrated",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "study_units",
        sa.Column(
            "inserted_as_prereq",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("study_units", "inserted_as_prereq")
    op.drop_column("study_projects", "calibrated")
    op.drop_column("study_projects", "current_level")
