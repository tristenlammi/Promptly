"""Study, phase 2: reviews, capstones, the report, days studied, trash, level lock.

* ``study_concepts.due_at`` — when a learned concept is next due for review
  (the same moment as ``fsrs["due"]``, as a column so "what's due" is a query).
* ``study_units.capstone`` / ``study_subjects.capstone`` — where the unit's
  applied task and the subject's final one are up to.
* ``study_subjects.report`` — what was written once at the end (next subjects).
* ``study_subjects.trashed_at`` — a deleted subject waits in the trash.
* ``study_days`` — one row per person per day they studied (the honest count).
* ``users.study_level_lock`` — an admin can fix who Study is pitched at.

Revision ID: 0484_study_two
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0484_study_two"
down_revision = "0483_study"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def upgrade() -> None:
    op.add_column("study_concepts", sa.Column("due_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_study_concepts_due", "study_concepts", ["due_at"], postgresql_where=sa.text("due_at IS NOT NULL"))
    op.add_column("study_units", sa.Column("capstone", JSONB, nullable=True))
    op.add_column("study_subjects", sa.Column("capstone", JSONB, nullable=True))
    op.add_column("study_subjects", sa.Column("report", JSONB, nullable=True))
    op.add_column("study_subjects", sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "study_days",
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("steps", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("users", sa.Column("study_level_lock", sa.String(8), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "study_level_lock")
    op.drop_table("study_days")
    op.drop_column("study_subjects", "trashed_at")
    op.drop_column("study_subjects", "report")
    op.drop_column("study_subjects", "capstone")
    op.drop_column("study_units", "capstone")
    op.drop_index("ix_study_concepts_due", table_name="study_concepts")
    op.drop_column("study_concepts", "due_at")
