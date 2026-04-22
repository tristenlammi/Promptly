"""Chat Projects API — CRUD, archive, pinned files, conversations listing.

Separate module from :mod:`app.chat.router` because:

* The chat router is already 2 k+ lines and growing; keeping projects
  isolated makes each area easier to reason about.
* Project endpoints don't touch streaming / SSE plumbing, so the
  import graph stays narrower than a single combined file would.

Mounted under ``/api/chat/projects`` from ``app.main`` — see the
``include_router`` block there.

Surface area::

    GET    /chat/projects                 list user's projects (active / archived)
    POST   /chat/projects                 create a project
    GET    /chat/projects/{pid}           full detail (incl. pinned files)
    PATCH  /chat/projects/{pid}           rename / edit system prompt / change default model
    DELETE /chat/projects/{pid}           permanently delete
    POST   /chat/projects/{pid}/archive   move to archive
    POST   /chat/projects/{pid}/unarchive bring back from archive
    GET    /chat/projects/{pid}/conversations   list chats inside the project
    POST   /chat/projects/{pid}/files     pin a file to the project
    DELETE /chat/projects/{pid}/files/{fid}     unpin

Access control: every endpoint looks up the project via
:func:`_get_owned_project`, which 404s when the caller isn't the
owner. There is no sharing / collaborator story for chat projects
today — if/when we add it, the check becomes a helper mirroring
:func:`app.chat.shares.get_accessible_conversation`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import (
    ChatProject,
    ChatProjectFile,
    Conversation,
)
from app.chat.project_schemas import (
    ChatProjectCreate,
    ChatProjectDetail,
    ChatProjectFilePin,
    ChatProjectParticipant,
    ChatProjectPinFile,
    ChatProjectSummary,
    ChatProjectUpdate,
)
from app.chat.project_shares import (
    get_accessible_project,
    is_owner_of_project,
    load_project_participants,
)
from app.chat.schemas import ConversationSummary
from app.chat.shares import list_accessible_project_ids
from app.database import get_db
from app.files.models import UserFile
from app.models_config.models import ModelProvider

router = APIRouter()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


async def _get_owned_project(
    project_id: uuid.UUID, user: User, db: AsyncSession
) -> ChatProject:
    """Return the project iff ``user`` owns it, else 404.

    Now a thin wrapper around :func:`is_owner_of_project` so the
    owner-vs-collaborator distinction lives in one place. Used by
    endpoints that should never be exposed to a collaborator
    (delete, archive / unarchive).
    """
    return await is_owner_of_project(project_id, user, db)


async def _validate_provider(
    provider_id: uuid.UUID | None, user: User, db: AsyncSession
) -> None:
    """Reject ``default_provider_id`` pointing at a provider the user
    isn't allowed to use. Mirrors the ACL rules the send-message
    endpoint enforces, so a project can't be wired up with a
    provider the caller couldn't actually hit anyway.

    ``None`` is always fine (means "fall back to global selection")
    and returns without a DB hit."""
    if provider_id is None:
        return
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


async def _summary_with_rollups(
    proj: ChatProject,
    db: AsyncSession,
    caller: User,
) -> ChatProjectSummary:
    """Hydrate a :class:`ChatProjectSummary` with the conversation +
    file counts the list/card UI needs.

    Also populates ``role`` / ``shared_by`` so collaborator-visible
    cards can render "shared by Jane" instead of the owner's
    timestamp line. Two cheap ``SELECT COUNT(*)`` queries are
    cheaper than joining and grouping for every list response; the
    N-projects * 2-counts pattern is fine for the dozens of
    projects a power user will accumulate.
    """
    conv_count = await db.scalar(
        select(func.count())
        .select_from(Conversation)
        .where(Conversation.project_id == proj.id)
    )
    file_count = await db.scalar(
        select(func.count())
        .select_from(ChatProjectFile)
        .where(ChatProjectFile.project_id == proj.id)
    )
    base = ChatProjectSummary.model_validate(proj)
    base.conversation_count = int(conv_count or 0)
    base.file_count = int(file_count or 0)

    if proj.user_id == caller.id:
        base.role = "owner"
        base.shared_by = None
    else:
        base.role = "collaborator"
        owner = await db.get(User, proj.user_id)
        if owner is not None:
            base.shared_by = ChatProjectParticipant(
                user_id=owner.id,
                username=owner.username,
                email=owner.email,
            )
    return base


# ---------------------------------------------------------------------
# Listings + creation
# ---------------------------------------------------------------------


@router.get("", response_model=list[ChatProjectSummary])
async def list_projects(
    archived: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ChatProjectSummary]:
    """List projects the caller owns *or* has an accepted share on.

    ``archived=false`` (default) → only active projects
    (``archived_at IS NULL``). Collaborator-visible projects always
    show in the active list — invitees don't get the archive UX
    since they can't archive/unarchive.

    Owned and shared projects arrive in the same payload but each
    row carries a ``role`` discriminator so the card UI can badge
    shared ones.
    """
    accessible_ids = await list_accessible_project_ids(user, db)
    if not accessible_ids:
        return []
    q = select(ChatProject).where(ChatProject.id.in_(accessible_ids))
    if archived:
        # Archive is owner-facing only — collaborators don't get
        # surfaced archived projects (the owner may have hidden it
        # for a reason; surfacing it to shared users would be
        # surprising).
        q = (
            q.where(ChatProject.user_id == user.id)
            .where(ChatProject.archived_at.is_not(None))
            .order_by(ChatProject.archived_at.desc())
        )
    else:
        q = q.where(ChatProject.archived_at.is_(None)).order_by(
            ChatProject.updated_at.desc()
        )
    res = await db.execute(q)
    rows = list(res.scalars().all())
    return [await _summary_with_rollups(p, db, user) for p in rows]


@router.post(
    "", response_model=ChatProjectSummary, status_code=status.HTTP_201_CREATED
)
async def create_project(
    payload: ChatProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectSummary:
    await _validate_provider(payload.default_provider_id, user, db)
    proj = ChatProject(
        user_id=user.id,
        title=payload.title.strip(),
        description=payload.description,
        system_prompt=payload.system_prompt,
        default_model_id=payload.default_model_id,
        default_provider_id=payload.default_provider_id,
    )
    db.add(proj)
    await db.commit()
    await db.refresh(proj)
    return await _summary_with_rollups(proj, db, user)


# ---------------------------------------------------------------------
# Detail + mutation
# ---------------------------------------------------------------------


@router.get("/{project_id}", response_model=ChatProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectDetail:
    # Owner *or* accepted collaborator — project sharing grants
    # full read access to the project detail page and its files.
    proj, _role = await get_accessible_project(project_id, user, db)
    # Build the detail payload. Pinned files need a join against
    # ``user_files`` to pull the display metadata the frontend shows
    # on the Files tab.
    files_q = await db.execute(
        select(ChatProjectFile, UserFile)
        .join(UserFile, UserFile.id == ChatProjectFile.file_id)
        .where(ChatProjectFile.project_id == proj.id)
        .order_by(ChatProjectFile.pinned_at.asc())
    )
    pins = [
        ChatProjectFilePin(
            file_id=uf.id,
            filename=uf.filename,
            mime_type=uf.mime_type,
            size_bytes=uf.size_bytes,
            pinned_at=pin.pinned_at,
        )
        for pin, uf in files_q.all()
    ]
    summary = await _summary_with_rollups(proj, db, user)
    participants = await load_project_participants(proj, db)
    # ``ChatProjectDetail`` extends ``ChatProjectSummary`` — merge the
    # two payloads into one validated object so the HTTP shape stays
    # flat (no nested "summary" object the frontend has to unwrap).
    return ChatProjectDetail(
        **summary.model_dump(),
        system_prompt=proj.system_prompt,
        files=pins,
        owner=ChatProjectParticipant(
            user_id=participants.owner.user_id,
            username=participants.owner.username,
            email=participants.owner.email,
        ),
        collaborators=[
            ChatProjectParticipant(
                user_id=c.user_id, username=c.username, email=c.email
            )
            for c in participants.collaborators
        ],
    )


@router.patch("/{project_id}", response_model=ChatProjectSummary)
async def update_project(
    project_id: uuid.UUID,
    payload: ChatProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectSummary:
    # Collaborators have full write access to project settings
    # (system prompt, title, description, default model) — matching
    # the "complete access" contract for shared projects.
    proj, _role = await get_accessible_project(project_id, user, db)
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
        proj.title = payload.title.strip()
    if "description" in sent:
        proj.description = payload.description
    if "system_prompt" in sent:
        proj.system_prompt = payload.system_prompt
    if "default_model_id" in sent:
        proj.default_model_id = payload.default_model_id
    if "default_provider_id" in sent:
        await _validate_provider(payload.default_provider_id, user, db)
        proj.default_provider_id = payload.default_provider_id
    proj.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(proj)
    return await _summary_with_rollups(proj, db, user)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete a project. Conversations inside the project
    are *preserved* (the FK is ``ON DELETE SET NULL``) and bubble
    back up to the top-level list — we never silently destroy chat
    history."""
    proj = await _get_owned_project(project_id, user, db)
    await db.delete(proj)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Archive / unarchive
