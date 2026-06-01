"""Pydantic schemas for the email integration API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr


# ------------------------------------------------------------------ #
# Account                                                              #
# ------------------------------------------------------------------ #

class EmailAccountResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    email_address: str
    enabled: bool
    last_synced_at: datetime | None
    last_sync_error: str | None
    needs_full_resync: bool
    created_at: datetime


class OAuthStartResponse(BaseModel):
    """Redirect URL the frontend should navigate to for the OAuth consent screen."""
    auth_url: str
    state: str  # CSRF token stored in session


class OAuthCallbackRequest(BaseModel):
    code: str
    state: str


# ------------------------------------------------------------------ #
# Messages                                                             #
# ------------------------------------------------------------------ #

class EmailMessageBrief(BaseModel):
    """Lightweight summary shown in list/search views."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    thread_id: str | None
    subject: str | None
    from_address: str | None
    from_name: str | None
    date: datetime | None
    snippet: str | None
    read: bool
    archived: bool
    has_attachments: bool
    ai_category: str | None
    ai_priority: int | None
    ai_summary: str | None
    needs_reply: bool | None
    due_at: datetime | None


class EmailMessageDetail(EmailMessageBrief):
    """Full message including bodies and attachment ids."""
    body_text: str | None
    body_html: str | None
    to_addresses: list[Any]
    cc_addresses: list[Any]
    attachment_file_ids: list[Any]


# ------------------------------------------------------------------ #
# Contacts                                                             #
# ------------------------------------------------------------------ #

class EmailContactResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email_address: str
    display_name: str | None
    is_vip: bool
    message_count: int
    last_seen_at: datetime | None


class ContactVipUpdate(BaseModel):
    is_vip: bool


# ------------------------------------------------------------------ #
# Actions                                                              #
# ------------------------------------------------------------------ #

class MessageActionRequest(BaseModel):
    """Body for PATCH /email/messages/{id}/action."""
    action: Literal["read", "unread", "archive", "unarchive"]


class SyncNowRequest(BaseModel):
    account_id: uuid.UUID


# ------------------------------------------------------------------ #
# Calendar                                                             #
# ------------------------------------------------------------------ #

class CalendarEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider_event_id: str
    title: str | None
    start_at: datetime | None
    end_at: datetime | None
    all_day: bool
    location: str | None
    description: str | None
    attendees: list[Any]
    meet_link: str | None
    status: str | None


# ------------------------------------------------------------------ #
# Draft / send / AI assist                                             #
# ------------------------------------------------------------------ #

class DraftReplyRequest(BaseModel):
    instruction: str | None = None   # optional extra instruction for the AI

class DraftReplyResponse(BaseModel):
    draft: str

class SendReplyRequest(BaseModel):
    body: str                   # final (user-edited) text to send
    send_confirmed: bool = False  # must be True — guard against accidental sends

class AiAssistRequest(BaseModel):
    instruction: str            # e.g. "summarise this thread", "draft a polite decline"

class AiAssistResponse(BaseModel):
    response: str


# ------------------------------------------------------------------ #
# Calendar event creation                                              #
# ------------------------------------------------------------------ #

class CreateCalendarEventRequest(BaseModel):
    title: str
    start_at: datetime
    end_at: datetime
    all_day: bool = False
    location: str | None = None
    description: str | None = None


# ------------------------------------------------------------------ #
# Feature status (readable by any authenticated user)                  #
# ------------------------------------------------------------------ #

class EmailFeatureStatus(BaseModel):
    enabled: bool
    oauth_configured: bool


# ------------------------------------------------------------------ #
# Category counts                                                      #
# ------------------------------------------------------------------ #

class CategoryCounts(BaseModel):
    action_required: int = 0
    fyi: int = 0
    newsletter: int = 0
    promotional: int = 0
    social: int = 0
    spam: int = 0
    uncategorised: int = 0


# ------------------------------------------------------------------ #
# Search                                                               #
# ------------------------------------------------------------------ #

class EmailSearchResult(BaseModel):
    """One chunk returned by the search_emails tool."""
    email_id: uuid.UUID
    subject: str | None
    from_address: str | None
    from_name: str | None
    date: datetime | None
    excerpt: str
    score: float
    metadata: dict[str, Any]
