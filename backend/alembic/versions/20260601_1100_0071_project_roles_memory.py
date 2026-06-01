"""Project collaboration roles, unpin guard, per-chat file opt-out, auto-memory.

Phase 4 of the Projects upgrade:

* ``project_shares.role`` — ``editor`` (default, back-compat) or
  ``viewer`` (read-only). Owner-only actions still gate on
  ``chat_projects.user_id``.
* ``chat_project_files.pinned_by`` — who pinned the file, so the unpin
  guard can let the owner remove anything but restrict collaborators to
  their own pins. NULL on pre-existing rows (owner-only unpin).
* ``chat_projects.auto_memory_enabled`` — opt-in rolling project memory.
* ``conversation_excluded_project_files`` — per-chat opt-out of specific
  pinned files.

Revision ID: 0071_project_roles_memory
Revises: 0070_project_knowledge
Create Date: 2026-06-01 11:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0071_project_roles_memory"
down_revision: Union[str, Sequence[str], None] = "0070_project_knowledge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project_shares",
        sa.Column(
            "role",
            sa.String(16),
            nullable=False,
            server_default="editor",
        ),
    )
    op.add_column(
        "chat_project_files",
        sa.Column(
            "pinned_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "chat_projects",
        sa.Column(
            "auto_memory_enabled",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.create_table(
        "conversation_excluded_project_files",
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("conversation_excluded_project_files")
    op.drop_column("chat_projects", "auto_memory_enabled")
    op.drop_column("chat_project_files", "pinned_by")
    op.drop_column("project_shares", "role")
