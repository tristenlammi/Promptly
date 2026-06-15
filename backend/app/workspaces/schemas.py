"""Pydantic schemas for Workspaces.

Split from :mod:`app.chat.schemas` so the already-long chat schemas
module doesn't grow a second huge subject area. Imported by the
workspaces router; nothing else in the codebase should depend on
these directly.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------
# Pinned file — trimmed view of :class:`UserFile` so the clients don't
# need the full file record to render the Files tab in the workspace
# detail page.
# ---------------------------------------------------------------------


class WorkspaceFilePin(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int
    pinned_at: datetime
    # RAG indexing lifecycle for the Files tab chips. ``queued`` covers
    # both "not picked up yet" and "not a RAG candidate" (images /
    # binaries stay queued and are simply ignored by retrieval).
    indexing_status: str = "queued"
    indexing_error: str | None = None


# ---------------------------------------------------------------------
# Core workspace — mirrors the ORM row 1:1 plus a couple of derived
# rollups the list/detail pages need. Kept flat on purpose: the
# frontend cards and lists read directly off this shape without a
# second transform.
# ---------------------------------------------------------------------


class WorkspaceParticipant(BaseModel):
    """Minimal identity row for the workspace sharing UI.

    Mirrors :class:`app.chat.shares.ShareUserBrief` so the frontend
    can reuse a single ``UserChip`` component across chat and
    workspace share surfaces.
    """

    user_id: uuid.UUID
    username: str
    email: str


class WorkspaceSummary(BaseModel):
    """Lightweight row returned by the list endpoints.

    Holds everything the workspace card on ``/workspaces`` needs to render
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
    # ``owner`` when the caller created the workspace, ``collaborator``
    # when they have an accepted workspace share. Populated by the
    # router; the UI uses it to hide destructive actions (delete,
    # archive, manage-shares) from non-owners.
    role: str = "owner"
    # Non-null only for collaborators. Lets the card / list render
    # "shared by Jane" in place of the default timestamp hint so the
    # user can tell the two sources apart without clicking through.
    shared_by: WorkspaceParticipant | None = None


class WorkspaceDetail(WorkspaceSummary):
    """Full workspace record, returned by ``GET /workspaces/{id}``.

    Adds the heavy ``system_prompt`` and the pinned-files array so
    the workspace detail page can render all three tabs (Conversations,
    Files, Settings) from one request.
    """

    system_prompt: str | None = None
    files: list[WorkspaceFilePin] = Field(default_factory=list)
    # Owner + accepted collaborators on this workspace. Surfaced on
    # the detail payload so the header can show "Shared with Alex,
    # Sarah" and the share modal can seed its "People with access"
    # list without a second round-trip.
    owner: WorkspaceParticipant | None = None
    collaborators: list[WorkspaceParticipant] = Field(default_factory=list)
    # Per-turn context budget (Phase P2). ``per_turn_tokens`` is the
    # honest cost every chat in the workspace pays: instructions plus the
    # full pinned text in full-dump mode, or instructions plus a top-k
    # retrieval slice once ``retrieval_active`` flips on. ``indexing_count``
    # is how many pinned files are still being embedded.
    instruction_tokens: int = 0
    pinned_file_tokens: int = 0
    per_turn_tokens: int = 0
    retrieval_active: bool = False
    indexing_count: int = 0
    # Caller's fine-grained permission (Phase 4): ``owner`` /
    # ``editor`` / ``viewer``. The frontend hides edit affordances for
    # ``viewer``. ``role`` (above) stays coarse (owner/collaborator) for
    # the list cards.
    access_role: str = "owner"
    # Opt-in rolling workspace memory toggle (Phase 4).
    auto_memory_enabled: bool = False
    # True when the workspace has an embedding provider configured so
    # semantic retrieval can actually run. Shown in the Files tab so
    # users understand why pinned files stay in full-dump mode.
    embeddings_configured: bool = False


# ---------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    default_model_id: str | None = Field(default=None, max_length=255)
    default_provider_id: uuid.UUID | None = None


class WorkspaceUpdate(BaseModel):
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
    auto_memory_enabled: bool | None = None


class WorkspacePinFile(BaseModel):
    """Body for ``POST /workspaces/{wid}/files`` — pin a user file
    to the workspace so new conversations auto-attach it."""

    file_id: uuid.UUID


# ---------------------------------------------------------------------
# Per-chat pinned-file opt-out (Phase 4)
# ---------------------------------------------------------------------


class ConversationWorkspaceFile(BaseModel):
    """One of the workspace's pinned files, with whether *this* chat has
    excluded it from its context."""

    file_id: uuid.UUID
    filename: str
    mime_type: str
    excluded: bool


class ToggleWorkspaceFileRequest(BaseModel):
    excluded: bool


# ---------------------------------------------------------------------
# Usage rollup (Phase P3)
# ---------------------------------------------------------------------


class WorkspaceUsageModel(BaseModel):
    """Per-model slice of a workspace's spend."""

    model_config = ConfigDict(protected_namespaces=())

    model_id: str | None
    messages: int
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float


class WorkspaceUsage(BaseModel):
    """Aggregated token + cost usage across every conversation in a
    workspace. Sourced from message-level stats (``usage_daily`` is only
    keyed by user/day and can't be sliced by workspace)."""

    conversation_count: int
    message_count: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    by_model: list[WorkspaceUsageModel] = Field(default_factory=list)
