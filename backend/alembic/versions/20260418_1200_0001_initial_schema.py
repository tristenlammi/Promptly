"""Initial schema — all 9 tables from the Promptly spec (§11).

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-18 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- users ----
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    # ---- model_providers ----
    op.create_table(
        "model_providers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.String(length=512), nullable=True),
        sa.Column("api_key", sa.Text(), nullable=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "models",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_model_providers_user_id", "model_providers", ["user_id"])

    # ---- conversations ----
    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("model_id", sa.String(length=255), nullable=True),
        sa.Column(
            "provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "pinned", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "starred", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "web_search",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
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
    op.create_index("ix_conversations_user_id", "conversations", ["user_id"])

    # ---- messages ----
    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column("sources", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "whiteboard_actions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])

    # ---- study_projects ----
    op.create_table(
        "study_projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "topics",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default=sa.text("'{}'::varchar[]"),
        ),
        sa.Column("goal", sa.Text(), nullable=True),
        sa.Column("model_id", sa.String(length=255), nullable=True),
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
    op.create_index("ix_study_projects_user_id", "study_projects", ["user_id"])

    # ---- study_sessions ----
    op.create_table(
        "study_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "excalidraw_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
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
    op.create_index("ix_study_sessions_project_id", "study_sessions", ["project_id"])

    # ---- whiteboard_exercises ----
    # message_id FK added separately below because study_messages doesn't exist yet.
    op.create_table(
        "whiteboard_exercises",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("html", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'active'"),
        ),
        sa.Column(
            "answer_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("excalidraw_snap", sa.Text(), nullable=True),
        sa.Column("ai_feedback", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_whiteboard_exercises_session_id", "whiteboard_exercises", ["session_id"]
    )

    # ---- study_messages ----
    op.create_table(
        "study_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column(
            "exercise_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "whiteboard_exercises.id",
                ondelete="SET NULL",
                name="fk_study_messages_exercise_id",
            ),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_study_messages_session_id", "study_messages", ["session_id"])

    # Close the circular FK now that both tables exist.
    op.create_foreign_key(
        "fk_whiteboard_exercises_message_id",
        source_table="whiteboard_exercises",
        referent_table="study_messages",
        local_cols=["message_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )

    # ---- search_providers ----
    op.create_table(
        "search_providers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "is_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_search_providers_user_id", "search_providers", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_search_providers_user_id", table_name="search_providers")
    op.drop_table("search_providers")

    op.drop_constraint(
        "fk_whiteboard_exercises_message_id",
        "whiteboard_exercises",
        type_="foreignkey",
    )

    op.drop_index("ix_study_messages_session_id", table_name="study_messages")
    op.drop_table("study_messages")

    op.drop_index(
        "ix_whiteboard_exercises_session_id", table_name="whiteboard_exercises"
    )
    op.drop_table("whiteboard_exercises")

    op.drop_index("ix_study_sessions_project_id", table_name="study_sessions")
    op.drop_table("study_sessions")

    op.drop_index("ix_study_projects_user_id", table_name="study_projects")
    op.drop_table("study_projects")

    op.drop_index("ix_messages_conversation_id", table_name="messages")
    op.drop_table("messages")

    op.drop_index("ix_conversations_user_id", table_name="conversations")
    op.drop_table("conversations")

    op.drop_index("ix_model_providers_user_id", table_name="model_providers")
    op.drop_table("model_providers")

    op.drop_index("ix_users_username", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
