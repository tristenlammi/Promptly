"""Make session_id nullable on study_retrieval_attempts.

Standalone quick-review attempts have no associated session; they come
from the dedicated review endpoint rather than an SSE unit session.

Revision ID: 0078_nullable_session_id_attempts
Revises: 0077_session_goal
"""

from alembic import op

revision = "0078_attempt_session_nullable"
down_revision = "0077_session_goal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "study_retrieval_attempts",
        "session_id",
        nullable=True,
    )


def downgrade() -> None:
    # Remove rows that would violate NOT NULL before restoring the constraint.
    op.execute(
        "DELETE FROM study_retrieval_attempts WHERE session_id IS NULL"
    )
    op.alter_column(
        "study_retrieval_attempts",
        "session_id",
        nullable=False,
    )
