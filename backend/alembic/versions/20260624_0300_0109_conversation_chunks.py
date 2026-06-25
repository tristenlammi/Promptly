"""Add a conversation scope to knowledge_chunks (Phase 9 — attachment RAG).

Lets a chat index its large attachments into an ephemeral, per-conversation
RAG store (instead of inlining + truncating them). Reuses the shared
``knowledge_chunks`` table + ``embedding_<dim>`` vector columns; this just
adds a fourth owner scope (``conversation_id``). Chunks cascade-delete with
the conversation, so the index is cleaned up automatically.

Revision ID: 0109_conversation_chunks
Revises: 0108_item_comments
Create Date: 2026-06-24 03:00:00

NB: keep the revision id short — ``alembic_version.version_num`` is
``varchar(32)``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0109_conversation_chunks"
down_revision: Union[str, Sequence[str], None] = "0108_item_comments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the 3-scope CHECK so we can add a fourth owner column.
    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )
    op.add_column(
        "knowledge_chunks",
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_knowledge_chunks_conversation_id",
        "knowledge_chunks",
        ["conversation_id"],
    )
    # Restore the constraint, now extended to four scopes — still exactly one.
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (study_project_id IS NOT NULL)::int"
        " + (conversation_id IS NOT NULL)::int) = 1",
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_knowledge_chunks_conversation_chunk"
        " ON knowledge_chunks (conversation_id, user_file_id, chunk_index)"
        " WHERE conversation_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_knowledge_chunks_conversation_chunk")
    op.drop_constraint(
        "ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check"
    )
    op.drop_index(
        "ix_knowledge_chunks_conversation_id", table_name="knowledge_chunks"
    )
    op.drop_column("knowledge_chunks", "conversation_id")
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (study_project_id IS NOT NULL)::int) = 1",
    )
