"""Pydantic schemas for Chat Projects.

Split from :mod:`app.chat.schemas` so the already-long chat schemas
module doesn't grow a second huge subject area. Imported by the
chat-projects router; nothing else in the codebase should depend on
these directly.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------
# Pinned file — trimmed view of :class:`UserFile` so the clients don't
# need the full file record to render the Files tab in the project
# detail page.
# ---------------------------------------------------------------------


class ChatProjectFilePin(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int
    pinned_at: datetime


# ---------------------------------------------------------------------
# Core project — mirrors the ORM row 1:1 plus a couple of derived
# rollups the list/detail pages need. Kept flat on purpose: the
# frontend cards and lists read directly off this shape without a
# second transform.
# ---------------------------------------------------------------------


class ChatProjectSummary(BaseModel):
    """Lightweight row returned by the list endpoints.

    Holds everything the project card on ``/projects`` needs to render
    — title, description, the conversation + file counts, and the
    archive flag — without touching the heavier ``system_prompt``
    blob (users might paste very long instructions and we don't want
    to re-download them on every list hit).
    """

    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    title: str
    description: str | None
    default_model_id: str | None
    default_provider_id: uuid.UUID | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Rolled up by the list endpoint — cheap enough via ``COUNT(*)``
    # and saves the frontend a second round-trip on every card.
    conversation_count: int = 0
    file_count: int = 0


class ChatProjectDetail(ChatProjectSummary):
    """Full project record, returned by ``GET /chat/projects/{id}``.

    Adds the heavy ``system_prompt`` and the pinned-files array so
    the project detail page can render all three tabs (Conversations,
    Files, Settings) from one request.
    """

    system_prompt: str | None = None
    files: list[ChatProjectFilePin] = Field(default_factory=list)


# ---------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------


class ChatProjectCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    default_model_id: str | None = Field(default=None, max_length=255)
    default_provider_id: uuid.UUID | None = None


class ChatProjectUpdate(BaseModel):
    """PATCH payload. Every field is optional — only the keys present
    in the request body are written. Same convention as
    :class:`ConversationUpdate`.

    To *clear* a value (e.g. remove the system prompt), send the key
    with an empty-string / null value — the router detects the
    presence of the key via ``model_fields_set`` and treats it as
    an explicit delete rather than "leave alone"."""

    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    default_model_id: str | None = Field(default=None, max_length=255)
    default_provider_id: uuid.UUID | None = None


class ChatProjectPinFile(BaseModel):
    """Body for ``POST /chat/projects/{pid}/files`` — pin a user file
    to the project so new conversations auto-attach it."""

    file_id: uuid.UUID
