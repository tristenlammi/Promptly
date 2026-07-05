"""Team Learning (Study L1): courses, course units, enrollments.

* ``study_courses`` — lead-authored course blueprints scoped to a
  workspace (draft → published → archived), with difficulty preset,
  source workspace files, and authored passing criteria.
* ``study_course_units`` — the blueprint's ordered curriculum rows.
* ``study_enrollments`` — one learner's assignment to a published
  course, pointing at the ``StudyProject`` materialised for them.
* ``study_projects.source_course_id`` — marks materialised projects so
  the tutor stays on the authored rails; SET NULL on course deletion so
  learner progress survives as a personal topic.

Revision ID: 0142_study_courses
Revises: 0141_flow_versions_conc
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0142_study_courses"
down_revision: Union[str, Sequence[str], None] = "0141_flow_versions_conc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "study_courses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("brief", sa.Text(), nullable=False),
        sa.Column("difficulty_preset", sa.String(length=24), nullable=True),
        sa.Column(
            "source_file_ids",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "unit_mastery_floor",
            sa.Integer(),
            nullable=False,
            server_default="75",
        ),
        sa.Column(
            "exam_pass_score", sa.Integer(), nullable=False, server_default="70"
        ),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="draft"
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("drafting_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_study_courses_workspace_id", "study_courses", ["workspace_id"]
    )

    op.create_table(
        "study_course_units",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "learning_objectives",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "source_file_ids",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["course_id"], ["study_courses.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_study_course_units_course_id", "study_course_units", ["course_id"]
    )

    op.create_table(
        "study_enrollments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("learner_user_id", sa.Uuid(), nullable=False),
        sa.Column("assigned_by", sa.Uuid(), nullable=True),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="assigned",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["course_id"], ["study_courses.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["learner_user_id"], ["users.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["assigned_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["study_projects.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "course_id", "learner_user_id", name="uq_enrollment_course_learner"
        ),
    )
    op.create_index(
        "ix_study_enrollments_course_id", "study_enrollments", ["course_id"]
    )
    op.create_index(
        "ix_study_enrollments_learner_user_id",
        "study_enrollments",
        ["learner_user_id"],
    )
    op.create_index(
        "ix_study_enrollments_project_id", "study_enrollments", ["project_id"]
    )

    op.add_column(
        "study_projects",
        sa.Column("source_course_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_study_projects_source_course",
        "study_projects",
        "study_courses",
        ["source_course_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_study_projects_source_course", "study_projects", type_="foreignkey"
    )
    op.drop_column("study_projects", "source_course_id")
    op.drop_index(
        "ix_study_enrollments_project_id", table_name="study_enrollments"
    )
    op.drop_index(
        "ix_study_enrollments_learner_user_id", table_name="study_enrollments"
    )
    op.drop_index(
        "ix_study_enrollments_course_id", table_name="study_enrollments"
    )
    op.drop_table("study_enrollments")
    op.drop_index(
        "ix_study_course_units_course_id", table_name="study_course_units"
    )
    op.drop_table("study_course_units")
    op.drop_index("ix_study_courses_workspace_id", table_name="study_courses")
    op.drop_table("study_courses")
