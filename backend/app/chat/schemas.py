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

# DeepSeek-only reasoning knob. ``None`` on the wire means "use provider
# default" (and is the right value for every non-DeepSeek conversation);
# ``"off"`` disables thinking explicitly; ``"low"`` / ``"medium"`` /
# ``"high"`` enable thinking at the matching effort. The chat router
# only attaches these to the outbound request when the active provider
# is DeepSeek — sending them on other providers would 400 the call.
ReasoningEffort = Literal["off", "low", "medium", "high"]

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
    # Tool Activity Card — the per-turn tool-call log ({id, name, ok,
    # error?, error_kind?, elapsed_ms?, meta?}), assistant rows only.
    tool_calls: list[dict[str, Any]] | None = None
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
    # Which model produced this assistant row (raw id; the frontend maps it
    # to a friendly name). Lets the version pager show the model per reply.
    model_id: str | None = None
    # Per-message dollar cost (completion + paid tools) — exposed as a
    # float so the frontend doesn't need to know about the integer
    # micros storage. ``None`` for non-assistant rows and any
    # assistant row from a provider that didn't report a cost.
    cost_usd: float | None = None
    # Stamped when the assistant reply was hand-corrected via the
    # in-place edit endpoint. Null on every original-state row.
    edited_at: datetime | None = None
    # Phase 4b — who actually sent this user message. ``None`` for
    # assistant / system rows. The frontend uses this together with
    # ``ConversationDetail.collaborators`` to render "from Jane"
    # author chips on shared chats.
    author_user_id: uuid.UUID | None = None
    # Phase 2.5 — per-response quality signal on assistant replies.
    # ``None`` when unrated. ``feedback_reason`` carries the optional
    # short note left on a thumbs-down.
    feedback: Literal["up", "down"] | None = None
    feedback_reason: str | None = None
    # Phase 2.6 — in-thread regeneration versioning. ``parent_id`` is the
    # lineage link (the preceding message). The pager fields are only
    # populated for messages that actually have more than one sibling
    # version, and are attached by the router after validation (they are
    # computed, not stored on the row): ``version_index`` (1-based),
    # ``version_count``, and ``sibling_ids`` (ordered, for prev/next
    # navigation). All ``None`` when a message has a single version.
    parent_id: uuid.UUID | None = None
    version_index: int | None = None
    version_count: int | None = None
    sibling_ids: list[uuid.UUID] | None = None

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
                        "tool_calls",
                        "attachments",
                        "created_at",
                        "prompt_tokens",
                        "completion_tokens",
                        "ttft_ms",
                        "total_ms",
                        "model_id",
                        "author_user_id",
                        "edited_at",
                        "feedback",
                        "feedback_reason",
                        "parent_id",
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
    # DeepSeek-only knob. ``None`` for chats that haven't picked a
    # reasoning effort (the default for every non-DeepSeek model); the
    # frontend hides the reasoning chip when it sees ``None``.
    reasoning_effort: ReasoningEffort | None = None
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
    # Phase P1 — Workspaces. Non-NULL when this conversation lives
    # under a :class:`Workspace`; surfaced so the sidebar can group
    # chats by workspace and the breadcrumb can render "Workspace → Chat".
    workspace_id: uuid.UUID | None = None
    # Chat folders (0148) — non-NULL when this personal chat lives in a
    # user-created folder. Drives the sidebar grouping. Mutually exclusive
    # with ``workspace_id`` (a chat in a workspace is never in a folder).
    folder_id: uuid.UUID | None = None
    # Phase 1 — per-conversation custom instructions. Hydrated into the
    # chat header's "Instructions" editor so the owner can see / tweak
    # the per-chat steer. NULL / blank when unset.
    system_prompt: str | None = None
    # Phase 9 — per-conversation memory capture pause.
    memory_capture_paused: bool = False
    # Archive (0082). NULL when the chat is active; set when it's been
    # archived (lives on the Archive page rather than the sidebar).
    archived_at: datetime | None = None


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
    # DeepSeek-only. ``None`` defers to the provider's own default,
    # which is the right behaviour for every non-DeepSeek model.
    reasoning_effort: ReasoningEffort | None = None
    # Phase Z1 — opt into temporary lifecycle at creation time. ``None``
    # produces a normal permanent chat. The router computes ``expires_at``
    # itself; the client only picks the mode.
    temporary_mode: TemporaryMode | None = None
    # Phase P1 — when set, the new conversation is created under the
    # named :class:`Workspace`. The workspace's system prompt + pinned
    # files are included automatically on every send. Temporary chats
    # cannot belong to a workspace (the two lifecycles are in tension).
    workspace_id: uuid.UUID | None = None
    # Chat folders (0148) — create this chat inside a personal folder. The
    # folder's default model is applied when the payload omits a model, and
    # the folder's live system prompt then shapes every send. Ignored when
    # ``workspace_id`` is set (workspace chats aren't foldered).
    folder_id: uuid.UUID | None = None


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str | None = Field(default=None, max_length=255)
    pinned: bool | None = None
    starred: bool | None = None
    web_search_mode: WebSearchMode | None = None
    # ``None`` here means "leave unchanged" (consistent with every
    # other field on this PATCH). The frontend dropdown only writes
    # explicit values (``"off"`` / ``"low"`` / ``"medium"`` / ``"high"``);
    # the conversation row starts NULL for fresh chats and the chat
    # router treats NULL as "use the provider's API default".
    reasoning_effort: ReasoningEffort | None = None
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    # Phase P1 — move this chat into / out of a workspace. ``None`` in
    # the payload means "leave untouched" (consistent with every other
    # field here); to detach from a workspace, send ``""`` or use the
    # dedicated ``DELETE /workspaces/{wid}/conversations/{cid}``
    # endpoint. We accept strings here because JSON can't round-trip
    # ``None`` vs "unset" cleanly.
    workspace_id: uuid.UUID | None = None
    # Phase 1 — per-conversation custom instructions. ``None`` = leave
    # unchanged (field absent in the PATCH); an empty string clears it;
    # any other value sets it (the router trims it). Capped so a runaway
    # paste can't blow up the system prompt.
    system_prompt: str | None = Field(default=None, max_length=8000)
    # Chat folders (0148) — move this chat into / out of a personal folder.
    # ``None`` (field absent) leaves it unchanged; an explicit ``null`` in
    # the JSON removes it from its folder (back to top-level); a UUID moves
    # it into that folder. The router validates folder ownership and clears
    # it whenever the chat is moved into a workspace.
    folder_id: uuid.UUID | None = None
    # Phase 9 — pause/resume auto-capture for this conversation.
    memory_capture_paused: bool | None = None
    # Convert a temporary chat into a permanent one ("Keep this chat").
    # Only clearing is supported: send ``null`` to drop the temporary
    # lifecycle (the router also clears ``expires_at`` so the sweeper
    # leaves it alone). A non-null value is rejected — chats are only
    # made temporary at creation time, never promoted here. ``None``
    # (field absent) leaves the chat untouched.
    temporary_mode: TemporaryMode | None = None


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
    # Same override-then-persist semantics as ``web_search_mode``. The
    # chat router only forwards the underlying ``thinking`` +
    # ``reasoning_effort`` request fields to the upstream when the
    # active provider type is ``deepseek``; for every other provider
    # this stays out of the wire shape so it can't 400 the call.
    reasoning_effort: ReasoningEffort | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    # Default ``None`` = don't cap the reply; let the model write until it
    # naturally stops or hits the context window. The old 4096 default
    # silently truncated long answers mid-sentence (finish_reason
    # "length") because the UI never sends this field. Clients can still
    # pass an explicit cap when they want one.
    max_tokens: int | None = Field(default=None, ge=1, le=100_000)
    # IDs of files from /api/files the user picked via the paperclip modal.
    # Each must be readable by the caller (their own or shared-pool files).
    attachment_ids: list[uuid.UUID] = Field(default_factory=list)
    # Phase 9 — when True, large attachments are chunked + embedded into a
    # conversation-scoped RAG index instead of being inlined (and truncated)
    # into the prompt. Retrieval then injects only the relevant chunks.
    index_attachments: bool = False
    # Per-turn opt-in for AI tool calling (echo / attach_demo_file in
    # Phase A1; image gen / PDF authoring later). Off by default so an
    # ordinary chat doesn't pay the extra round-trip when no tool would
    # ever fire — and so the UI affordance for "this turn used tools" is
    # always meaningful.
    tools_enabled: bool = False
    # Voice mode (Phase 2): when true, this turn was spoken in the
    # hands-free voice overlay. The generator injects a "you're speaking
    # out loud" system prompt so the reply is short + conversational
    # (no markdown / lists / code that can't be heard) and applies a
    # modest token backstop. Off for every typed message.
    voice: bool = False