# ---------------------------------------------------------------------


@router.post("/{project_id}/archive", response_model=ChatProjectSummary)
async def archive_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectSummary:
    proj = await _get_owned_project(project_id, user, db)
    if proj.archived_at is None:
        proj.archived_at = datetime.now(timezone.utc)
        proj.updated_at = proj.archived_at
        await db.commit()
        await db.refresh(proj)
    return await _summary_with_rollups(proj, db, user)


@router.post("/{project_id}/unarchive", response_model=ChatProjectSummary)
async def unarchive_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectSummary:
    proj = await _get_owned_project(project_id, user, db)
    if proj.archived_at is not None:
        proj.archived_at = None
        proj.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(proj)
    return await _summary_with_rollups(proj, db, user)


# ---------------------------------------------------------------------
# Conversations inside a project
# ---------------------------------------------------------------------


@router.get(
    "/{project_id}/conversations",
    response_model=list[ConversationSummary],
)
async def list_project_conversations(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSummary]:
    """Return every conversation under ``project_id`` (most recent
    first).

    Project sharing is workspace-level: once the caller has access
    to the project (owner or accepted collaborator), they see
    **every** chat in it — the inviter's originals as well as
    anything other collaborators have added since. Individual
    conversation shares still work on top of this and remain
    invisible here; they're surfaced through the main sidebar.
    """
    proj, _role = await get_accessible_project(project_id, user, db)
    q = (
        select(Conversation)
        .where(Conversation.project_id == proj.id)
        .order_by(Conversation.updated_at.desc())
    )
    res = await db.execute(q)
    return [
        ConversationSummary.model_validate(c) for c in res.scalars().all()
    ]


