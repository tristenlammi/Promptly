"""session_goal — Phase 4 per-session goal-setting (#20).

Adds ``session_goal TEXT nullable`` to ``study_sessions``.  The tutor
captures the student's one-sentence learning goal during the ``hook``
phase via a new ``set_session_goal`` unit_action; the ``close`` phase
then closes the loop by verifying the goal was met.

Revision ID: 0077_session_goal
Revises: 0076_reflection_artifacts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0077_session_goal"
down_revision = "0076_reflection_artifacts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "study_sessions",
        sa.Column("session_goal", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("study_sessions", "session_goal")