class SendMessageResponse(BaseModel):
    stream_id: uuid.UUID
    user_message: MessageResponse


class EnhancePromptRequest(BaseModel):
    """Phase 3.2 — rewrite a rough composer draft into a sharper prompt."""

    model_config = ConfigDict(protected_namespaces=())

    text: str = Field(min_length=1, max_length=8000)
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None


class EnhancePromptResponse(BaseModel):
    enhanced: str


class ArtifactEditRequest(BaseModel):
    """Phase 5 — apply a natural-language change to a code artifact and
    get the full updated source back (in-place editing)."""

    model_config = ConfigDict(protected_namespaces=())

    source: str = Field(min_length=1, max_length=60000)
    language: str = Field(default="plain", max_length=40)
    instruction: str = Field(min_length=1, max_length=2000)
    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None


class ArtifactEditResponse(BaseModel):
    updated: str


class BranchConversationRequest(BaseModel):
    """Body for ``POST /conversations/{id}/branch``.

    ``message_id`` is the *fork point*: every message up to and
    including this one is copied into the new conversation; nothing
    after it is. The new conversation is owned by the caller (so a
    collaborator forking a shared chat creates their own private
    branch by default), with the same model/provider defaults as
    the source so the next reply uses the familiar setup.

    ``ephemeral`` turns the branch into a **Subchat**: a throwaway
    side-conversation that inherits the thread's full context but is
    created ``temporary_mode="ephemeral"`` — hidden from the sidebar and
    swept after 24h unless the user explicitly keeps it (PATCH the chat
    with ``temporary_mode=null``). Drives the floating Subchat modal.
    """

    message_id: uuid.UUID
    ephemeral: bool = False


