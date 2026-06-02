"""reflection_artifacts — Phase 3 co-created notes snapshot.

Adds ``board_snapshot`` (JSONB list of board blocks at close time) and
``notes_snapshot`` (student's notes_md at close time) to
``study_unit_reflections`` so the lesson artifact built during a unit is
preserved in the reflection row and can be surfaced to the student or
referenced by the next unit's opener.

Revision ID: 0076_reflection_artifacts
Revises: 0075_study_board_blocks
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0076_reflection_artifacts"
down_revision = "0075_study_board_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "study_unit_reflections",
        sa.Column(
            "board_snapshot",
            postgresql.JSONB,
            nullable=False,
            server_default="'[]'::jsonb",
        ),
    )
    op.add_column(
        "study_unit_reflections",
        sa.Column("notes_snapshot", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("study_unit_reflections", "notes_snapshot")
    op.drop_column("study_unit_reflections", "board_snapshot")
