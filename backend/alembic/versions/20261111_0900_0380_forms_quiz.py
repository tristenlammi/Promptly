"""Forms phase 2 (WP-F2.3): quizzes.

* ``forms.quiz`` — NULL: not a quiz. Otherwise ``{release: "now" | "later",
  show_score, show_right_wrong, show_answers, show_points}`` (plus
  ``edit_before``: what "Let people change their answer" was before showing
  the correct answers turned it off, so it's put back the way it was).
* ``form_responses.released_at`` — when this person may see their marks:
  at submit with ``release=now``, or when the owner presses Release scores.
  ``score`` and ``grading`` (there since 0290) start being used.

Revision ID: 0380_forms_quiz
Revises: 0360_note_items_aisle_ref
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0380_forms_quiz"
down_revision = "0360_note_items_aisle_ref"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("forms", sa.Column("quiz", postgresql.JSONB(), nullable=True))
    op.add_column("form_responses", sa.Column("released_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("form_responses", "released_at")
    op.drop_column("forms", "quiz")
