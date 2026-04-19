"""Pydantic schemas for the Models tab API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl  # noqa: F401

# Phase 2b ships OpenRouter only. Keep the Literal open-ended for forward
# compatibility — the service layer is what enforces "openrouter only" today.
ProviderType = Literal["openrouter", "openai", "anthropic", "ollama", "openai_compatible"]


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


class ProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    type: ProviderType
    base_url: HttpUrl | None = None
    api_key: str = Field(min_length=1, max_length=1024)
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
