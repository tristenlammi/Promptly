"""Pydantic schemas for the Search API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SearchProviderType = Literal[
    "searxng", "brave", "tavily", "google_pse", "openrouter", "ollama"
]


class SearchResult(BaseModel):
    """A single search hit returned by any provider."""

    title: str
    url: str
    snippet: str = ""


class SearchResponse(BaseModel):
    """The full search result set for a query."""

    query: str
    provider: str
    results: list[SearchResult]


# ---- Provider config CRUD ----
class SearchProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    type: SearchProviderType
    # Free-form config; known keys:
    #   * ``url`` — SearXNG base URL
    #   * ``api_key`` — Brave / Tavily / Google PSE auth (encrypted at
    #     rest)
    #   * ``cx`` — Google PSE Search Engine ID (public identifier, not a
    #     secret; lives next to ``api_key`` in config)
    #   * ``safe`` — Google PSE SafeSearch level ("active" | "off")
    #   * ``search_depth`` — Tavily ("basic" | "advanced")
    #   * ``model`` — OpenRouter: pin a specific cheap model for the search
    #     completion (default ``openrouter/auto``). ``api_key`` is optional —
    #     falls back to the instance ``OPENROUTER_API_KEY``.
    #   * ``api_key`` — Ollama: key from a (free) ollama.com account; the
    #     search runs on Ollama's hosted API, not the local runtime.
    #   * ``result_count`` — int, optional per-provider override of the
    #     global ``SEARCH_RESULT_COUNT`` setting.
    config: dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False
    enabled: bool = True
    # ``system`` rows (user_id NULL) are visible to every account and
    # power the instance-wide default + failover chain. Creating one
    # requires admin; the plain ``user`` scope stays self-service.
    scope: Literal["user", "system"] = "user"


class SearchProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    config: dict[str, Any] | None = None
    is_default: bool | None = None
    enabled: bool | None = None


class SearchProviderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: SearchProviderType
    # Masked: API keys are replaced by "••••••1234" style previews.
    config: dict[str, Any]
    is_default: bool
    enabled: bool
    # Failover order (lower = tried first) + auto-backoff state (0153).
    position: int = 0
    cooldown_until: datetime | None = None
    last_error: str | None = None
    created_at: datetime


class SearchProviderReorder(BaseModel):
    """Admin sets the full failover order — providers are assigned
    ``position`` by their index in this list (first = tried first)."""

    order: list[uuid.UUID] = Field(min_length=1)


class SearchRunRequest(BaseModel):
    """Diagnostic/manual search request."""

    query: str = Field(min_length=1, max_length=500)
    provider_id: uuid.UUID | None = None
    count: int | None = Field(default=None, ge=1, le=20)
