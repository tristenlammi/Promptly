"""Study: subjects, the concept map, lessons, and the Study model setting.

An AI teacher that keeps a picture of what one person knows. Everything
belongs to the subject's owner and goes with the subject (and the subject
with the account). See ``app/study/models.py`` for what each table holds.

``app_settings.study_provider_id`` / ``study_model_id``: the model that
teaches (NULL = the default chat model).

Revision ID: 0483_study
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0483_study"
down_revision = "0482_home_auto"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def _id() -> sa.Column:
    return sa.Column("id", UUID, primary_key=True)


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=None if nullable else sa.func.now())


def _subject() -> sa.Column:
    return sa.Column("subject_id", UUID, sa.ForeignKey("study_subjects.id", ondelete="CASCADE"), nullable=False)


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("study_provider_id", UUID, sa.ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True))
    op.add_column("app_settings", sa.Column("study_model_id", sa.String(255), nullable=True))

    op.create_table(
        "study_subjects",
        _id(),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False, server_default=""),
        sa.Column("prior", sa.Text(), nullable=False, server_default=""),
        sa.Column("depth", sa.String(12), nullable=False, server_default="solid"),
        sa.Column("level", sa.String(8), nullable=False, server_default="adult"),
        sa.Column("status", sa.String(12), nullable=False, server_default="building"),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("use_web", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("attached", JSONB, nullable=False, server_default="{}"),
        sa.Column("build_stage", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("build_progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("build_error", sa.Text(), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        _ts("created_at"),
        _ts("updated_at"),
        _ts("last_studied_at", nullable=True),
    )
    op.create_index("ix_study_subjects_user", "study_subjects", ["user_id", "updated_at"])

    op.create_table(
        "study_units",
        _id(),
        _subject(),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_study_units_subject", "study_units", ["subject_id", "position"])

    op.create_table(
        "study_concepts",
        _id(),
        _subject(),
        sa.Column("unit_id", UUID, sa.ForeignKey("study_units.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Float(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("objectives", JSONB, nullable=False, server_default="[]"),
        sa.Column("nature", sa.String(12), nullable=False, server_default="principle"),
        sa.Column("prereqs", JSONB, nullable=False, server_default="[]"),
        sa.Column("source_ns", JSONB, nullable=False, server_default="[]"),
        sa.Column("mastery", sa.Float(), nullable=False, server_default="0"),
        sa.Column("state", sa.String(10), nullable=False, server_default="new"),
        sa.Column("origin", sa.String(8), nullable=False, server_default="planned"),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("gap_for", UUID, sa.ForeignKey("study_concepts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("production_ok", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("steps_done", sa.Integer(), nullable=False, server_default="0"),
        _ts("last_seen_at", nullable=True),
        _ts("mastered_at", nullable=True),
        sa.Column("fsrs", JSONB, nullable=True),
    )
    op.create_index("ix_study_concepts_subject", "study_concepts", ["subject_id", "position"])

    op.create_table(
        "study_misconceptions",
        _id(),
        _subject(),
        sa.Column("concept_id", UUID, sa.ForeignKey("study_concepts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(80), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
        sa.Column("seen", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        _ts("first_seen_at"),
        _ts("last_seen_at"),
    )
    op.create_index("ix_study_misc_concept", "study_misconceptions", ["concept_id"])

    op.create_table(
        "study_sessions",
        _id(),
        _subject(),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="active"),
        sa.Column("plan", JSONB, nullable=False, server_default="{}"),
        sa.Column("summary", JSONB, nullable=True),
        _ts("started_at"),
        _ts("ended_at", nullable=True),
    )
    op.create_index("ix_study_sessions_subject", "study_sessions", ["subject_id", "started_at"])

    op.create_table(
        "study_steps",
        _id(),
        sa.Column("session_id", UUID, sa.ForeignKey("study_sessions.id", ondelete="CASCADE"), nullable=False),
        _subject(),
        sa.Column("concept_id", UUID, sa.ForeignKey("study_concepts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("role", sa.String(10), nullable=False, server_default=""),
        sa.Column("status", sa.String(8), nullable=False, server_default="pending"),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("answer", JSONB, nullable=True),
        sa.Column("grade", JSONB, nullable=True),
        sa.Column("evidence", JSONB, nullable=False, server_default="[]"),
        sa.Column("turns", JSONB, nullable=False, server_default="[]"),
        sa.Column("asks", JSONB, nullable=False, server_default="[]"),
        sa.Column("hints_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Integer(), nullable=True),
        _ts("created_at"),
        _ts("answered_at", nullable=True),
    )
    op.create_index("ix_study_steps_session", "study_steps", ["session_id", "position"])
    op.create_index("ix_study_steps_concept", "study_steps", ["concept_id"])

    op.create_table(
        "study_sources",
        _id(),
        _subject(),
        sa.Column("n", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(6), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("file_id", UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_study_sources_subject", "study_sources", ["subject_id", "n"])


def downgrade() -> None:
    for t in ("study_sources", "study_steps", "study_sessions", "study_misconceptions", "study_concepts", "study_units", "study_subjects"):
        op.drop_table(t)
    op.drop_column("app_settings", "study_model_id")
    op.drop_column("app_settings", "study_provider_id")
