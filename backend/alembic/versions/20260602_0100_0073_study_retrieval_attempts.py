"""study_retrieval_attempts — Phase 1 honest measurement table.

Each row captures one retrieval event: when the tutor scored an
objective (and, optionally, after an independent assessor pass
overwrites ``correct`` with an evidence-based grade).

Revision ID: 0073_study_retrieval_attempts
Revises: 0072_app_settings_study_model
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0073_study_retrieval_attempts"
down_revision = "0072_app_settings_study_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "study_retrieval_attempts",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("study_sessions.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "unit_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("study_units.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("objective_index", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(32), nullable=False, server_default="practice"),
        sa.Column("correct", sa.Boolean(), nullable=True),
        sa.Column("tutor_score", sa.Integer(), nullable=True),
        sa.Column("hint_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("source_kind", sa.String(16), nullable=False, server_default="tutor"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )


def downgrade() -> None:
    op.drop_table("study_retrieval_attempts")
