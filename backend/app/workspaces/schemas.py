"""Pydantic schemas for Workspaces.

Split from :mod:`app.chat.schemas` so the already-long chat schemas
module doesn't grow a second huge subject area. Imported by the
workspaces router; nothing else in the codebase should depend on
these directly.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

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
    # "Use as workspace context" — feeds the shared RAG pool when True.
    context_enabled: bool = True


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
    # Appearance for chips — mirrors ShareUserBrief.
    avatar_url: str | None = None
    avatar_color: str | None = None


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
    memory_model_id: str | None = None
    memory_provider_id: uuid.UUID | None = None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Rolled up by the list endpoint — cheap enough via ``COUNT(*)``
    # and saves the frontend a second round-trip on every card.
    conversation_count: int = 0
    file_count: int = 0
    # Live (non-archived) workspace items grouped by kind — "note",
    # "canvas", "board", "sheet", "container", "task", "folder". Lets the
    # card show what a workspace actually contains instead of just
    # chats + files. Chats aren't items (synthesised from conversations),
    # so ``conversation_count`` stays the chat signal.
    item_counts: dict[str, int] = Field(default_factory=dict)
    # Owner first, then accepted collaborators — usernames only, enough
    # for the card's initials-avatar strip without a per-card round-trip.
    member_names: list[str] = Field(default_factory=list)
    # The same people with avatar url/colour (7.5) so hub cards render
    # real profile pictures. Kept alongside ``member_names`` (not in
    # place of it) so stale cached payloads still render.
    members: list[WorkspaceParticipant] = Field(default_factory=list)
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
    # Opt-in rolling workspace memory toggle (Phase 4) — retained as a synced
    # mirror of ``memory_mode == "auto"`` for older clients.
    auto_memory_enabled: bool = False
    # Tri-state memory mode: "off" | "auto" | "manual" (the source of truth).
    memory_mode: str = "off"
    # True when the workspace has an embedding provider configured so
    # semantic retrieval can actually run. Shown in the Files tab so
    # users understand why pinned files stay in full-dump mode.
    embeddings_configured: bool = False
    # Drive folder id of the workspace's ``Files`` subfolder (owned by the
    # owner). The home-screen uploader drops files straight in here so the
    # owner's Drive stays tidy. Null if the tree isn't seeded; the frontend
    # falls back to the caller's Drive root (and only uses this when the
    # caller owns the workspace — collaborators can't write to it).
    files_folder_id: uuid.UUID | None = None


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
    # Optional starter template key (4.6): seeds notes / a labelled board /
    # a tuned system prompt. Unknown keys are ignored (blank workspace).
    template: str | None = Field(default=None, max_length=40)


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
    memory_mode: Literal["off", "auto", "manual"] | None = None
    # Dedicated model for the workspace-memory librarian (creator's pick).
    # NULL/cleared falls back to the workspace default chat model.
    memory_model_id: str | None = Field(default=None, max_length=255)
    memory_provider_id: uuid.UUID | None = None
    # Drive cap (owner-only, enforced by the router). Send null to clear.
    storage_quota_bytes: int | None = Field(default=None, ge=0)


# ---------------------------------------------------------------------
# Workspace Drive (Phases 6-7) — the workspace's own file browser.
# ---------------------------------------------------------------------


class WorkspaceDriveFolder(BaseModel):
    """A folder inside the workspace drive. ``parent_id`` is null for
    first-level folders (the drive root is implicit)."""

    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None


class WorkspaceDriveFile(WorkspaceFilePin):
    """A drive file = a pinned file + its placement. ``folder_id`` is null
    at the drive root; ``movable`` is false for legacy pins that live in a
    member's personal Drive (they list at root and can't be re-foldered)."""

    folder_id: uuid.UUID | None = None
    movable: bool = True


class WorkspaceDriveResponse(BaseModel):
    root_folder_id: uuid.UUID
    folders: list[WorkspaceDriveFolder]
    files: list[WorkspaceDriveFile]
    used_bytes: int
    quota_bytes: int | None


class WorkspaceDriveFolderCreate(BaseModel):
    name: str = Field(max_length=120)
    parent_id: uuid.UUID | None = None


class WorkspaceDriveFolderRename(BaseModel):
    name: str = Field(max_length=120)


class WorkspaceDriveMove(BaseModel):
    folder_id: uuid.UUID | None = None


class WorkspaceFileContext(BaseModel):
    """Body for ``PATCH /workspaces/{wid}/files/{file_id}/context`` —
    toggle whether a pinned file feeds the workspace RAG context."""

    enabled: bool


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


# ---------------------------------------------------------------------
# Navigator tree (Phase 1a) — the unified item tree that replaces the
# 4-tab console as the workspace's primary surface.
# ---------------------------------------------------------------------


class WorkspaceItemNode(BaseModel):
    """One node in the workspace navigator tree.

    Serves both stored ``workspace_items`` rows (``folder`` / ``note``)
    and chats synthesised at read time. For a synthesised ``chat`` node,
    ``id`` is the conversation id and there is no backing item row — the
    frontend opens it by ``ref_id`` (also the conversation id).
    """

    id: uuid.UUID
    # 'folder' | 'note' | 'canvas' | 'file' | 'chat'
    kind: str
    # -> files.id for a note, conversation id for a chat. NULL for folders.
    ref_id: uuid.UUID | None = None
    title: str
    icon: str | None = None
    position: float = 0.0
    # RAG index status for note/canvas/file kinds; NULL for folders/chats.
    indexing_status: str | None = None
    # "Use as workspace context" — note/canvas items feed the shared RAG
    # pool when True (default). True/ignored for folders + chats.
    context_enabled: bool = True
    # Surfaced in the rail's "Pinned" quick-access section when True.
    pinned: bool = False
    # "workspace" | "private" (0134). Other members never receive private
    # nodes at all — this field lets the *creator's* UI badge their drafts.
    visibility: str = "workspace"
    created_by: uuid.UUID | None = None
    children: list["WorkspaceItemNode"] = Field(default_factory=list)


class WorkspaceItemCreate(BaseModel):
    """Body for ``POST /workspaces/{wid}/items``.

    ``kind='folder'`` makes a tree-only organisation node. ``kind='note'``
    creates a blank Drive Document in the workspace's ``Notes`` folder;
    ``kind='canvas'`` creates an Excalidraw board (+ backing text file in
    ``Canvases``). ``kind='board'`` creates a Kanban board (tree-only; its
    tasks reference it). ``title`` is optional (kind-specific default)."""

    kind: Literal[
        "folder", "note", "canvas", "board", "sheet", "container", "chat"
    ]
    parent_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=255)


class WorkspaceItemUpdate(BaseModel):
    """PATCH payload for renaming / re-iconing a tree item. PATCH
    semantics: only keys present in the body are applied."""

    title: str | None = Field(default=None, max_length=255)
    icon: str | None = Field(default=None, max_length=64)
    # Toggle whether this note/canvas feeds the workspace RAG context.
    context_enabled: bool | None = None
    # Toggle the rail Pinned section membership.
    pinned: bool | None = None
    # Kind-specific JSON config (boards: the label registry / columns).
    config: dict[str, Any] | None = None
    # "workspace" | "private" — creator-only (0134).
    visibility: str | None = None


class WorkspaceItemMove(BaseModel):
    """Reparent + reorder a tree item. ``position`` is the new float
    slot among the target parent's children — the frontend computes a
    midpoint between neighbours so no renumber is needed."""

    parent_id: uuid.UUID | None = None
    position: float


class WorkspaceItemResponse(BaseModel):
    """Flat view of a single stored ``workspace_items`` row, returned by
    create / rename / move so the client can update one node without
    re-fetching the whole tree."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None
    kind: str
    ref_id: uuid.UUID | None
    title: str
    icon: str | None
    position: float
    indexing_status: str | None = None
    context_enabled: bool = True
    pinned: bool = False
    config: dict[str, Any] | None = None
    visibility: str = "workspace"
    created_by: uuid.UUID | None = None


