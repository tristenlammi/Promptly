"""Project knowledge — generalise knowledge_chunks to a second scope.

Chat Projects gain retrieval over their pinned files (hybrid RAG): small
projects keep injecting files in full, larger ones switch to top-k
semantic retrieval. Rather than stand up a parallel vector store, we
reuse the Custom Models ``knowledge_chunks`` table — the expensive part
(two ``vector(N)`` columns + HNSW indexes) is already there.

Changes:

* ``knowledge_chunks.custom_model_id`` becomes **nullable** and a new
  nullable ``project_id`` (FK ``chat_projects.id`` ON DELETE CASCADE) is
  added. A CHECK constraint enforces that exactly one scope column is
  set per row, so a chunk always belongs to exactly one owner. A partial
  unique index mirrors the existing ``(custom_model_id, user_file_id,
  chunk_index)`` guard for the project scope.

* ``chat_project_files`` gains the same indexing-lifecycle columns
  ``custom_model_files`` carries (``indexing_status`` / ``indexing_error``
  / ``indexed_content_hash`` / ``indexed_at``) so the project Files tab
  can show indexing progress and the ingester can skip unchanged bytes.

Revision ID: 0070_project_knowledge
Revises: 0069_remove_email_tables
Create Date: 2026-06-01 10:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0070_project_knowledge"
down_revision: Union[str, Sequence[str], None] = "0069_remove_email_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- knowledge_chunks: add the project scope ---------------------
    op.alter_column(
        "knowledge_chunks", "custom_model_id", existing_type=postgresql.UUID(), nullable=True
    )
    op.add_column(
        "knowledge_chunks",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_projects.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_knowledge_chunks_project_id", "knowledge_chunks", ["project_id"]
    )
    # Exactly one owner per chunk.
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int + (project_id IS NOT NULL)::int) = 1",
    )
    # Mirror the custom-model dedup guard for project-scoped chunks.
    # Partial so it doesn't collide with the existing constraint's NULLs.
    op.execute(
        "CREATE UNIQUE INDEX uq_knowledge_chunks_project_chunk "
        "ON knowledge_chunks (project_id, user_file_id, chunk_index) "
        "WHERE project_id IS NOT NULL"
    )

    # --- chat_project_files: indexing lifecycle ----------------------
    op.add_column(
        "chat_project_files",
        sa.Column(
            "indexing_status",
            sa.String(16),
            nullable=False,
            server_default="queued",
        ),
    )
    op.add_column(
        "chat_project_files",
        sa.Column("indexing_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "chat_project_files",
        sa.Column("indexed_content_hash", sa.String(64), nullable=True),
    )
    op.add_column(
        "chat_project_files",
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_project_files", "indexed_at")
    op.drop_column("chat_project_files", "indexed_content_hash")
    op.drop_column("chat_project_files", "indexing_error")
    op.drop_column("chat_project_files", "indexing_status")

    # Project-scoped chunks can't survive without the project_id column;
    # drop them before reinstating the NOT NULL on custom_model_id.
    op.execute("DELETE FROM knowledge_chunks WHERE project_id IS NOT NULL")
    op.execute("DROP INDEX IF EXISTS uq_knowledge_chunks_project_chunk")
    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )
    op.drop_index("ix_knowledge_chunks_project_id", table_name="knowledge_chunks")
    op.drop_column("knowledge_chunks", "project_id")
    op.alter_column(
        "knowledge_chunks", "custom_model_id", existing_type=postgresql.UUID(), nullable=False
    )
