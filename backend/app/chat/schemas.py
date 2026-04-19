"""Pydantic schemas for chat conversations + messages."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MessageRole = Literal["user", "assistant", "system"]

# Per-conversation web-search behaviour (Phase D1):
#   * ``off``    — never search the web on this conversation
#   * ``auto``   — model decides per turn via the ``web_search`` tool
#   * ``always`` — synthesise a forced search before every reply
# Persisted on ``conversations.web_search_mode`` and accepted on the
# send/edit message payloads as a per-turn override.
WebSearchMode = Literal["off", "auto", "always"]

# Temporary-chat lifecycle modes (Phase Z1). See ``Conversation.temporary_mode``
# for full semantics. Used both on the create payload and on the listing
# responses so the frontend can render the right badge / chrome.
TemporaryMode = Literal["ephemeral", "one_hour"]


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    conversation_id: uuid.UUID
    role: MessageRole
    content: str
    sources: list[dict[str, Any]] | None = None
    # Files the user attached via the paperclip modal (user messages only).
    # Snapshot of id / filename / mime_type / size_bytes captured at send
    # time; these chips survive even if the underlying file is later
    # deleted from the Files tab.
    attachments: list[dict[str, Any]] | None = None
    created_at: datetime
    # Assistant-only performance metrics. Null on user / system rows and on
    # any assistant row produced before 0004_msg_metrics ran.
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    ttft_ms: int | None = None
    total_ms: int | None = None
    # Per-message dollar cost (completion + paid tools) — exposed as a
    # float so the frontend doesn't need to know about the integer
    # micros storage. ``None`` for non-assistant rows and any
    # assistant row from a provider that didn't report a cost.
    cost_usd: float | None = None
    # Phase 4b — who actually sent this user message. ``None`` for
    # assistant / system rows. The frontend uses this together with
    # ``ConversationDetail.collaborators`` to render "from Jane"
    # author chips on shared chats.
    author_user_id: uuid.UUID | None = None

    @model_validator(mode="before")
    @classmethod
    def _derive_cost_usd(cls, data: Any) -> Any:
        # ORM rows store cost as integer micros to keep additive
        # rollups exact. Convert to dollars at the API boundary so the
        # frontend never has to know about the storage unit.
        if data is None:
            return data
        # ``data`` is a Message ORM instance when validated via
        # ``model_validate(message_orm_row)``; a dict in pure-API code
        # paths (e.g. tests). Handle both.
        if isinstance(data, dict):
            if data.get("cost_usd") is None and "cost_usd_micros" in data:
                micros = data.get("cost_usd_micros")
                if micros is not None:
                    data["cost_usd"] = micros / 1_000_000.0
            return data
        # Object-with-attribute path. We can't mutate arbitrary ORM
        # rows safely, so emit a dict with the desired shape.
        if getattr(data, "cost_usd", None) is None:
            micros = getattr(data, "cost_usd_micros", None)
            if micros is not None:
                payload = {
                    k: getattr(data, k, None)
                    for k in (
                        "id",
                        "conversation_id",
                        "role",
                        "content",
                        "sources",
                        "attachments",
                        "created_at",
                        "prompt_tokens",
                        "completion_tokens",
                        "ttft_ms",
                        "total_ms",
                        "author_user_id",
                    )
                }
                payload["cost_usd"] = micros / 1_000_000.0
                return payload
        return data


class ConversationSummary(BaseModel):
    # Disable Pydantic's `model_` protected namespace so fields named
    # `model_id` don't trigger warnings.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    title: str | None
    model_id: str | None
    provider_id: uuid.UUID | None
    pinned: bool
    starred: bool
    web_search_mode: WebSearchMode
    created_at: datetime
    updated_at: datetime
    # Phase 4b — caller's relationship to the conversation. ``"owner"``
    # for chats they created, ``"collaborator"`` for chats shared with
    # them via an accepted invite. Drives sidebar pill + share-button
    # visibility on the frontend.
    role: Literal["owner", "collaborator"] = "owner"
    # Phase 4c — branching metadata. All NULL on regular chats; set by
    # ``POST /conversations/{id}/branch`` to preserve provenance so
    # the UI can render a "branched from" chip at the top of the
    # forked conversation.
    parent_conversation_id: uuid.UUID | None = None
    parent_message_id: uuid.UUID | None = None
    branched_at: datetime | None = None
    # Phase Z1 — temporary chat lifecycle. ``None`` for normal chats;
    # set to ``"ephemeral"`` or ``"one_hour"`` for short-lived ones.
    # ``expires_at`` ticks the countdown on the client.
    temporary_mode: TemporaryMode | None = None
    expires_at: datetime | None = None


class ConversationParticipantBrief(BaseModel):
    """Participant identity surfaced in conversation detail."""

    user_id: uuid.UUID
    username: str
    email: str


class ConversationDetail(ConversationSummary):
    messages: list[MessageResponse]
    # Phase 4b — owner + accepted collaborators. Frontend renders
    # author chips on user messages whenever ``len(collaborators) > 0``.
    owner: ConversationParticipantBrief | None = None
    collaborators: list[ConversationParticipantBrief] = Field(default_factory=list)


class ConversationCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    web_search_mode: WebSearchMode = "off"
    # Phase Z1 — opt into temporary lifecycle at creation time. ``None``
    # produces a normal permanent chat. The router computes ``expires_at``
    # itself; the client only picks the mode.
    temporary_mode: TemporaryMode | None = None


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    pinned: bool | None = None
    starred: bool | None = None
    web_search_mode: WebSearchMode | None = None
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    content: str = Field(min_length=1)
    # Override per-message; falls back to the conversation's stored model.
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    # ``None`` keeps the conversation's stored mode; an explicit value
    # overrides it for this turn AND persists back onto the conversation
    # so the next plain send picks the same mode without re-specifying.
    web_search_mode: WebSearchMode | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=4096, ge=1, le=100_000)
    # IDs of files from /api/files the user picked via the paperclip modal.
    # Each must be readable by the caller (their own or shared-pool files).
    attachment_ids: list[uuid.UUID] = Field(default_factory=list)
    # Per-turn opt-in for AI tool calling (echo / attach_demo_file in
    # Phase A1; image gen / PDF authoring later). Off by default so an
    # ordinary chat doesn't pay the extra round-trip when no tool would
    # ever fire — and so the UI affordance for "this turn used tools" is
    # always meaningful.
    tools_enabled: bool = False


class SendMessageResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: MessageResponse


class BranchConversationRequest(BaseModel):
    """Body for ``POST /conversations/{id}/branch``.

    ``message_id`` is the *fork point*: every message up to and
    including this one is copied into the new conversation; nothing
    after it is. The new conversation is owned by the caller (so a
    collaborator forking a shared chat creates their own private
    branch by default), with the same model/provider defaults as
    the source so the next reply uses the familiar setup.
    """

    message_id: uuid.UUID


class ConversationSearchHit(BaseModel):
    """One match returned by ``GET /api/conversations/search``.

    ``snippet`` is a ``ts_headline``-rendered string with HTML
    ``<mark>`` tags around the matched terms; the frontend renders
    it inside a sidebar card. ``conversation_id`` and ``message_id``
    let the click-through deep-link straight to the message.
    """

    conversation_id: uuid.UUID
    message_id: uuid.UUID
    conversation_title: str | None
    role: MessageRole
    snippet: str
    rank: float
    created_at: datetime


class EditMessageRequest(BaseModel):
    """Edit-and-resend payload.

    Reuses the ``SendMessageRequest`` overrides (model, web_search_mode,
    sampling params) so the user can change them on the retry — but
    defaults to whatever the conversation already had if omitted.
    ``attachment_ids`` is intentionally absent: editing only rewrites
    text. The original attachments stay snapshotted on the message and
    continue to be re-fed through the normal multimodal pipeline.
    """

    model_config = ConfigDict(protected_namespaces=())

    content: str = Field(min_length=1)
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    web_search_mode: WebSearchMode | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=4096, ge=1, le=100_000)
    # Mirror of SendMessageRequest: edited turns may toggle tool calling
    # on the retry independently of how the original send went.
    tools_enabled: bool = False
