"""Pydantic schemas for the side-by-side compare-mode API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CompareColumnSpec(BaseModel):
    """One column in a compare-group create request."""

    model_config = ConfigDict(protected_namespaces=())

    provider_id: uuid.UUID
    model_id: str = Field(min_length=1, max_length=255)


class CompareGroupCreate(BaseModel):
    """Create a new compare group with N columns (2–4)."""

    columns: list[CompareColumnSpec] = Field(min_length=2, max_length=4)
    title: str | None = Field(default=None, max_length=200)
    # Optional seed prompt — when set, the backend immediately fans
    # the prompt out to every column so the user lands in the
    # compare view with streams already in flight. Omitting it
    # creates an empty group the user can compose into.
    seed_prompt: str | None = Field(default=None, max_length=16_000)


class CompareColumnSummary(BaseModel):
    """One column inside a compare-group response. Carries enough
    info to render the column header + detect the crown."""

    # ``model_id`` and ``model_display_name`` collide with Pydantic's
    # protected ``model_`` namespace. Opt out of the namespace for
    # this schema specifically so the warning goes away without
    # touching our conceptual "model" vocabulary.
    model_config = ConfigDict(protected_namespaces=())

    conversation_id: uuid.UUID
    provider_id: uuid.UUID | None
    model_id: str | None
    model_display_name: str | None = None
    provider_name: str | None = None
    is_crowned: bool = False


class CompareGroupSummary(BaseModel):
    """Shape used by the compare archive list (one row per group)."""

    id: uuid.UUID
    title: str | None
    seed_prompt: str | None
    crowned_conversation_id: uuid.UUID | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    column_count: int


class CompareGroupDetail(CompareGroupSummary):
    """Detail view including the columns + per-column conversation
    summaries. The frontend uses this to bootstrap the compare
    layout and kicks off SSE connections per column."""

    columns: list[CompareColumnSummary]


class CompareSendRequest(BaseModel):
    """Send the same prompt to every column of a compare group."""

    content: str = Field(min_length=1, max_length=32_000)


class CompareSendColumn(BaseModel):
    """Per-column response from ``POST /compare/groups/{id}/send``.
    One stream per column — the frontend opens N parallel SSE
    connections against ``/chat/stream/{stream_id}``."""

    conversation_id: uuid.UUID
    stream_id: uuid.UUID
    user_message_id: uuid.UUID


class CompareSendResponse(BaseModel):
    columns: list[CompareSendColumn]


class CompareCrownRequest(BaseModel):
    """Choose which column wins — the referenced conversation becomes
    a normal sidebar chat; the other columns stay accessible via the
    Compare archive view."""

    conversation_id: uuid.UUID


CompareGroupArchiveFilter = Literal["active", "archived", "all"]
