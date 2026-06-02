"""Add comprehension_confirmed_at to study_sessions

Revision ID: 0081_comprehension_confirmed
Revises: 0080_study_project_chunks
Create Date: 2026-06-02 12:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = "0081_comprehension_confirmed"
down_revision = "0080_study_project_chunks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "study_sessions",
        sa.Column(
            "comprehension_confirmed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("study_sessions", "comprehension_confirmed_at")
