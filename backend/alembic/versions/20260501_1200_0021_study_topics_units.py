"""Study topics, units, and final exams.

Promotes the free-form Study module into a structured learning path:

* ``study_projects`` gains ``status`` (``planning``/``active``/``completed``
  /``archived``), ``learning_request`` (raw "what I want to learn"),
  ``difficulty`` (AI-inferred), ``archived_at``, and ``planning_error``.
* ``study_sessions`` gains a ``kind`` discriminator plus FKs to
  ``study_units`` and ``study_exams`` so a session belongs to exactly one
  unit *or* one exam (or neither, for legacy free-form sessions).
* New ``study_units`` table stores the AI-generated plan — each unit has
  an ordered position, title, description, learning objectives, and a
  status/mastery score that the tutor updates as the student progresses.
* New ``study_exams`` table records each final-exam attempt with its
  time limit, dynamic weak/strong areas (seeded from unit scores) and
  pass/fail outcome. Failing an exam unlocks its ``weak_unit_ids`` for
  targeted re-study with the AI carrying the exam mistakes as extra
  context.

All new columns are nullable or have defaults so the migration is
additive and does not disturb existing free-form sessions.

Revision ID: 0021_study_topics_units
Revises: 0020_temporary_chats
Create Date: 2026-05-01 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021_study_topics_units"
down_revision: Union[str, Sequence[str], None] = "0020_temporary_chats"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- study_projects — new columns ----
    # Existing rows are free-form "legacy" sessions that predate the
    # Unit/Exam structure. We mark them ``active`` so they still show up
    # in the active tab, but their unit list is simply empty.
    op.add_column(
        "study_projects",
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="active",
        ),
    )
    op.add_column(
        "study_projects",
        sa.Column("learning_request", sa.Text(), nullable=True),
    )
    op.add_column(
        "study_projects",
        sa.Column("difficulty", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "study_projects",
        sa.Column(
            "archived_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "study_projects",
        sa.Column("planning_error", sa.Text(), nullable=True),
    )
    # Snapshot of the provider+model used to generate the plan so the
    # backend can re-trigger planning with the same config on retry.
    op.add_column(
        "study_projects",
        sa.Column(
            "planning_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_study_projects_status", "study_projects", ["user_id", "status"]
    )

    # ---- study_units ----
    op.create_table(
        "study_units",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "learning_objectives",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="not_started",
        ),
        sa.Column("mastery_score", sa.Integer(), nullable=True),
        sa.Column(
            "mastery_summary",
            sa.Text(),
            nullable=True,
        ),
        sa.Column(
            "exam_focus",
            sa.Text(),
            nullable=True,
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "last_studied_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # The tutor session bound to this unit — SET NULL so deleting
        # a session doesn't cascade-wipe the unit record.
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "study_sessions.id",
                ondelete="SET NULL",
                name="fk_study_units_session_id",
                use_alter=True,
            ),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_study_units_project_id_order",
        "study_units",
        ["project_id", "order_index"],
    )

    # ---- study_exams ----
    op.create_table(
        "study_exams",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "study_sessions.id",
                ondelete="SET NULL",
                name="fk_study_exams_session_id",
                use_alter=True,
            ),
            nullable=True,
        ),
        sa.Column("attempt_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "time_limit_seconds",
            sa.Integer(),
            nullable=False,
            server_default="1200",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "ended_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column(
            "weak_unit_ids",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=True,
        ),
        sa.Column(
            "strong_unit_ids",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=True,
        ),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_study_exams_project_id",
        "study_exams",
        ["project_id"],
    )

    # ---- study_sessions — add discriminator + unit/exam FKs ----
    op.add_column(
        "study_sessions",
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="legacy",
        ),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_units.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "exam_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_exams.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_study_sessions_unit_id", "study_sessions", ["unit_id"]
    )
    op.create_index(
        "ix_study_sessions_exam_id", "study_sessions", ["exam_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_study_sessions_exam_id", table_name="study_sessions")
    op.drop_index("ix_study_sessions_unit_id", table_name="study_sessions")
    op.drop_column("study_sessions", "exam_id")
    op.drop_column("study_sessions", "unit_id")
    op.drop_column("study_sessions", "kind")

    op.drop_index("ix_study_exams_project_id", table_name="study_exams")
    op.drop_table("study_exams")

    op.drop_index("ix_study_units_project_id_order", table_name="study_units")
    op.drop_table("study_units")

    op.drop_index("ix_study_projects_status", table_name="study_projects")
    op.drop_column("study_projects", "planning_provider_id")
    op.drop_column("study_projects", "planning_error")
    op.drop_column("study_projects", "archived_at")
    op.drop_column("study_projects", "difficulty")
    op.drop_column("study_projects", "learning_request")
    op.drop_column("study_projects", "status")
