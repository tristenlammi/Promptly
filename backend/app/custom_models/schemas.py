"""Pydantic DTOs for the Custom Models admin API + chat-picker integration."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Knowledge library — per-file rows surfaced in the create/edit form
# ---------------------------------------------------------------------------


class KnowledgeFile(BaseModel):
    """Per-file indexing status, joined with the source ``files`` row.

    Returned as a nested list inside :class:`CustomModelDetail` so
    the create/edit drawer can render chips like
    "report.pdf · ready · 12 chunks".
    """

    model_config = ConfigDict(from_attributes=True)

    user_file_id: uuid.UUID
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    indexing_status: str
    indexing_error: str | None = None
    indexed_at: datetime | None = None
    added_at: datetime
    chunk_count: int = 0


# ---------------------------------------------------------------------------
# Custom Model rows
# ---------------------------------------------------------------------------


class CustomModelSummary(BaseModel):
    """Compact row for the Custom Models grid on the admin Models page."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    display_name: str
    description: str | None = None
    base_provider_id: uuid.UUID
    base_model_id: str
    base_display_name: str | None = None
    file_count: int = 0
    ready_file_count: int = 0
    top_k: int
    created_at: datetime
    updated_at: datetime


class CustomModelDetail(CustomModelSummary):
    """Full row including personality + the attached knowledge files."""

    personality: str | None = None
    files: list[KnowledgeFile] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Mutation payloads
# ---------------------------------------------------------------------------


class CustomModelCreate(BaseModel):
    """Payload for ``POST /admin/custom-models``."""

    name: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    display_name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=512)
    personality: str | None = Field(default=None, max_length=16_000)
    base_provider_id: uuid.UUID
    base_model_id: str = Field(min_length=1, max_length=128)
    top_k: int = Field(default=6, ge=1, le=20)
    # Optional initial knowledge library — file ids the admin has
    # already uploaded into My Files. Keeps the create-then-attach
    # round trip from being an awkward two-step in the UI.
    file_ids: list[uuid.UUID] = Field(default_factory=list)


class CustomModelUpdate(BaseModel):
    """Payload for ``PATCH /admin/custom-models/{id}``.

    Every field is optional; ``model_fields_set`` is consulted in the
    router so omitted fields stay untouched and explicit nulls clear.
    """

    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=512)
    personality: str | None = Field(default=None, max_length=16_000)
    base_provider_id: uuid.UUID | None = None
    base_model_id: str | None = Field(default=None, min_length=1, max_length=128)
    top_k: int | None = Field(default=None, ge=1, le=20)


class AttachFilesRequest(BaseModel):
    """Bulk-attach payload — pin a list of My-Files rows to an assistant."""

    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Workspace embedding-provider config (consumed by the setup wizard +
# the Custom Models panel banner)
# ---------------------------------------------------------------------------


class EmbeddingConfig(BaseModel):
    """Workspace's chosen embedding provider, returned by the wizard."""

    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    embedding_provider_id: uuid.UUID | None = None
    embedding_model_id: str | None = None
    embedding_dim: int | None = None
    # Convenience: human label assembled from the FK so the UI doesn't
    # have to re-resolve the provider just to render a banner.
    embedding_provider_name: str | None = None


class EmbeddingConfigUpdate(BaseModel):
    """Set or clear the workspace embedding choice.

    Pass ``embedding_provider_id=None`` to clear (Custom Models will
    then refuse to embed and surface a "configure embedding" banner).
    Otherwise both ids must be set.
    """

    model_config = ConfigDict(protected_namespaces=())

    embedding_provider_id: uuid.UUID | None = None
    embedding_model_id: str | None = Field(default=None, max_length=128)
    embedding_dim: int | None = Field(default=None, ge=1, le=8192)


class EmbeddingConfigTestResult(BaseModel):
    """Outcome of a one-shot embedding smoke test.

    Returned by ``POST /embedding-config/test`` so the admin UI can
    show end-to-end confirmation (provider reachable, model installed,
    dim matches, round-trip latency) without having to drop to a shell.
    Always HTTP 200 — the ``ok`` flag distinguishes success from
    failure so the UI can render both states inline.
    """

    model_config = ConfigDict(protected_namespaces=())

    ok: bool
    embedding_provider_id: uuid.UUID | None = None
    embedding_model_id: str | None = None
    embedding_provider_name: str | None = None
    dimension: int | None = None
    latency_ms: int | None = None
    # First few floats of the returned vector — purely cosmetic, helps
    # the admin see that a "real" vector came back rather than a
    # mocked placeholder.
    sample: list[float] | None = None
    error: str | None = None
