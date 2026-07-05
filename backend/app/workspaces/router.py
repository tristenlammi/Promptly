"""Workspaces API — CRUD, archive, pinned files, conversations listing.

Separate module from :mod:`app.chat.router` because:

* The chat router is already 2 k+ lines and growing; keeping workspaces
  isolated makes each area easier to reason about.
* Workspace endpoints don't touch streaming / SSE plumbing, so the
  import graph stays narrower than a single combined file would.

Mounted under ``/api/workspaces`` from ``app.main`` — see the
``include_router`` block there.

Surface area::

    GET    /workspaces                 list user's workspaces (active / archived)
    POST   /workspaces                 create a workspace
    GET    /workspaces/{wid}           full detail (incl. pinned files)
    PATCH  /workspaces/{wid}           rename / edit system prompt / change default model
    DELETE /workspaces/{wid}           permanently delete
    POST   /workspaces/{wid}/archive   move to archive
    POST   /workspaces/{wid}/unarchive bring back from archive
    GET    /workspaces/{wid}/conversations   list chats inside the workspace
    POST   /workspaces/{wid}/files     pin a file to the workspace
    DELETE /workspaces/{wid}/files/{fid}     unpin

Access control: every endpoint looks up the workspace via
:func:`_get_owned_workspace`, which 404s when the caller isn't the
owner. There is no sharing / collaborator story for workspaces
today — if/when we add it, the check becomes a helper mirroring
:func:`app.chat.shares.get_accessible_conversation`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Response,
    status,
)
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import (
    Conversation,
    Message,
    Workspace,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceTask,
)
from app.workspaces.schemas import (
    WorkspaceCreate,
    WorkspaceDetail,
    WorkspaceFileContext,
    WorkspaceFilePin,
    WorkspaceParticipant,
    WorkspacePinFile,
    WorkspaceSummary,
    WorkspaceUpdate,
    WorkspaceUsage,
    WorkspaceUsageModel,
)
from app.workspaces.shares import (
    get_accessible_workspace,
    is_owner_of_workspace,
    load_workspace_participants,
    require_workspace_write,
)
from app.chat.schemas import ConversationSummary
from app.workspaces.knowledge import (
    WORKSPACE_MEMORY_SOURCE_KIND,
    delete_workspace_file_chunks,
    index_file_for_workspace,
    reindex_workspace,
    workspace_context_stats,
)
from app.chat.shares import list_accessible_workspace_ids
from app.tasks.models import Task as AutomationTask
from app.custom_models.resolver import is_custom_model_id
from app.database import get_db
from app.files.models import FileFolder, UserFile
from app.files.system_folders import create_workspace_folder_tree
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.workspaces")

router = APIRouter()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


async def _get_owned_workspace(
    workspace_id: uuid.UUID, user: User, db: AsyncSession
) -> Workspace:
    """Return the workspace iff ``user`` owns it, else 404.

    Now a thin wrapper around :func:`is_owner_of_workspace` so the
    owner-vs-collaborator distinction lives in one place. Used by
    endpoints that should never be exposed to a collaborator
    (delete, archive / unarchive).
    """
    return await is_owner_of_workspace(workspace_id, user, db)


async def _validate_provider(
    provider_id: uuid.UUID | None, user: User, db: AsyncSession
) -> ModelProvider | None:
    """Reject ``default_provider_id`` pointing at a provider the user
    isn't allowed to use. Mirrors the ACL rules the send-message
    endpoint enforces, so a workspace can't be wired up with a
    provider the caller couldn't actually hit anyway.

    ``None`` is always fine (means "fall back to global selection")
    and returns without a DB hit. Returns the resolved provider row
    (or ``None`` when ``provider_id`` was ``None``) so callers that
    also need to inspect ``enabled_models`` don't re-fetch it."""
    if provider_id is None:
        return None
    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    return provider


