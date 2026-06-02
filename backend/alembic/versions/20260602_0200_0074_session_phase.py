"""session_phase — Phase 2 orchestration engine columns.

Adds ``phase`` (current lesson phase) and ``phase_history`` (ordered
transition log) to ``study_sessions``.  Both are nullable/default-safe
so existing rows keep working without migration data-backfill.

Revision ID: 0074_session_phase
Revises: 0073_study_retrieval_attempts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0074_session_phase"
down_revision = "0073_study_retrieval_attempts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "study_sessions",
        sa.Column("phase", sa.String(32), nullable=True),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "phase_history",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="'[]'::jsonb",
        ),
    )


def downgrade() -> None:
    op.drop_column("study_sessions", "phase_history")
    op.drop_column("study_sessions", "phase")
