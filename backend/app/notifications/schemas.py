"""Pydantic schemas for the notifications router."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SubscribePayload(BaseModel):
    """Shape the frontend sends after a successful
    ``registration.pushManager.subscribe()`` — mirrors the
    ``PushSubscriptionJSON`` the browser exposes via
    ``subscription.toJSON()`` so no hand-shaping needed client-side."""

    endpoint: str
    keys: dict[str, str]
    user_agent: str | None = None
    label: str | None = None


class SubscriptionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str | None = None
    user_agent: str | None = None
    created_at: datetime
    last_used_at: datetime | None = None


class SubscriptionUpdate(BaseModel):
    """Patch payload for the Devices list — only the label is user-
    editable; everything else is opaque push-service config."""

    label: str | None = Field(default=None, max_length=120)


class PreferencesSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    enabled: bool
    export_ready: bool
    import_done: bool
    shared_message: bool
    task_complete: bool
    mention: bool
    assignment: bool
    invite: bool


class PreferencesUpdate(BaseModel):
    """Patch: every field optional so the UI can flip one toggle
    without having to send the whole object. Unset fields are
    ignored."""

    enabled: bool | None = None
    export_ready: bool | None = None
    import_done: bool | None = None
    shared_message: bool | None = None
    task_complete: bool | None = None
    mention: bool | None = None
    assignment: bool | None = None
    invite: bool | None = None


class NotificationActor(BaseModel):
    """Who triggered the notification — drives the inbox row avatar."""

    username: str
    avatar_url: str | None = None
    avatar_color: str | None = None


class NotificationRow(BaseModel):
    """One inbox entry."""

    id: uuid.UUID
    category: str
    title: str
    body: str
    url: str | None = None
    workspace_id: uuid.UUID | None = None
    actor: NotificationActor | None = None
    read_at: datetime | None = None
    created_at: datetime


class InboxResponse(BaseModel):
    items: list[NotificationRow]
    unread_count: int


class PublicKeyResponse(BaseModel):
    public_key: str


class TestPushResponse(BaseModel):
    sent: int