class SpreadsheetResponse(BaseModel):
    """A spreadsheet page's persisted state. ``data`` is the Fortune-sheet
    workbook JSON (a list of sheet objects), NULL until the first save."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    data: Any | None


class SpreadsheetSaveRequest(BaseModel):
    """Debounced save from the spreadsheet editor. ``data`` is the full
    Fortune-sheet workbook; ``content_text`` is the client-flattened cell
    text used for workspace RAG."""

    data: Any
    content_text: str | None = None
    title: str | None = Field(default=None, max_length=255)


class WorkspaceMemoryResponse(BaseModel):
    """The workspace's auto-maintained memory doc, surfaced for viewing/editing."""

    exists: bool
    markdown: str
    updated_at: datetime | None = None
    auto_memory_enabled: bool
    memory_mode: str = "off"
    # Outcome of the most recent regeneration attempt (Phase 10) so the
    # overview card can flag a failed refresh instead of a stale timestamp.
    # ``last_status`` ∈ {ok, failed, skipped} or None (never attempted).
    last_status: str | None = None
    last_error: str | None = None
    last_attempt_at: datetime | None = None


class WorkspaceMemorySaveRequest(BaseModel):
    """A hand-edit of the workspace memory. Replaces the stored Markdown."""

    markdown: str = Field(max_length=40_000)


class WorkspaceMemoryAppendRequest(BaseModel):
    """A snippet to pin into the workspace memory ("save to memory")."""

    text: str = Field(min_length=1, max_length=8000)
