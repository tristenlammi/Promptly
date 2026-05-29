"""Add per-message embeddings for semantic conversation search (v2 Phase 7).

Adds ``message_embeddings`` — one pgvector row per indexed message — so
the conversation search palette can blend keyword (FTS) recall with
semantic (embedding) recall. Mirrors the ``knowledge_chunks`` storage
pattern: dual ``vector(768)`` / ``vector(1536)`` columns + HNSW cosine
indexes, populated by a background indexer.

Revision ID: 0058_msg_embeddings
Revises: 0057_user_memory
Create Date: 2026-05-30 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0058_msg_embeddings"
down_revision: Union[str, Sequence[str], None] = "0057_user_memory"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # pgvector is already enabled by 0032, but be defensive in case this
    # ever runs against a hand-rolled DB.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "message_embeddings",
        sa.Column(
            "message_id", postgresql.UUID(as_uuid=True), primary_key=True
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        # md5 hex of the embedded (normalised) content — lets the indexer
        # cheaply detect edits and re-embed only what changed.
        sa.Column("content_hash", sa.String(length=32), nullable=False),
        # Which vector column is populated (768 or 1536). Lets the indexer
        # re-embed rows when the admin switches embedding model/dim.
        sa.Column("embed_dim", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["message_id"], ["messages.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["conversations.id"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "ix_message_embeddings_conversation_id",
        "message_embeddings",
        ["conversation_id"],
    )

    # Real pgvector columns — added via raw SQL (SQLAlchemy ships no
    # vector type), same pattern as knowledge_chunks.
    op.execute(
        "ALTER TABLE message_embeddings ADD COLUMN embedding_768 vector(768)"
    )
    op.execute(
        "ALTER TABLE message_embeddings ADD COLUMN embedding_1536 vector(1536)"
    )

    op.execute(
        "CREATE INDEX ix_message_embeddings_embedding_768_hnsw "
        "ON message_embeddings USING hnsw (embedding_768 vector_cosine_ops) "
        "WHERE embedding_768 IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_message_embeddings_embedding_1536_hnsw "
        "ON message_embeddings USING hnsw (embedding_1536 vector_cosine_ops) "
        "WHERE embedding_1536 IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS ix_message_embeddings_embedding_1536_hnsw"
    )
    op.execute(
        "DROP INDEX IF EXISTS ix_message_embeddings_embedding_768_hnsw"
    )
    op.drop_index(
        "ix_message_embeddings_conversation_id",
        table_name="message_embeddings",
    )
    op.drop_table("message_embeddings")