class ConversationSearchHit(BaseModel):
    """One match returned by ``GET /api/conversations/search``.

    ``snippet`` is a ``ts_headline``-rendered string with highlight
    markers (``[[HL]]…[[/HL]]``) around the matched terms; the
    frontend converts them to safe ``<mark>`` tags. ``conversation_id``
    and ``message_id`` let the click-through deep-link straight to
    the message anchor (``#msg-<uuid>``).

    ``access`` tells the UI whether this match came from a chat the
    caller owns or one that was shared to them — used to render the
    two sections of the command palette.
    """

    conversation_id: uuid.UUID
    message_id: uuid.UUID
    conversation_title: str | None
    role: MessageRole
    snippet: str
    rank: float
    created_at: datetime
    access: Literal["owner", "collaborator"] = "owner"
    # Phase 7 — how this hit was found: exact keyword (FTS), semantic
    # (embedding similarity), or both. Lets the palette badge a result
    # that surfaced only by meaning. Defaults to keyword for back-compat.
    match: Literal["keyword", "semantic", "hybrid"] = "keyword"


class CompactionResponse(BaseModel):
    """Result of ``POST /conversations/{id}/compact``.

    ``messages_removed`` is the count of original turns that were
    collapsed into the returned ``summary_message_id`` (a new
    ``role='system'`` row the frontend should fetch + render with a
    "Compacted summary" chip). The frontend typically refreshes the
    conversation detail query after a 200 rather than trying to
    diff the existing store state."""

    messages_removed: int
    summary_message_id: uuid.UUID


class MentionCandidate(BaseModel):
    """One row in the ``@``-mention autocomplete popover.

    Kept deliberately small — the autocomplete queries on every
    keystroke, so the wire payload is just the bits the UI needs
    to render a two-line row (title + faint workspace hint) and
    build the ``@[title](id)`` token on selection.
    """

    id: uuid.UUID
    title: str
    workspace_id: uuid.UUID | None = None
    workspace_title: str | None = None
    updated_at: datetime


class MentionFileCandidate(BaseModel):
    """A workspace file (note / upload / canvas text) for the ``@``
    popover. Notes are documents, canvases are represented by their
    backing text file — all ``UserFile`` rows, so they all reference
    through the existing ``file:`` mention mechanism."""

    id: uuid.UUID
    filename: str
    # 'note' | 'canvas' | 'file' — lets the popover show the right icon.
    kind: str = "file"


class MentionConnectorCandidate(BaseModel):
    """An MCP connector the caller can invoke via ``@[name](connector:id)``."""

    id: uuid.UUID
    name: str
    slug: str
    kind: str = "mcp"
    tool_count: int = 0


class MentionCandidatesResponse(BaseModel):
    """Response wrapper for ``GET /conversations/mention-candidates``.

    Split into lists so the UI can render the workspace's sibling chats
    as a highlighted "In this workspace" group above the generic
    recents, plus the workspace's files/notes/canvases when composing
    inside a workspace. ``workspace_context_id`` echoes the query param
    back so the frontend can verify it's scoping against the right
    workspace.
    """

    workspace_context_id: uuid.UUID | None = None
    workspace_candidates: list[MentionCandidate]
    recent_candidates: list[MentionCandidate]
    # Workspace files (notes/uploads/canvas texts). Populated only when a
    # ``workspace_id`` is supplied; empty otherwise.
    workspace_file_candidates: list[MentionFileCandidate] = Field(
        default_factory=list
    )
    # MCP connectors the caller can invoke. Reachable = global + their
    # grants + (when composing in a workspace) that workspace's restricted
    # connectors.
    connector_candidates: list[MentionConnectorCandidate] = Field(
        default_factory=list
    )


