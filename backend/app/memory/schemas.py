"""Pydantic schemas for the cross-chat memory API (Phase 6)."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.memory.constants import MAX_CONTENT_CHARS


class MemoryCreate(BaseModel):
    """Body for ``POST /api/memory`` — add a fact by hand."""

    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)


class MemoryUpdate(BaseModel):
    """Body for ``PATCH /api/memory/{id}`` — edit a fact's text."""

    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)


class MemoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    content: str
    source: str
    source_conversation_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
