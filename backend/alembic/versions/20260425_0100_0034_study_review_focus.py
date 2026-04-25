"""Study — per-session review focus pointer.

Sticky-until-satisfied deep-link for the "Review due objective" flow:
when a student clicks a ``ReviewQueueWidget`` item we stamp the
chosen ``study_objective_mastery.id`` on the session so every LLM
turn can prepend a dedicated focus block to the system prompt
without relying on the client to keep resending the hint.

Cleared server-side when the tutor emits ``update_objective_mastery``
for the corresponding objective index — i.e. the review is "done"
as soon as the objective has a fresh score on record, not after a
fixed number of turns. Nullable so every existing session stays
focusless.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0034_study_review_focus"
down_revision = "0033_study_10_of_10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "study_sessions",
        sa.Column(
            "current_review_focus_objective_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "study_sessions_review_focus_fkey",
        source_table="study_sessions",
        referent_table="study_objective_mastery",
        local_cols=["current_review_focus_objective_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "study_sessions_review_focus_fkey", "study_sessions", type_="foreignkey"
    )
    op.drop_column("study_sessions", "current_review_focus_objective_id")
