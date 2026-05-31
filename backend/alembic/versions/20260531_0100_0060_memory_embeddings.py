"""memory embeddings for the memory overhaul (Phase 1)

Adds embedding columns (dual-dim, mirroring message_embeddings) plus a
content_hash + embed_dim for change detection directly onto
``user_memories`` — the row count per user is small (<=200) so a side
table isn't worth it.

Vector columns are added via raw SQL (SQLAlchemy / the app image ship no
``pgvector`` Python type — the codebase reads/writes vectors as text
literals cast to ``vector(N)``), exactly like 0058_message_embeddings.

Revision ID: 0060_memory_embeddings
Revises: 0059_conv_title_refined
Create Date: 2026-05-31 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0060_memory_embeddings"
down_revision: Union[str, Sequence[str], None] = "0059_conv_title_refined"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # pgvector extension is enabled by 0032; be defensive anyway.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # md5 hex of the embedded content (edit detection) + which dim is
    # populated. Both nullable: a row stays un-embedded until embedded
    # (or forever, when embeddings aren't configured).
    op.add_column(
        "user_memories",
        sa.Column("content_hash", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "user_memories",
        sa.Column("embed_dim", sa.Integer(), nullable=True),
    )

    # Real pgvector columns — raw SQL, same pattern as message_embeddings.
    op.execute(
        "ALTER TABLE user_memories ADD COLUMN embedding_768 vector(768)"
    )
    op.execute(
        "ALTER TABLE user_memories ADD COLUMN embedding_1536 vector(1536)"
    )

    # HNSW cosine indexes per dim (partial — only populated rows).
    op.execute(
        "CREATE INDEX ix_user_memories_embedding_768_hnsw "
        "ON user_memories USING hnsw (embedding_768 vector_cosine_ops) "
        "WHERE embedding_768 IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_user_memories_embedding_1536_hnsw "
        "ON user_memories USING hnsw (embedding_1536 vector_cosine_ops) "
        "WHERE embedding_1536 IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_user_memories_embedding_1536_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_user_memories_embedding_768_hnsw")
    op.execute("ALTER TABLE user_memories DROP COLUMN IF EXISTS embedding_1536")
    op.execute("ALTER TABLE user_memories DROP COLUMN IF EXISTS embedding_768")
    op.drop_column("user_memories", "embed_dim")
    op.drop_column("user_memories", "content_hash")
