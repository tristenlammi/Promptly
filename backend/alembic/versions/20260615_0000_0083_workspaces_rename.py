"""Rename "Chat Projects" → "Workspaces" (Phase 0, mechanical).

Pure rename of the chat-project domain to "workspaces". No behaviour
change — same columns, same FKs, same scopes — only names move. Study
(``study_projects`` / ``study_project_id``) and Custom Models
(``custom_model_id``) are untouched: only the chat-project scope of the
shared ``knowledge_chunks`` table is renamed (``project_id`` →
``workspace_id``).

Greenfield: old workspace/project data has no value, so the four
project tables (and the project-scoped chunks + conversation links) are
emptied *before* the rename. This keeps the column/constraint renames
trivial — there are no rows whose FKs we have to preserve — and the
``UPDATE conversations SET project_id = NULL`` detaches every chat back
to top-level so the FK column can be renamed cleanly.

Renames performed:

* Tables: ``chat_projects`` → ``workspaces``;
  ``chat_project_files`` → ``workspace_files``;
  ``project_shares`` → ``workspace_shares``;
  ``conversation_excluded_project_files`` →
  ``conversation_excluded_workspace_files``.
* Columns ``project_id`` → ``workspace_id`` on ``conversations``,
  ``knowledge_chunks``, ``workspace_files`` (was ``chat_project_files``),
  and ``workspace_shares`` (was ``project_shares``).
* The ``knowledge_chunks`` "exactly one scope" CHECK constraint is
  dropped and recreated with ``workspace_id`` in place of ``project_id``
  (the ``custom_model_id`` / ``study_project_id`` arms are unchanged).
* Indexes / constraints embedding the old names are renamed so the
  schema reads consistently.

Revision ID: 0083_workspaces_rename
Revises: 0082_conversation_archive
Create Date: 2026-06-15 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0083_workspaces_rename"
down_revision: Union[str, Sequence[str], None] = "0082_conversation_archive"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- 1. Empty the project domain (greenfield). FK-safe order: ----
    # child join/share/exclusion rows first, then the project-scoped
    # chunks, then detach conversations, then the project rows.
    op.execute("DELETE FROM conversation_excluded_project_files")
    op.execute("DELETE FROM chat_project_files")
    op.execute("DELETE FROM project_shares")
    op.execute("DELETE FROM knowledge_chunks WHERE project_id IS NOT NULL")
    op.execute("UPDATE conversations SET project_id = NULL")
    op.execute("DELETE FROM chat_projects")

    # --- 2. Drop the scope CHECK constraint before renaming the -------
    # ``knowledge_chunks.project_id`` column it references.
    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )

    # --- 3. Rename the four tables. ----------------------------------
    op.rename_table("chat_projects", "workspaces")
    op.rename_table("chat_project_files", "workspace_files")
    op.rename_table("project_shares", "workspace_shares")
    op.rename_table(
        "conversation_excluded_project_files",
        "conversation_excluded_workspace_files",
    )

    # --- 4. Rename the ``project_id`` columns → ``workspace_id``. -----
    op.alter_column(
        "conversations", "project_id", new_column_name="workspace_id"
    )
    op.alter_column(
        "knowledge_chunks", "project_id", new_column_name="workspace_id"
    )
    op.alter_column(
        "workspace_files", "project_id", new_column_name="workspace_id"
    )
    op.alter_column(
        "workspace_shares", "project_id", new_column_name="workspace_id"
    )

    # --- 5. Recreate the scope CHECK constraint with workspace_id. ----
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (study_project_id IS NOT NULL)::int) = 1",
    )

    # --- 6. Rename indexes / constraints embedding the old names. -----
    # ``rename_table`` / ``alter_column`` do NOT rename the named
    # indexes & constraints that referenced them, so do it explicitly
    # for consistency. Use IF EXISTS guards so a future autogenerate
    # baseline that lacks one of these doesn't fail the whole upgrade.
    op.execute(
        "ALTER INDEX IF EXISTS ix_chat_projects_user_archived "
        "RENAME TO ix_workspaces_user_archived"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_chat_project_files_file "
        "RENAME TO ix_workspace_files_file"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_conversations_project "
        "RENAME TO ix_conversations_workspace"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_knowledge_chunks_project_id "
        "RENAME TO ix_knowledge_chunks_workspace_id"
    )
    op.execute(
        "ALTER INDEX IF EXISTS uq_knowledge_chunks_project_chunk "
        "RENAME TO uq_knowledge_chunks_workspace_chunk"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_project_shares_invitee_status "
        "RENAME TO ix_workspace_shares_invitee_status"
    )
    # Unique constraint on (workspace_id, invitee_user_id).
    op.execute(
        "ALTER TABLE workspace_shares "
        "RENAME CONSTRAINT uq_project_shares_project_invitee "
        "TO uq_workspace_shares_workspace_invitee"
    )
    # Composite PK on the pinned-file join table.
    op.execute(
        "ALTER INDEX IF EXISTS pk_chat_project_files "
        "RENAME TO pk_workspace_files"
    )


def downgrade() -> None:
    # Best-effort reverse. Greenfield delete is not undone (nothing to
    # restore). Names are walked back so the schema matches the 0082
    # baseline structurally.
    op.execute(
        "ALTER INDEX IF EXISTS pk_workspace_files "
        "RENAME TO pk_chat_project_files"
    )
    op.execute(
        "ALTER TABLE workspace_shares "
        "RENAME CONSTRAINT uq_workspace_shares_workspace_invitee "
        "TO uq_project_shares_project_invitee"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_workspace_shares_invitee_status "
        "RENAME TO ix_project_shares_invitee_status"
    )
    op.execute(
        "ALTER INDEX IF EXISTS uq_knowledge_chunks_workspace_chunk "
        "RENAME TO uq_knowledge_chunks_project_chunk"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_knowledge_chunks_workspace_id "
        "RENAME TO ix_knowledge_chunks_project_id"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_conversations_workspace "
        "RENAME TO ix_conversations_project"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_workspace_files_file "
        "RENAME TO ix_chat_project_files_file"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_workspaces_user_archived "
        "RENAME TO ix_chat_projects_user_archived"
    )

    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )

    op.alter_column(
        "workspace_shares", "workspace_id", new_column_name="project_id"
    )
    op.alter_column(
        "workspace_files", "workspace_id", new_column_name="project_id"
    )
    op.alter_column(
        "knowledge_chunks", "workspace_id", new_column_name="project_id"
    )
    op.alter_column(
        "conversations", "workspace_id", new_column_name="project_id"
    )

    op.rename_table(
        "conversation_excluded_workspace_files",
        "conversation_excluded_project_files",
    )
    op.rename_table("workspace_shares", "project_shares")
    op.rename_table("workspace_files", "chat_project_files")
    op.rename_table("workspaces", "chat_projects")

    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (project_id IS NOT NULL)::int"
        " + (study_project_id IS NOT NULL)::int) = 1",
    )
