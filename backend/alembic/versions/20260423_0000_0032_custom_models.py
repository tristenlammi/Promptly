"""Custom Models — admin-curated assistants with personality + RAG knowledge.

Adds the four pieces needed for the Custom Models feature:

* ``vector`` Postgres extension (pgvector). Required for the
  ``knowledge_chunks.embedding_*`` columns. The base image was bumped
  from ``postgres:15-alpine`` to ``pgvector/pgvector:pg15`` in the same
  release so the shared library is available — this migration is the
  "turn it on" step. Idempotent (``IF NOT EXISTS``) so re-runs are safe.

* ``custom_models`` — one row per admin-curated assistant. Holds the
  personality (system prompt), the underlying ``(base_provider_id,
  base_model_id)`` it dispatches to, and a ``top_k`` retrieval knob.

* ``custom_model_files`` — many-to-many between custom models and
  ``user_files``. Reference-link, not snapshot: editing the source file
  in My Files re-triggers indexing rather than diverging. Carries the
  per-file indexing lifecycle (``queued``/``embedding``/``ready``/
  ``failed``) so the UI can surface progress.

* ``knowledge_chunks`` — the actual RAG index. Two parallel vector
  columns (``embedding_768`` and ``embedding_1536``) cover the two
  dimensions every popular embedding model emits today (nomic /
  gemini / mxbai = 768; OpenAI text-embedding-3-small + most others
  = 1536). The chunk knows which column is populated via
  ``embedding_dim``; queries hit the matching column + HNSW index.
  Adding new dimensions later is a one-column ``ALTER TABLE`` migration,
  not a data migration — the existing rows keep working.

* ``app_settings`` gains ``embedding_provider_id`` + ``embedding_model_id``
  + ``embedding_dim``. Set during the setup wizard ("API or local?")
  and used by the ingester to pick the right embedding endpoint and
  the right vector column.

Revision ID: 0032_custom_models
Revises: 0031_project_shares
Create Date: 2026-04-23 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0032_custom_models"
down_revision: Union[str, Sequence[str], None] = "0031_project_shares"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Enable pgvector. ``IF NOT EXISTS`` so re-runs against a DB
    #    where the extension was hand-installed don't error out.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 2. Custom models — the assistant definitions themselves.
    op.create_table(
        "custom_models",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # Slug — stable across renames, used in URLs / logs. Unique
        # workspace-wide. Display name is the human-facing label.
        sa.Column("name", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("description", sa.String(512), nullable=True),
        # Personality / system prompt. ``Text`` (no length cap) on
        # purpose — admins occasionally want a few KB of "you are
        # Aria, our internal docs assistant, follow these rules…".
        sa.Column("personality", sa.Text, nullable=True),
        # Base model dispatched to. Both columns required at create
        # time but the FK on ``base_provider_id`` lets a removed
        # provider cascade-clean the wrappers that point at it.
        sa.Column(
            "base_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("base_model_id", sa.String(128), nullable=False),
        # Retrieval knob. 6 is the sweet spot for most knowledge bases
        # (~3KB of injected context with our 500-token chunks).
        sa.Column(
            "top_k",
            sa.Integer,
            nullable=False,
            server_default=sa.text("6"),
        ),
        # Owner/auditor — admin who created this. Kept on user delete
        # (SET NULL) so the row survives staff turnover.
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
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
    )

    # 3. M:N join to UserFile. Reference-linked, not snapshot.
    op.create_table(
        "custom_model_files",
        sa.Column(
            "custom_model_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("custom_models.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        # Per-file indexing state. Stored as plain string (no enum)
        # so adding states later is migration-free.
        # Lifecycle: queued -> embedding -> ready (or failed).
        sa.Column(
            "indexing_status",
            sa.String(16),
            nullable=False,
            server_default=sa.text("'queued'"),
        ),
        # Last error message when ``indexing_status='failed'`` so the
        # UI can show a useful toast instead of "something went wrong".
        sa.Column("indexing_error", sa.Text, nullable=True),
        # Hash of the source file's content the last time we indexed.
        # On re-attach / re-embed we compare against the current file
        # hash and skip the work if nothing changed (re-pinning a
        # 200 MB PDF with no edits should be free).
        sa.Column("indexed_content_hash", sa.String(64), nullable=True),
        sa.Column(
            "indexed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    # Hot path on the Custom Models panel: "show indexing status of
    # all files for this assistant".
    op.create_index(
        "ix_custom_model_files_custom_model_id",
        "custom_model_files",
        ["custom_model_id"],
    )

    # 4. The actual RAG index. Two vector columns; only one is
    #    populated per row (matches the workspace embedding dim).
    op.create_table(
        "knowledge_chunks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "custom_model_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("custom_models.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("tokens", sa.Integer, nullable=True),
        # Workspace-level embedding model + dim that produced this
        # vector. Used to detect "stale" chunks if the admin ever
        # switches embedding providers (we surface a re-index banner
        # rather than silently mixing dimensions).
        sa.Column("embedding_model", sa.String(128), nullable=True),
        sa.Column("embedding_dim", sa.Integer, nullable=False),
        # Raw vectors. Stored as ``vector(N)`` of fixed dimension —
        # only one of the two is populated per row. Adding a third
        # dimension later is a one-column ALTER TABLE; existing rows
        # keep their dim.
        sa.Column(
            "embedding_768",
            sa.dialects.postgresql.ARRAY(sa.Float),  # placeholder; replaced below
            nullable=True,
        ),
        sa.Column(
            "embedding_1536",
            sa.dialects.postgresql.ARRAY(sa.Float),  # placeholder; replaced below
            nullable=True,
        ),
        # Lightweight provenance: page number for PDFs, byte offset
        # for plaintext, etc. Used to render "from page 4" in the UI.
        sa.Column(
            "metadata",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        # Composite uniqueness so re-indexing the same file doesn't
        # leave duplicate chunks lying around (the ingester deletes +
        # re-inserts, but this is a safety net).
        sa.UniqueConstraint(
            "custom_model_id",
            "user_file_id",
            "chunk_index",
            name="uq_knowledge_chunks_chunk",
        ),
    )

    # SQLAlchemy doesn't ship a vector type out of the box, so the
    # column was created above with a placeholder ARRAY type. Swap
    # it to the real ``vector(N)`` now that the table exists. This
    # is the standard pattern for pgvector + alembic until everyone
    # imports ``sqlalchemy-pgvector`` — keeps the migration's only
    # dependency on the alembic+sqlalchemy that ships with the app.
    op.execute("ALTER TABLE knowledge_chunks DROP COLUMN embedding_768")
    op.execute("ALTER TABLE knowledge_chunks DROP COLUMN embedding_1536")
    op.execute("ALTER TABLE knowledge_chunks ADD COLUMN embedding_768 vector(768)")
    op.execute("ALTER TABLE knowledge_chunks ADD COLUMN embedding_1536 vector(1536)")

    # HNSW indexes per dimension. Cosine similarity is the default
    # for retrieval — matches what every popular embedding model
    # is trained against. Only built on populated rows (partial
    # index on ``IS NOT NULL``) so the empty column is free of cost.
    op.execute(
        "CREATE INDEX ix_knowledge_chunks_embedding_768_hnsw "
        "ON knowledge_chunks USING hnsw (embedding_768 vector_cosine_ops) "
        "WHERE embedding_768 IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_knowledge_chunks_embedding_1536_hnsw "
        "ON knowledge_chunks USING hnsw (embedding_1536 vector_cosine_ops) "
        "WHERE embedding_1536 IS NOT NULL"
    )

    # 5. Workspace-level embedding provider config on the singleton
    #    ``app_settings`` row. Nullable so a fresh install starts in
    #    "not configured" state and the setup wizard fills it in.
    op.add_column(
        "app_settings",
        sa.Column(
            "embedding_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("embedding_model_id", sa.String(128), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("embedding_dim", sa.Integer, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "embedding_dim")
    op.drop_column("app_settings", "embedding_model_id")
    op.drop_column("app_settings", "embedding_provider_id")

    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_1536_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_768_hnsw")
    op.drop_table("knowledge_chunks")

    op.drop_index(
        "ix_custom_model_files_custom_model_id",
        table_name="custom_model_files",
    )
    op.drop_table("custom_model_files")
    op.drop_table("custom_models")
    # Leave the ``vector`` extension installed — dropping it could
    # break unrelated tables in dev environments where someone
    # added their own vector column outside of Promptly.
