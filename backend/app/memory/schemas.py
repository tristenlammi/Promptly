"""Pydantic schemas for the cross-chat memory API (Phase 6 + Phase 2 overhaul)."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.memory.constants import MAX_CONTENT_CHARS, MEMORY_CATEGORIES

_VALID_CATEGORIES = set(MEMORY_CATEGORIES)


def _coerce_category(v: str | None) -> str | None:
    """Return the value if it's in the controlled vocabulary, else None."""
    if v is None:
        return None
    return v if v in _VALID_CATEGORIES else None


class MemoryCreate(BaseModel):
    """Body for ``POST /api/memory`` — add a fact by hand."""

    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)
    # Optional category; ignored if not in the controlled vocabulary.
    category: str | None = None
    # Pinned facts are always injected regardless of retrieval cap.
    pinned: bool = False


class MemoryUpdate(BaseModel):
    """Body for ``PATCH /api/memory/{id}`` — partial edit of a fact.

    All fields are optional so the same endpoint handles text edits,
    category changes, and pin toggles without separate routes.
    """

    content: str | None = Field(default=None, min_length=1, max_length=MAX_CONTENT_CHARS)
    category: str | None = None
    # Explicit sentinel: None means "don't touch"; True/False means set it.
    pinned: bool | None = None


class MemoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    content: str
    source: str
    source_conversation_id: uuid.UUID | None
    category: str | None
    pinned: bool
    times_used: int
    last_used_at: datetime | None
    created_at: datetime
    updated_at: datetime