class SummariseToWorkspaceResponse(BaseModel):
    """Result of ``POST /conversations/{id}/summarise-to-workspace``.

    The endpoint writes the generated Markdown summary to a new
    :class:`app.files.models.UserFile` in the caller's Generated
    folder and auto-pins it to the conversation's parent workspace
    so every other chat in that workspace picks it up on the next
    turn (via the existing workspace-file injection path).

    We return enough context for the UI to show a success toast
    that links to the workspace ("Summary saved to *Workspace X*") or
    to open the file directly, without needing an extra round-trip.
    """

    file_id: uuid.UUID
    filename: str
    workspace_id: uuid.UUID
    workspace_title: str
    chars: int


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
    # Same override-then-persist pattern as ``web_search_mode``. Edited
    # turns may flip the reasoning effort on the retry independently of
    # how the original send was configured.
    reasoning_effort: ReasoningEffort | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    # Default ``None`` = don't cap the reply; let the model write until it
    # naturally stops or hits the context window. The old 4096 default
    # silently truncated long answers mid-sentence (finish_reason
    # "length") because the UI never sends this field. Clients can still
    # pass an explicit cap when they want one.
    max_tokens: int | None = Field(default=None, ge=1, le=100_000)
    # Mirror of SendMessageRequest: edited turns may toggle tool calling
    # on the retry independently of how the original send went.
    tools_enabled: bool = False


class PatchAssistantMessageRequest(BaseModel):
    """Body for ``PATCH /conversations/{cid}/messages/{mid}``.

    Cosmetic, in-place edit of an assistant reply. No re-stream, no
    truncation, no quota debit — the user is hand-correcting words
    the model already wrote (typos, remove "[I'll fill this in
    later]" placeholders, tighten prose). The endpoint accepts only
    a new ``content`` body; sources / attachments / token metrics
    stay untouched.
    """

    model_config = ConfigDict(protected_namespaces=())

    content: str = Field(min_length=1, max_length=200_000)


class MessageFeedbackRequest(BaseModel):
    """Body for ``PUT /conversations/{cid}/messages/{mid}/feedback``.

    Phase 2.5 — thumbs up / down on an assistant reply. ``rating`` of
    ``None`` clears any existing rating (toggling a thumb off).
    ``reason`` is an optional short note, typically captured on a
    thumbs-down; it's cleared whenever the rating is cleared.
    """

    rating: Literal["up", "down"] | None = None
    reason: str | None = Field(default=None, max_length=2000)


class RegenerateMessageRequest(BaseModel):
    """Regenerate-assistant-reply payload.

    Targets an assistant message and re-runs the model against the
    preceding user turn (which is left untouched — this is the big
    difference from :class:`EditMessageRequest`). All fields are
    optional; when omitted the conversation's existing defaults are
    used, so a one-click "try again" costs the caller nothing.

    Overriding ``model_id`` / ``provider_id`` is the primary reason
    to pass a body at all: it powers the "try a different model"
    affordance without needing a separate endpoint.
    """

    model_config = ConfigDict(protected_namespaces=())

    model_id: str | None = Field(default=None, max_length=255)
    provider_id: uuid.UUID | None = None
    web_search_mode: WebSearchMode | None = None
    # Same override-then-persist pattern as ``web_search_mode``.
    reasoning_effort: ReasoningEffort | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    # Default ``None`` = don't cap the reply; let the model write until it
    # naturally stops or hits the context window. The old 4096 default
    # silently truncated long answers mid-sentence (finish_reason
    # "length") because the UI never sends this field. Clients can still
    # pass an explicit cap when they want one.
    max_tokens: int | None = Field(default=None, ge=1, le=100_000)
    tools_enabled: bool = False


# --------------------------------------------------------------------
# Chat folders (0148)
# --------------------------------------------------------------------


class ChatFolderBase(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    name: str = Field(min_length=1, max_length=120)
    # Live default system prompt for chats in the folder. Empty = none.
    system_prompt: str | None = Field(default=None, max_length=8000)
    default_model_id: str | None = Field(default=None, max_length=255)
    default_provider_id: uuid.UUID | None = None


class ChatFolderCreate(ChatFolderBase):
    pass


class ChatFolderUpdate(BaseModel):
    """PATCH payload — every field optional; ``model_fields_set`` decides
    what to touch so a rename doesn't wipe the model default, and an explicit
    ``null`` clears the prompt / model."""

    model_config = ConfigDict(protected_namespaces=())

    name: str | None = Field(default=None, min_length=1, max_length=120)
    system_prompt: str | None = Field(default=None, max_length=8000)
    default_model_id: str | None = Field(default=None, max_length=255)
    default_provider_id: uuid.UUID | None = None


class ChatFolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    name: str
    system_prompt: str | None = None
    default_model_id: str | None = None
    default_provider_id: uuid.UUID | None = None
    # Number of active (non-archived) chats currently in the folder —
    # rendered as a count chip next to the folder name in the sidebar.
    chat_count: int = 0
    created_at: datetime
    updated_at: datetime