# ---------------------------------------------------------------------
# Pinned files
# ---------------------------------------------------------------------


@router.post(
    "/{project_id}/files",
    response_model=ChatProjectFilePin,
    status_code=status.HTTP_201_CREATED,
)
async def pin_file(
    project_id: uuid.UUID,
    payload: ChatProjectPinFile,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ChatProjectFilePin:
    """Pin an existing :class:`UserFile` to the project.

    File must be owned by the caller (``user_files.user_id`` match).
    Admin-managed shared-pool files (``user_id IS NULL``) are *not*
    pinnable to a personal project today — the UX would be confusing
    (admins can already surface those via system folders).

    Collaborators on a shared project can pin their *own* files;
    the project owner (and other collaborators) will then see them
    in the project's file list the same way they see the owner's
    originals.
    """
    proj, _role = await get_accessible_project(project_id, user, db)

    uf = await db.get(UserFile, payload.file_id)
    if uf is None or uf.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )

    # Idempotent: re-pinning is a no-op, returns the existing row's
    # data so the client doesn't have to case on "already pinned".
    existing_q = await db.execute(
        select(ChatProjectFile).where(
            ChatProjectFile.project_id == proj.id,
            ChatProjectFile.file_id == uf.id,
        )
    )
    existing = existing_q.scalar_one_or_none()
    if existing is None:
        pin = ChatProjectFile(project_id=proj.id, file_id=uf.id)
        db.add(pin)
        proj.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(pin)
    else:
        pin = existing

    return ChatProjectFilePin(
        file_id=uf.id,
        filename=uf.filename,
        mime_type=uf.mime_type,
        size_bytes=uf.size_bytes,
        pinned_at=pin.pinned_at,
    )


@router.delete(
    "/{project_id}/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unpin_file(
    project_id: uuid.UUID,
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    proj, _role = await get_accessible_project(project_id, user, db)
    await db.execute(
        delete(ChatProjectFile).where(
            ChatProjectFile.project_id == proj.id,
            ChatProjectFile.file_id == file_id,
        )
    )
    proj.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Move a conversation in / out of a project
# ---------------------------------------------------------------------


@router.post(
    "/{project_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def move_conversation_into_project(
    project_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Move an existing chat into the project.

    Caller must own the conversation (no moving someone else's
    chats into your workspace) and have access to the target
    project (owner or accepted collaborator). Temporary chats are
    rejected: tying a short-lived chat to a project complicates the
    cleanup sweep for negligible benefit."""
    proj, _role = await get_accessible_project(project_id, user, db)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.temporary_mode is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Temporary chats can't belong to a project.",
        )
    conv.project_id = proj.id
    conv.updated_at = datetime.now(timezone.utc)
    proj.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


@router.delete(
    "/{project_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def remove_conversation_from_project(
    project_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Detach a chat from its project without deleting the chat
    itself — it resurfaces at the top level of the sidebar."""
    proj, _role = await get_accessible_project(project_id, user, db)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.project_id != proj.id:
        # Idempotent: already out, return the current state so the UI
        # doesn't need a special-case error path.
        return ConversationSummary.model_validate(conv)
    conv.project_id = None
    conv.updated_at = datetime.now(timezone.utc)
    proj.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)
