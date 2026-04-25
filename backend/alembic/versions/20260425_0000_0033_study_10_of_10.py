"""Study Section to 10/10 — persistent learner state + per-objective mastery.

Turns the Study tutor from a prompt-only design into a state-centric one.
Adds five buckets of durable state the tutor reads on every turn and
writes to via new action types:

* ``study_projects.learner_profile`` (JSONB) — occupation, interests,
  goals, background, preferred example domains, free-form notes. One
  row per project; merged additively by the ``save_learner_profile``
  action. Empty = "probe early" (preserves the existing Principle #3
  warm-up behaviour for brand-new projects).

* ``study_sessions`` completion-gate columns — ``teachback_passed_at``,
  ``confidence_captured_at``, ``min_turns_required``,
  ``student_turn_count``, ``hint_count``. The server gate for
  ``mark_complete`` reads these so a model that rushes through a unit
  can't silently skip the teach-back / confidence checkpoints.

* ``study_objective_mastery`` — per-objective mastery score + SM-2-lite
  spacing state (ease_factor, interval_days, next_review_at). Scored
  via a new ``update_objective_mastery`` action. Powers the due-review
  projection injected into the prompt and the spaced-repetition
  acceptance criterion.

* ``study_misconceptions`` — rolling error catalog (description +
  correction + times_seen + resolved_at). Written by
  ``log_misconception`` / ``resolve_misconception``; top unresolved
  items surface in the system prompt so misconceptions don't get
  re-taught as-if-new across unit boundaries.

* ``study_unit_reflections`` — per-unit-attempt summary and concept
  anchors. Written by ``summarise_unit`` (auto-stubbed if the model
  forgets to emit it before mark_complete). The last 3 reflections are
  quoted back into every new unit's system prompt so the tutor can
  bridge units narratively.

Backfill: any existing completed unit with a ``mastery_summary`` gets
a stub ``study_unit_reflection`` row so the "Recent reflections"
prompt block is populated for projects that predate this migration.

Revision ID: 0033_study_10_of_10
Revises: 0032_custom_models
Create Date: 2026-04-25 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0033_study_10_of_10"
down_revision: Union[str, Sequence[str], None] = "0032_custom_models"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- 1. Learner profile on the project ------------------------------
    op.add_column(
        "study_projects",
        sa.Column(
            "learner_profile",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "study_projects",
        sa.Column(
            "learner_profile_updated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # ---- 2. Completion-gate columns on the unit session -----------------
    op.add_column(
        "study_sessions",
        sa.Column("teachback_passed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "study_sessions",
        sa.Column("confidence_captured_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "study_sessions",
        sa.Column("min_turns_required", sa.Integer, nullable=True),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "student_turn_count",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "hint_count",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
    )

    # ---- 3. Per-objective mastery + SM-2-lite spacing -------------------
    op.create_table(
        "study_objective_mastery",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_units.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # 0-based index into ``StudyUnit.learning_objectives``. Stable
        # for the lifetime of the unit because the objectives list is
        # snapshot at unit creation and never shuffled.
        sa.Column("objective_index", sa.Integer, nullable=False),
        # Verbatim snapshot of the objective text — kept here so the
        # review queue can render the objective even if the parent
        # unit's list was edited out from under us.
        sa.Column("objective_text", sa.Text, nullable=False),
        sa.Column(
            "mastery_score",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
        # SM-2-lite state. ``ease_factor`` starts at 2.5 and drifts up
        # on clean recall / down on failures. ``interval_days`` is the
        # number of days between the last review and the next due date;
        # 0 = "never successfully reviewed yet, treat as new".
        sa.Column(
            "ease_factor",
            sa.Float,
            nullable=False,
            server_default=sa.text("2.5"),
        ),
        sa.Column(
            "interval_days",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_review_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "review_count",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "consecutive_failures",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "project_id",
            "unit_id",
            "objective_index",
            name="uq_study_objective_mastery_objective",
        ),
    )
    # Hot path: "which objectives in this project are due for review?"
    op.create_index(
        "ix_study_objective_mastery_review_queue",
        "study_objective_mastery",
        ["project_id", "next_review_at"],
    )

    # ---- 4. Misconceptions catalog ---------------------------------------
    op.create_table(
        "study_misconceptions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Nullable because a misconception is sometimes cross-unit
        # (e.g. "confuses correlation and causation" keeps surfacing
        # across the whole statistics project). SET NULL on unit delete
        # so the catalog survives plan regeneration.
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_units.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("objective_index", sa.Integer, nullable=True),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("correction", sa.Text, nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "times_seen",
            sa.Integer,
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ---- 5. Unit reflections --------------------------------------------
    op.create_table(
        "study_unit_reflections",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_units.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("summary", sa.Text, nullable=False),
        sa.Column(
            "objectives_summary",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "concepts_anchored",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )

    # ---- 6. Backfill reflections from existing mastery_summary ----------
    # Run straight SQL so we don't have to hydrate ORM objects during
    # a migration. One reflection per completed unit that has a
    # non-blank summary — skips everything else so we don't invent
    # reflections out of thin air.
    op.execute(
        """
        INSERT INTO study_unit_reflections
            (unit_id, session_id, summary, objectives_summary,
             concepts_anchored, created_at)
        SELECT u.id,
               u.session_id,
               u.mastery_summary,
               '{}'::jsonb,
               '[]'::jsonb,
               COALESCE(u.completed_at, CURRENT_TIMESTAMP)
        FROM study_units u
        WHERE u.status = 'completed'
          AND u.mastery_summary IS NOT NULL
          AND btrim(u.mastery_summary) <> ''
        """
    )


def downgrade() -> None:
    op.drop_table("study_unit_reflections")
    op.drop_table("study_misconceptions")
    op.drop_index(
        "ix_study_objective_mastery_review_queue",
        table_name="study_objective_mastery",
    )
    op.drop_table("study_objective_mastery")

    op.drop_column("study_sessions", "hint_count")
    op.drop_column("study_sessions", "student_turn_count")
    op.drop_column("study_sessions", "min_turns_required")
    op.drop_column("study_sessions", "confidence_captured_at")
    op.drop_column("study_sessions", "teachback_passed_at")

    op.drop_column("study_projects", "learner_profile_updated_at")
    op.drop_column("study_projects", "learner_profile")
