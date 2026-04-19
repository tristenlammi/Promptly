"""Pydantic schemas for the Search API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SearchProviderType = Literal["searxng", "brave", "tavily", "google_pse"]


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
    #   * ``result_count`` — int, optional per-provider override of the
    #     global ``SEARCH_RESULT_COUNT`` setting.
    config: dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False
    enabled: bool = True


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
    created_at: datetime


class SearchRunRequest(BaseModel):
    """Diagnostic/manual search request."""

    query: str = Field(min_length=1, max_length=500)
    provider_id: uuid.UUID | None = None
    count: int | None = Field(default=None, ge=1, le=20)
