"""Remove the Study / Team-Learning feature.

Drops the whole study schema: the 16 ``study_*`` / ``whiteboard_exercises``
tables, the study scope on the shared ``knowledge_chunks`` table (rebuilding
its "exactly one scope" CHECK down to 3 scopes), the ``app_settings`` study
teaching/assessor model columns, and the ``push_preferences.study_graded``
toggle. The feature's application code was deleted in the same change.

Irreversible: the schema can't be restored without the deleted code — restore
from a pre-0158 backup if you need the data back.

Revision ID: 0158_remove_study
"""
from __future__ import annotations

from alembic import op

revision = "0158_remove_study"
down_revision = "0157_voice_model"
branch_labels = None
depends_on = None

# Child-before-parent isn't required (DROP … CASCADE handles inter-table FKs),
# but listing them explicitly documents the surface being removed.
_STUDY_TABLES = [
    "study_material_gaps",
    "study_enrollments",
    "study_course_units",
    "study_courses",
    "study_materials",
    "study_unit_reflections",
    "study_board_blocks",
    "study_retrieval_attempts",
    "study_misconceptions",
    "study_objective_mastery",
    "study_messages",
    "whiteboard_exercises",
    "study_sessions",
    "study_exams",
    "study_units",
    "study_projects",
]

_APP_SETTINGS_STUDY_COLS = [
    "study_provider_id",
    "study_model_id",
    "study_assessor_provider_id",
    "study_assessor_model_id",
]


def upgrade() -> None:
    # ---- 1. knowledge_chunks: drop the study scope ----
    # The chunk store is shared (Custom Models / Workspaces / conversations /
    # study). Purge study-scoped chunks first so the column drop and the
    # rebuilt CHECK are clean, then recreate the constraint without the study
    # scope (back to 3 owners — still exactly one set per row). Dropping the
    # column also drops its FK to study_projects + its index.
    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )
    op.execute("DELETE FROM knowledge_chunks WHERE study_project_id IS NOT NULL")
    op.drop_column("knowledge_chunks", "study_project_id")
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (conversation_id IS NOT NULL)::int) = 1",
    )

    # ---- 2. Drop the study tables (CASCADE = order-independent) ----
    for table in _STUDY_TABLES:
        op.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')

    # ---- 3. app_settings: drop the study teaching + assessor model columns ----
    for col in _APP_SETTINGS_STUDY_COLS:
        op.drop_column("app_settings", col)

    # ---- 4. push_preferences: drop the study_graded notification toggle ----
    op.drop_column("push_preferences", "study_graded")


def downgrade() -> None:
    raise NotImplementedError(
        "The Study feature was removed in 0158; its schema cannot be restored "
        "without the deleted application code. Restore from a pre-0158 backup."
    )
