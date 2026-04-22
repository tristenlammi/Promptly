"""Pydantic schemas for the Models tab API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl  # noqa: F401

ProviderType = Literal[
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "ollama",
    "openai_compatible",
]


class ModelPrivacy(BaseModel):
    """Compact summary of a model's upstream endpoint data policies.

    Only populated for providers that expose per-endpoint privacy
    metadata (currently: OpenRouter via ``/models/{id}/endpoints``).
    The frontend derives a user-facing badge from the raw numbers —
    keeping the phrasing out of the backend means we can tweak the
    copy without shipping a new catalog refresh.

    Fields are counts across all endpoints OpenRouter knows about
    for this model *at the time of the last catalog refresh* — they
    aren't authoritative, just informative.
    """

    endpoints_count: int = 0
    # Endpoints where ``data_policy.training`` is true.
    training_endpoints: int = 0
    # Endpoints where ``retains_prompts`` or ``retention_days > 0``.
    retains_prompts_endpoints: int = 0
    # Endpoints that do neither of the above — closest thing to "ZDR".
    zdr_endpoints: int = 0
    # Worst-case retention window across endpoints, in days.
    max_retention_days: int | None = None


class ModelInfo(BaseModel):
    id: str
    display_name: str
    context_window: int | None = None
    pricing: dict[str, Any] | None = None
    description: str | None = None
    # True if the model accepts image input (per the upstream catalog's
    # `architecture.input_modalities`). Defaults False so legacy DB rows
    # written before Phase 3 deserialize cleanly.
    supports_vision: bool = False
    # True if the model can *emit* images in its response (per the
    # upstream catalog's `architecture.output_modalities`). Used by the
    # `generate_image` tool to pick a model the user has actually
    # enabled. Defaults False to match legacy rows.
    supports_image_output: bool = False
    # Upstream data-policy summary — ``None`` means "we didn't fetch
    # it for this model" (non-OpenRouter provider, or refresh was run
    # before this field existed). The picker shows an "unknown" hint
    # rather than assuming the worst.
    privacy: ModelPrivacy | None = None


class ProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    type: ProviderType
    base_url: HttpUrl | None = None
    # Optional because keyless providers (Ollama) don't need one; the
    # router rejects an empty key for every other type.
    api_key: str | None = Field(default=None, max_length=1024)
    enabled: bool = True
    # Optional client-curated subset of models. If empty, every model from
    # list_models() will be used.
    models: list[ModelInfo] = Field(default_factory=list)


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    base_url: HttpUrl | None = None
    # None = leave unchanged; empty string would be weird so reject in router.
    api_key: str | None = Field(default=None, max_length=1024)
    enabled: bool | None = None
    models: list[ModelInfo] | None = None
    # None = leave unchanged. Pass a list (possibly empty) to overwrite, or
    # an explicit JSON `null` via PATCH to reset to "all enabled".
    enabled_models: list[str] | None = None


class ProviderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: ProviderType
    base_url: str | None
    # Never returns the raw key — just a masked preview like "sk-…xyz" so the
    # UI can confirm a key is set without leaking it.
    api_key_masked: str | None
    enabled: bool
    models: list[ModelInfo]
    # NULL → the UI should treat every model in `models` as enabled.
    enabled_models: list[str] | None = None
    created_at: datetime


class TestConnectionResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    ok: bool
    error: str | None = None
    model_count: int | None = None


class AvailableModel(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    provider_id: uuid.UUID
    provider_name: str
    provider_type: ProviderType
    model_id: str
    display_name: str
    context_window: int | None = None
    supports_vision: bool = False
    supports_image_output: bool = False
    # ----- Custom Models discriminator (Phase RAG-1) -----
    # ``True`` for synthetic rows that wrap a CustomModel row. The
    # frontend ModelSelector groups these under a "Custom Models"
    # section and renders the base model's display name as a subtitle
    # so the user knows what's actually answering. ``model_id`` for
    # custom rows is the synthetic ``custom:<uuid>`` that the chat
    # router resolves at send time.
    is_custom: bool = False
    # The id of the underlying ``custom_models`` row — handy for the
    # frontend when it needs to deep-link into the admin edit drawer.
    # ``None`` for non-custom rows.
    custom_model_id: uuid.UUID | None = None
    # Display name of the underlying base model so the picker can
    # render a subtitle without doing a second lookup.
    base_display_name: str | None = None