async def _validate_default_model(
    provider_id: uuid.UUID | None,
    model_id: str | None,
    user: User,
    db: AsyncSession,
) -> None:
    """Reject a default model the caller couldn't actually use.

    Rules mirror the create-conversation fallback in
    :mod:`app.chat.router`:

    * ``provider_id`` and ``model_id`` are set together or cleared
      together — a half-set default silently falls back at send time,
      which is confusing to debug.
    * The provider must exist and be usable by the caller
      (delegated to :func:`_validate_provider`).
    * For a real (non-custom) model the id must be one of the
      provider's ``enabled_models``. Custom models carry a synthetic
      ``custom:<uuid>`` id the chat resolver expands at send time, so
      the membership check is skipped for them (the provider check
      still applies)."""
    if model_id is None and provider_id is None:
        return
    if (model_id is None) != (provider_id is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Set a default model and provider together, or clear both.",
        )
    provider = await _validate_provider(provider_id, user, db)
    if is_custom_model_id(model_id):
        return
    enabled = (provider.enabled_models if provider else None) or []
    if model_id not in enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That model isn't enabled for the selected provider.",
        )


async def _summary_with_rollups(
    ws: Workspace,
    db: AsyncSession,
    caller: User,
) -> WorkspaceSummary:
    """Hydrate a :class:`WorkspaceSummary` with the conversation +
    file counts the list/card UI needs.

    Also populates ``role`` / ``shared_by`` so collaborator-visible
    cards can render "shared by Jane" instead of the owner's
    timestamp line. Two cheap ``SELECT COUNT(*)`` queries are
    cheaper than joining and grouping for every list response; the
    N-workspaces * 2-counts pattern is fine for the dozens of
    workspaces a power user will accumulate.
    """
    conv_count = await db.scalar(
        select(func.count())
        .select_from(Conversation)
        .where(Conversation.workspace_id == ws.id)
    )
    # Mirror the Drive pane's filter: the auto-maintained Workspace
    # Memory doc is pinned for retrieval but hidden from the file list,
    # so it mustn't inflate the card's "N files" either (hub said
    # "2 files" while Drive showed 1).
    file_count = await db.scalar(
        select(func.count())
        .select_from(WorkspaceFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(
            WorkspaceFile.workspace_id == ws.id,
            or_(
                UserFile.source_kind.is_(None),
                UserFile.source_kind != WORKSPACE_MEMORY_SOURCE_KIND,
            ),
        )
    )
    # Per-kind item counts (notes / boards / sheets / …) so the card can
    # say what a workspace actually contains. One GROUP BY per workspace.
    # Automations aren't item rows (they're synthesised into the tree from
    # the tasks table, like chats from conversations) — count them directly.
    kind_rows = await db.execute(
        select(WorkspaceItem.kind, func.count())
        .where(
            WorkspaceItem.workspace_id == ws.id,
            WorkspaceItem.archived_at.is_(None),
        )
        .group_by(WorkspaceItem.kind)
    )
    # Caller-scoped, matching the navigator tree (which synthesises only the
    # caller's own automations) — counting other users' homed tasks made the
    # card claim "3 automations" while the tree showed one.
    task_count = await db.scalar(
        select(func.count())
        .select_from(AutomationTask)
        .where(
            AutomationTask.workspace_id == ws.id,
            AutomationTask.user_id == caller.id,
        )
    )
    base = WorkspaceSummary.model_validate(ws)
    base.conversation_count = int(conv_count or 0)
    base.file_count = int(file_count or 0)
    base.item_counts = {str(k): int(c) for k, c in kind_rows}
    if task_count:
        base.item_counts["task"] = int(task_count)

    participants = await load_workspace_participants(ws, db)
    base.member_names = [participants.owner.username] + [
        c.username for c in participants.collaborators
    ]

    if ws.user_id == caller.id:
        base.role = "owner"
        base.shared_by = None
    else:
        base.role = "collaborator"
        owner = await db.get(User, ws.user_id)
        if owner is not None:
            base.shared_by = WorkspaceParticipant(
                user_id=owner.id,
                username=owner.username,
                email=owner.email,
                avatar_url=owner.avatar_url,
                avatar_color=owner.avatar_color,
            )
    return base


# ---------------------------------------------------------------------
# Listings + creation
# ---------------------------------------------------------------------


@router.get("", response_model=list[WorkspaceSummary])
async def list_workspaces(
    archived: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceSummary]:
    """List workspaces the caller owns *or* has an accepted share on.

    ``archived=false`` (default) → only active workspaces
    (``archived_at IS NULL``). Collaborator-visible workspaces always
    show in the active list — invitees don't get the archive UX
    since they can't archive/unarchive.

    Owned and shared workspaces arrive in the same payload but each
    row carries a ``role`` discriminator so the card UI can badge
    shared ones.
    """
    accessible_ids = await list_accessible_workspace_ids(user, db)
    if not accessible_ids:
        return []
    q = select(Workspace).where(Workspace.id.in_(accessible_ids))
    if archived:
        # Archive is owner-facing only — collaborators don't get
        # surfaced archived workspaces (the owner may have hidden it
        # for a reason; surfacing it to shared users would be
        # surprising).
        q = (
            q.where(Workspace.user_id == user.id)
            .where(Workspace.archived_at.is_not(None))
            .order_by(Workspace.archived_at.desc())
        )
    else:
        q = q.where(Workspace.archived_at.is_(None)).order_by(
            Workspace.updated_at.desc()
        )
    res = await db.execute(q)
    rows = list(res.scalars().all())
    return [await _summary_with_rollups(w, db, user) for w in rows]


class MyWorkCard(BaseModel):
    """One open card assigned to the caller, with enough context to
    render outside its board (workspace + board titles, deep link)."""

    id: uuid.UUID
    title: str
    status: str
    priority: str
    due_at: datetime | None = None
    created_at: datetime
    workspace_id: uuid.UUID
    workspace_title: str
    board_item_id: uuid.UUID | None = None
    board_title: str | None = None


class MyWorkResponse(BaseModel):
    cards: list[MyWorkCard]


# NOTE: registered before the /{workspace_id} routes — FastAPI matches in
# declaration order and "my-work" must not be parsed as a workspace UUID.
@router.get("/my-work", response_model=MyWorkResponse)
async def my_work(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MyWorkResponse:
    """Every open card assigned to the caller across their workspaces.

    The cross-workspace "what's on my plate" view: open (non-done)
    cards in active workspaces the caller can still access, due-date
    first (nulls last). Mentions and invites come from the inbox and
    invites endpoints — this only owns the cards."""
    accessible_ids = await list_accessible_workspace_ids(user, db)
    if not accessible_ids:
        return MyWorkResponse(cards=[])
    board = aliased(WorkspaceItem)
    rows = (
        await db.execute(
            select(WorkspaceTask, Workspace.title, board.title)
            .join(Workspace, Workspace.id == WorkspaceTask.workspace_id)
            .outerjoin(board, board.id == WorkspaceTask.board_item_id)
            .where(
                WorkspaceTask.assignee_user_id == user.id,
                WorkspaceTask.status != "done",
                WorkspaceTask.workspace_id.in_(accessible_ids),
                Workspace.archived_at.is_(None),
            )
            .order_by(
                WorkspaceTask.due_at.asc().nulls_last(),
                WorkspaceTask.created_at.desc(),
            )
            .limit(200)
        )
    ).all()
    return MyWorkResponse(
        cards=[
            MyWorkCard(
                id=t.id,
                title=t.title,
                status=t.status,
                priority=t.priority,
                due_at=t.due_at,
                created_at=t.created_at,
                workspace_id=t.workspace_id,
                workspace_title=ws_title,
                board_item_id=t.board_item_id,
                board_title=board_title,
            )
            for t, ws_title, board_title in rows
        ]
    )


@router.post(
    "", response_model=WorkspaceSummary, status_code=status.HTTP_201_CREATED
)
async def create_workspace(
    payload: WorkspaceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    await _validate_default_model(
        payload.default_provider_id, payload.default_model_id, user, db
    )
    ws = Workspace(
        user_id=user.id,
        title=payload.title.strip(),
        description=payload.description,
        system_prompt=payload.system_prompt,
        default_model_id=payload.default_model_id,
        default_provider_id=payload.default_provider_id,
    )
    db.add(ws)
    # Flush to mint the workspace id before seeding its Drive folder tree.
    await db.flush()
    # Seed ``My files / Workspaces / <title> / {Notes,Canvases,Files}`` and
    # point the workspace at its per-workspace folder. Notes / canvases /
    # uploads created in the workspace physically land under here so they
    # inherit Drive's preview / search / trash / quota plumbing.
    ws_folder = await create_workspace_folder_tree(db, user, ws.title)
    ws.root_folder_id = ws_folder.id
    # Starter template (4.6): seed notes / board / system prompt inside the
    # same transaction. A template bug must never lose the workspace, so
    # failures degrade to a blank workspace with a logged warning.
    if payload.template:
        try:
            from app.workspaces.templates import apply_template

            await apply_template(
                db, ws=ws, user=user, template_key=payload.template
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "template %r failed; created blank workspace",
                payload.template,
                exc_info=True,
            )
    await db.commit()
    await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


# ---------------------------------------------------------------------
# Detail + mutation
# ---------------------------------------------------------------------


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDetail:
    # Owner *or* accepted collaborator — workspace sharing grants
    # read access to the workspace detail page and its files; the role
    # tells the frontend whether to expose edit affordances.
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    # Build the detail payload. Pinned files need a join against
    # ``user_files`` to pull the display metadata the frontend shows
    # on the Files tab.
    files_q = await db.execute(
        select(WorkspaceFile, UserFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(WorkspaceFile.workspace_id == ws.id)
        .order_by(WorkspaceFile.pinned_at.asc())
    )
    pins = [
        WorkspaceFilePin(
            file_id=uf.id,
            filename=uf.filename,
            mime_type=uf.mime_type,
            size_bytes=uf.size_bytes,
            pinned_at=pin.pinned_at,
            indexing_status=pin.indexing_status,
            indexing_error=pin.indexing_error,
            context_enabled=pin.context_enabled,
        )
        for pin, uf in files_q.all()
        # The auto-maintained Workspace Memory.md stays pinned (that's how it
        # reaches chat context) but is hidden from the user-managed Pinned
        # files list — it has its own editor in Settings → Workspace memory,
        # and shouldn't be separately editable, unpinnable, or deletable here.
        if uf.source_kind != WORKSPACE_MEMORY_SOURCE_KIND
    ]
    summary = await _summary_with_rollups(ws, db, user)
    stats = await workspace_context_stats(
        db, workspace_id=ws.id, system_prompt=ws.system_prompt
    )
    participants = await load_workspace_participants(ws, db)
    # The workspace's ``Files`` Drive subfolder (owned by the owner). Read-only
    # lookup — never creates here, so a GET stays side-effect free; it's seeded
    # at workspace creation. The owner uploads workspace files straight into it
    # so their Drive stays tidy; collaborators can't write to the owner's
    # folder, so the frontend only uses this when the caller is the owner.
    files_folder_id: uuid.UUID | None = None
    if ws.root_folder_id is not None:
        files_folder_id = await db.scalar(
            select(FileFolder.id).where(
                FileFolder.user_id == ws.user_id,
                FileFolder.parent_id == ws.root_folder_id,
                FileFolder.name == "Files",
            )
        )
    # ``WorkspaceDetail`` extends ``WorkspaceSummary`` — merge the
    # two payloads into one validated object so the HTTP shape stays
    # flat (no nested "summary" object the frontend has to unwrap).
    return WorkspaceDetail(
        **summary.model_dump(),
        system_prompt=ws.system_prompt,
        files=pins,
        owner=WorkspaceParticipant(
            user_id=participants.owner.user_id,
            username=participants.owner.username,
            email=participants.owner.email,
            avatar_url=participants.owner.avatar_url,
            avatar_color=participants.owner.avatar_color,
        ),
        collaborators=[
            WorkspaceParticipant(
                user_id=c.user_id,
                username=c.username,
                email=c.email,
                avatar_url=c.avatar_url,
                avatar_color=c.avatar_color,
            )
            for c in participants.collaborators
        ],
        instruction_tokens=stats.instruction_tokens,
        pinned_file_tokens=stats.pinned_file_tokens,
        per_turn_tokens=stats.per_turn_tokens,
        retrieval_active=stats.retrieval_active,
        indexing_count=stats.indexing_count,
        access_role=access_role,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
        embeddings_configured=stats.embeddings_configured,
        files_folder_id=files_folder_id,
    )


@router.patch("/{workspace_id}", response_model=WorkspaceSummary)
async def update_workspace(
    workspace_id: uuid.UUID,
    payload: WorkspaceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    # Editors + owner can edit workspace settings; viewers are read-only.
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    # ``model_fields_set`` tells us which keys were actually sent by
    # the client — lets us differentiate "leave alone" (absent) from
    # "set to null" (explicit clear). Matches the PATCH semantics
    # used across the rest of the API.
    sent = payload.model_fields_set
    if "title" in sent:
        if not payload.title or not payload.title.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Title cannot be empty",
            )
        ws.title = payload.title.strip()
    if "description" in sent:
        ws.description = payload.description
    if "system_prompt" in sent:
        ws.system_prompt = payload.system_prompt
    # Default model + provider are validated as a *pair* against the
    # resulting state — sending one without the other (or a model the
    # provider doesn't enable) is rejected so the chat header and the
    # send-time fallback can't disagree.
    if "default_model_id" in sent or "default_provider_id" in sent:
        new_model = (
            payload.default_model_id
            if "default_model_id" in sent
            else ws.default_model_id
        )
        new_provider = (
            payload.default_provider_id
            if "default_provider_id" in sent
            else ws.default_provider_id
        )
        await _validate_default_model(new_provider, new_model, user, db)
        ws.default_model_id = new_model
        ws.default_provider_id = new_provider
    # ``memory_mode`` is the source of truth; keep the legacy boolean synced.
    if "memory_mode" in sent and payload.memory_mode is not None:
        ws.memory_mode = payload.memory_mode
        ws.auto_memory_enabled = payload.memory_mode == "auto"
    elif "auto_memory_enabled" in sent and payload.auto_memory_enabled is not None:
        ws.auto_memory_enabled = payload.auto_memory_enabled
        ws.memory_mode = "auto" if payload.auto_memory_enabled else "off"
    # Dedicated memory model — validated as a pair only when actually set;
    # clearing both falls back to the workspace default chat model.
    if "memory_model_id" in sent or "memory_provider_id" in sent:
        new_mem_model = (
            payload.memory_model_id
            if "memory_model_id" in sent
            else ws.memory_model_id
        )
        new_mem_provider = (
            payload.memory_provider_id
            if "memory_provider_id" in sent
            else ws.memory_provider_id
        )
        if new_mem_model and new_mem_provider:
            await _validate_default_model(
                new_mem_provider, new_mem_model, user, db
            )
        ws.memory_model_id = new_mem_model
        ws.memory_provider_id = new_mem_provider
    # Drive storage cap — owner-only (collaborators can edit content, but
    # capping the drive is a lifecycle decision like delete/share).
    if "storage_quota_bytes" in sent:
        if ws.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the workspace owner can change the storage cap.",
            )
        ws.storage_quota_bytes = payload.storage_quota_bytes
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete a workspace. Conversations inside the workspace
    are *preserved* (the FK is ``ON DELETE SET NULL``) and bubble
    back up to the top-level list — we never silently destroy chat
    history."""
    ws = await _get_owned_workspace(workspace_id, user, db)
    await db.delete(ws)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Archive / unarchive
# ---------------------------------------------------------------------


@router.post("/{workspace_id}/archive", response_model=WorkspaceSummary)
async def archive_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    ws = await _get_owned_workspace(workspace_id, user, db)
    if ws.archived_at is None:
        ws.archived_at = datetime.now(timezone.utc)
        ws.updated_at = ws.archived_at
        await db.commit()
        await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


@router.post("/{workspace_id}/unarchive", response_model=WorkspaceSummary)
async def unarchive_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    ws = await _get_owned_workspace(workspace_id, user, db)
    if ws.archived_at is not None:
        ws.archived_at = None
        ws.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


# ---------------------------------------------------------------------
# Conversations inside a workspace
# ---------------------------------------------------------------------


@router.get(
    "/{workspace_id}/conversations",
    response_model=list[ConversationSummary],
)
async def list_workspace_conversations(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSummary]:
    """Return every conversation under ``workspace_id`` (most recent
    first).

    Workspace sharing is workspace-level: once the caller has access
    to the workspace (owner or accepted collaborator), they see
    **every** chat in it — the inviter's originals as well as
    anything other collaborators have added since. Individual
    conversation shares still work on top of this and remain
    invisible here; they're surfaced through the main sidebar.
    """
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    q = (
        select(Conversation)
        .where(Conversation.workspace_id == ws.id)
        .order_by(Conversation.updated_at.desc())
    )
    res = await db.execute(q)
    return [
        ConversationSummary.model_validate(c) for c in res.scalars().all()
    ]


@router.delete(
    "/{workspace_id}/conversations",
    response_model=dict,
    status_code=status.HTTP_200_OK,
)
async def remove_all_conversations_from_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Bulk-detach every conversation from this workspace.

    Sets ``workspace_id = NULL`` on every conversation currently under the
    workspace. Conversations are *preserved* — they move back to the
    top-level chat list. Useful when you want to dissolve an archived
    workspace without losing history.

    Owner-only: collaborators don't have permission to reorganise the
    workspace's conversation list in bulk.
    """
    ws = await _get_owned_workspace(workspace_id, user, db)
    result = await db.execute(
        select(Conversation).where(Conversation.workspace_id == ws.id)
    )
    convs = result.scalars().all()
    removed = 0
    for conv in convs:
        conv.workspace_id = None
        removed += 1
    if removed:
        ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"removed": removed}


# ---------------------------------------------------------------------
# Usage rollup
# ---------------------------------------------------------------------


@router.get("/{workspace_id}/usage", response_model=WorkspaceUsage)
async def workspace_usage(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceUsage:
    """Token + cost usage aggregated over every conversation in the
    workspace. Built from message-level stats because ``usage_daily`` is
    keyed by ``(user_id, day)`` and can't be sliced by workspace.

    Scoped to the workspace's conversations (all collaborators' chats),
    gated by :func:`get_accessible_workspace`."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    conv_count = int(
        await db.scalar(
            select(func.count())
            .select_from(Conversation)
            .where(Conversation.workspace_id == ws.id)
        )
        or 0
    )

    # One grouped pass over the workspace's messages, attributed to each
    # conversation's model (``messages`` rows don't carry a model — the
    # model lives on the conversation). This attributes a chat's whole
    # spend to its *current* model, which is the only model key we
    # retain; good enough for a per-workspace rollup. ``model_id`` is NULL
    # for conversations that never had one persisted.
    rows = (
        await db.execute(
            select(
                Conversation.model_id.label("model_id"),
                func.count(Message.id).label("messages"),
                func.coalesce(func.sum(Message.prompt_tokens), 0).label("pt"),
                func.coalesce(func.sum(Message.completion_tokens), 0).label("ct"),
                func.coalesce(func.sum(Message.cost_usd_micros), 0).label("cost"),
            )
            .join(Message, Message.conversation_id == Conversation.id)
            .where(Conversation.workspace_id == ws.id)
            .group_by(Conversation.model_id)
        )
    ).all()

    message_count = sum(int(r.messages) for r in rows)
    prompt_tokens = sum(int(r.pt) for r in rows)
    completion_tokens = sum(int(r.ct) for r in rows)
    cost_micros = sum(int(r.cost) for r in rows)

    by_model = [
        WorkspaceUsageModel(
            model_id=r.model_id,
            messages=int(r.messages),
            prompt_tokens=int(r.pt),
            completion_tokens=int(r.ct),
            cost_usd=round(int(r.cost) / 1_000_000, 6),
        )
        for r in rows
        if r.model_id is not None
        and (int(r.pt) or int(r.ct) or int(r.cost))
    ]
    by_model.sort(
        key=lambda m: m.prompt_tokens + m.completion_tokens, reverse=True
    )

    return WorkspaceUsage(
        conversation_count=conv_count,
        message_count=message_count,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        cost_usd=round(cost_micros / 1_000_000, 6),
        by_model=by_model,
    )


# ---------------------------------------------------------------------
# Reindex pinned files (backfill)
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/reindex",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=dict,
)
async def reindex_workspace_files(
    workspace_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Queue a background re-index of every pinned file in the workspace.

    Useful after enabling an embedding provider for the first time, or
    to backfill files pinned before Phase-2 that are still ``queued``.
    Owner-only: collaborators don't manage the workspace's embedding state.
    Returns immediately; the Files tab's polling will show progress.
    """
    ws = await _get_owned_workspace(workspace_id, user, db)
    background.add_task(reindex_workspace, ws.id)
    return {"queued": True}


# ---------------------------------------------------------------------
# Pinned files
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/files",
    response_model=WorkspaceFilePin,
    status_code=status.HTTP_201_CREATED,
)
async def pin_file(
    workspace_id: uuid.UUID,
    payload: WorkspacePinFile,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceFilePin:
    """Pin an existing :class:`UserFile` to the workspace.

    File must be owned by the caller (``user_files.user_id`` match).
    Admin-managed shared-pool files (``user_id IS NULL``) are *not*
    pinnable to a personal workspace today — the UX would be confusing
    (admins can already surface those via system folders).

    Collaborators on a shared workspace can pin their *own* files;
    the workspace owner (and other collaborators) will then see them
    in the workspace's file list the same way they see the owner's
    originals.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    uf = await db.get(UserFile, payload.file_id)
    if uf is None or uf.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )

    # Idempotent: re-pinning is a no-op, returns the existing row's
    # data so the client doesn't have to case on "already pinned".
    existing_q = await db.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.workspace_id == ws.id,
            WorkspaceFile.file_id == uf.id,
        )
    )
    existing = existing_q.scalar_one_or_none()
    if existing is None:
        # Workspace drive cap applies to pins of existing files too —
        # otherwise pinning a large personal file would bypass it.
        if ws.storage_quota_bytes is not None:
            used = await db.scalar(
                select(func.coalesce(func.sum(UserFile.size_bytes), 0))
                .select_from(WorkspaceFile)
                .join(UserFile, UserFile.id == WorkspaceFile.file_id)
                .where(WorkspaceFile.workspace_id == ws.id)
            )
            if int(used or 0) + uf.size_bytes > ws.storage_quota_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=(
                        "Adding this file would exceed the workspace's "
                        "storage cap. Remove some files or raise the cap "
                        "in Settings."
                    ),
                )
        pin = WorkspaceFile(
            workspace_id=ws.id, file_id=uf.id, pinned_by=user.id
        )
        db.add(pin)
        ws.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(pin)
        # Kick off RAG indexing after the response is sent. The task
        # owns its own session and no-ops for images / when embeddings
        # aren't configured, so this is safe to fire unconditionally on
        # a fresh pin.
        background.add_task(index_file_for_workspace, ws.id, uf.id)
    else:
        pin = existing

    return WorkspaceFilePin(
        file_id=uf.id,
        filename=uf.filename,
        mime_type=uf.mime_type,
        size_bytes=uf.size_bytes,
        pinned_at=pin.pinned_at,
        indexing_status=pin.indexing_status,
        indexing_error=pin.indexing_error,
        context_enabled=pin.context_enabled,
    )


@router.patch(
    "/{workspace_id}/files/{file_id}/context",
    response_model=WorkspaceFilePin,
)
async def set_file_context(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: WorkspaceFileContext,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceFilePin:
    """Toggle whether a pinned file feeds the workspace RAG context.

    Off keeps the file attached to the workspace (and its embeddings) but
    drops it from every chat's context until turned back on.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    pin = await db.get(WorkspaceFile, (ws.id, file_id))
    if pin is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not pinned"
        )
    pin.context_enabled = payload.enabled
    await db.commit()
    await db.refresh(pin)
    uf = await db.get(UserFile, file_id)
    return WorkspaceFilePin(
        file_id=file_id,
        filename=uf.filename if uf else "",
        mime_type=uf.mime_type if uf else "",
        size_bytes=uf.size_bytes if uf else 0,
        pinned_at=pin.pinned_at,
        indexing_status=pin.indexing_status,
        indexing_error=pin.indexing_error,
        context_enabled=pin.context_enabled,
    )


@router.delete(
    "/{workspace_id}/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unpin_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    pin = await db.get(WorkspaceFile, (ws.id, file_id))
    if pin is None:
        # Idempotent: already unpinned.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    # Unpin guard: the owner can remove any file; a collaborator can
    # only remove files they pinned themselves (``pinned_by`` is NULL on
    # pre-0071 rows → owner-only). Stops one editor yanking another's
    # reference material out from under them.
    if access_role != "owner" and pin.pinned_by != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the workspace owner or the person who pinned this file can remove it.",
        )
    await db.delete(pin)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    # Drop the file's workspace-scoped chunks so they stop surfacing in
    # retrieval. Best-effort, after the response.
    background.add_task(delete_workspace_file_chunks, ws.id, file_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Move a conversation in / out of a workspace
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def move_conversation_into_workspace(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Move an existing chat into the workspace.

    Caller must own the conversation (no moving someone else's
    chats into your workspace) and have access to the target
    workspace (owner or accepted collaborator). Temporary chats are
    rejected: tying a short-lived chat to a workspace complicates the
    cleanup sweep for negligible benefit."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.temporary_mode is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Temporary chats can't belong to a workspace.",
        )
    conv.workspace_id = ws.id
    conv.updated_at = datetime.now(timezone.utc)
    ws.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


@router.delete(
    "/{workspace_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def remove_conversation_from_workspace(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Detach a chat from its workspace without deleting the chat
    itself — it resurfaces at the top level of the sidebar."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.workspace_id != ws.id:
        # Idempotent: already out, return the current state so the UI
        # doesn't need a special-case error path.
        return ConversationSummary.model_validate(conv)
    conv.workspace_id = None
    conv.updated_at = datetime.now(timezone.utc)
    ws.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)
