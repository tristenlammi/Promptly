"""Pydantic schemas for the notifications router."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

#: "HH:MM", 24-hour.
_CLOCK = r"^([01]\d|2[0-3]):[0-5]\d$"


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
    item_reminder: bool = True
    room_message: bool = True
    calendar: bool = True
    passwords: bool = True
    mail: bool = True
    porch: bool = True
    # Quiet hours (0320) — "HH:MM" in the person's own time zone.
    quiet_enabled: bool = False
    quiet_start: str = "22:00"
    quiet_end: str = "07:00"
    # A different pair for Friday and Saturday nights (periods ending on a
    # Saturday or Sunday); off = same times every night.
    quiet_weekend: bool = False
    quiet_weekend_start: str | None = None
    quiet_weekend_end: str | None = None
    # Categories set to "Daily summary" instead of instant.
    summary_categories: list[str] = Field(default_factory=list)
    # Read-only context for the settings page.
    summary_capable: list[str] = Field(default_factory=list)
    summary_time: str = "08:00"
    timezone: str = "UTC"
    quiet_now: bool = False


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
    item_reminder: bool | None = None
    room_message: bool | None = None
    calendar: bool | None = None
    passwords: bool | None = None
    mail: bool | None = None
    porch: bool | None = None
    quiet_enabled: bool | None = None
    quiet_start: str | None = Field(default=None, pattern=_CLOCK)
    quiet_end: str | None = Field(default=None, pattern=_CLOCK)
    quiet_weekend: bool | None = None
    quiet_weekend_start: str | None = Field(default=None, pattern=_CLOCK)
    quiet_weekend_end: str | None = Field(default=None, pattern=_CLOCK)
    summary_categories: list[str] | None = Field(default=None, max_length=32)


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
    # Accepted by the push service (it will deliver when the device is on).
    sent: int
    failed: int = 0
    # Devices whose browser had unsubscribed; dropped from the list.
    removed: int = 0
