"""Chat Projects — generic project bundles for non-Study conversations.

A project groups together:

* A shared **system prompt** — every conversation in the project gets
  it prepended so the user doesn't have to restate their role / style
  preferences every time they open a new chat.
* A set of **pinned files** — attached automatically to every new
  conversation in the project, so "my 200-page manual" is always in
  context without the paperclip dance.
* A set of **conversations** — the regular ``conversations`` table
  grows a nullable ``project_id`` FK; conversations with NULL
  ``project_id`` keep working exactly like before (ChatGPT-style "top
  level" chats).
* Optional **default model + provider** — lets the user say
  "everything in this project uses Claude Opus" without per-chat
  overrides. Nullable: when NULL we fall back to the user's global
  model selection, matching today's behaviour.

The archive model deliberately mirrors Study Projects: an
``archived_at`` timestamp instead of a dedicated boolean. A non-NULL
``archived_at`` is the single source of truth for "this is in the
Archive tab" across list endpoints and UI.

Revision ID: 0027_chat_projects
Revises: 0026_study_notes
Create Date: 2026-04-20 08:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027_chat_projects"
down_revision: Union[str, Sequence[str], None] = "0026_study_notes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "chat_projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        # Optional short human-readable description shown on the
        # project card. Separate from the system prompt so the card can
        # render a clean summary without leaking the prompt text.
        sa.Column("description", sa.Text(), nullable=True),
        # The shared "instructions" piped into every conversation's
        # system prompt. Stored as raw text — no templating: users are
        # editing a textarea, not writing Jinja.
        sa.Column("system_prompt", sa.Text(), nullable=True),
        # Per-project default model/provider. NULL → fall back to the
        # user's global selection at send time (today's behaviour).
        sa.Column("default_model_id", sa.String(length=255), nullable=True),
        sa.Column(
            "default_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Single source of truth for "in archive". NULL = active.
        # Matches the pattern used by ``study_projects.archived_at``.
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
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
    )
    # Composite index powers the "list my active projects, newest
    # first" query that the list page hits on every mount. The
    # ``archived_at`` key lives here so the archived-tab query can
    # reuse the same covering index.
    op.create_index(
        "ix_chat_projects_user_archived",
        "chat_projects",
        ["user_id", "archived_at"],
    )

    # Pinned-file join table. A simple many-to-many between a project
    # and the user's own files (``user_files.id``). We store the join
    # separately from ``user_files.project_id`` because a file can
    # legitimately belong to multiple projects (a style guide, a
    # template). Cascading deletes in both directions keep the join
    # clean when either side goes away.
    op.create_table(
        "chat_project_files",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "pinned_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "project_id", "file_id", name="pk_chat_project_files"
        ),
    )
    # Reverse lookup: "which projects pin this file?" — cheap enough
    # to always index since the row count per user is small.
    op.create_index(
        "ix_chat_project_files_file",
        "chat_project_files",
        ["file_id"],
    )

    # Attach an optional ``project_id`` to every conversation. NULL
    # means "top-level chat" (today's default); a non-NULL FK puts
    # the chat under the named project. ``ON DELETE SET NULL`` so
    # deleting a project doesn't nuke conversation history — the
    # chats just resurface as top-level.
    op.add_column(
        "conversations",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_conversations_project",
        "conversations",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_project", table_name="conversations")
    op.drop_column("conversations", "project_id")

    op.drop_index(
        "ix_chat_project_files_file", table_name="chat_project_files"
    )
    op.drop_table("chat_project_files")

    op.drop_index(
        "ix_chat_projects_user_archived", table_name="chat_projects"
    )
    op.drop_table("chat_projects")
