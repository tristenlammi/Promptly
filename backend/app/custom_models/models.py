"""ORM models for the Custom Models feature.

Three tables:

* :class:`CustomModel`             — the assistant definition.
* :class:`CustomModelFile`         — M:N to ``UserFile`` with per-
  file indexing lifecycle.
* :class:`KnowledgeChunk`          — the actual RAG index. Vectors
  are accessed via raw SQL (see :mod:`app.custom_models.embedding`)
  to avoid pulling in the optional ``pgvector`` Python codec on
  every asyncpg connection — keeps the dependency surface flat.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class CustomModel(Base):
    """Admin-curated assistant. One per row.

    The wrapper carries no model-runtime state of its own; at chat
    time the dispatcher swaps the synthetic ``custom:<uuid>`` model
    id for ``(base_provider_id, base_model_id)`` and the rest of
    the streaming path is unchanged.
    """

    __tablename__ = "custom_models"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=func.gen_random_uuid(),
    )

    # Slug — appears in URLs / logs. Unique workspace-wide. Display
    # name is the human-facing label shown in the picker.
    name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Personality / system prompt. Merged INTO the chat's effective
    # system prompt at the highest priority slot (above tools and
    # personal context).
    personality: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Underlying model. ``base_provider_id`` is the FK we cascade
    # on; ``base_model_id`` is the string id within that provider's
    # catalog (matches ``ModelProvider.models[i].id``).
    base_provider_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("model_providers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    base_model_id: Mapped[str] = mapped_column(String(128), nullable=False)

    # Number of nearest chunks to inject into the system prompt at
    # send time. 6 is a sensible default for ~500-token chunks; the
    # admin can dial it via the slider in the create/edit form.
    top_k: Mapped[int] = mapped_column(
        Integer, nullable=False, default=6, server_default="6"
    )

    # Audit only — the admin who created this. SET NULL on user
    # delete so removing an admin doesn't cascade-delete the
    # assistants they made.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Loaded eagerly when rendering the Custom Models panel so the
    # UI can show indexing status per file without an N+1.
    files: Mapped[list["CustomModelFile"]] = relationship(
        "CustomModelFile",
        back_populates="custom_model",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"<CustomModel id={self.id} name={self.name!r} "
            f"base={self.base_model_id!r}>"
        )


class CustomModelFile(Base):
    """Pivot row between a custom model and a file in My Files.

    Carries the per-file indexing lifecycle so the UI can render
    chips like "PDF · embedding…" or "TXT · failed (retry?)".
    """

    __tablename__ = "custom_model_files"

    custom_model_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("custom_models.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_file_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("files.id", ondelete="CASCADE"),
        primary_key=True,
    )

    # Lifecycle: queued -> embedding -> ready (or failed at any step).
    indexing_status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="queued",
        server_default="'queued'",
    )
    indexing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SHA-256 of the source bytes the last time we indexed. Lets the
    # ingester skip work when the file content hasn't changed.
    indexed_content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    custom_model: Mapped[CustomModel] = relationship(
        "CustomModel", back_populates="files"
    )

    def __repr__(self) -> str:
        return (
            f"<CustomModelFile model={self.custom_model_id} "
            f"file={self.user_file_id} status={self.indexing_status}>"
        )


class KnowledgeChunk(Base):
    """One indexed chunk of a knowledge-library file.

    Vectors are accessed via raw SQL — the column types are
    ``vector(N)`` in the database (added by the migration) but
    SQLAlchemy here only knows them as ``ARRAY(Float)`` placeholders.
    The retrieval and embedding code in
    :mod:`app.custom_models.embedding` and
    :mod:`app.custom_models.retrieval` writes ``embedding_<dim>``
    via parameterised SQL strings. This keeps the asyncpg connection
    pool free of pgvector codec registration boilerplate.
    """

    __tablename__ = "knowledge_chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=func.gen_random_uuid(),
    )

    custom_model_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("custom_models.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_file_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("files.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)

    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    embedding_dim: Mapped[int] = mapped_column(Integer, nullable=False)

    # Provenance for citation rendering ("from page 4 of FILE.pdf").
    chunk_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",  # column name "metadata" (avoid SQLAlchemy reserved attr)
        JSONB,
        nullable=False,
        default=dict,
        server_default="'{}'::jsonb",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "custom_model_id",
            "user_file_id",
            "chunk_index",
            name="uq_knowledge_chunks_chunk",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<KnowledgeChunk model={self.custom_model_id} "
            f"file={self.user_file_id} idx={self.chunk_index}>"
        )
