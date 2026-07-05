"""Workspace-level share / invite lifecycle (migration 0031).

Mirrors ``app.chat.shares`` for **workspaces**: create a pending
``WorkspaceShare`` row, the invitee accepts or declines, the owner
can revoke, and once accepted the invitee gets complete access to
every conversation under the workspace (past and future) plus the
workspace's pinned files and settings.

Splitting this out from ``shares.py`` keeps the chat-share module
focused and gives workspace sharing its own router prefix. The
low-level access helpers (``_has_workspace_access``,
``list_accessible_workspace_ids``) still live in ``shares.py`` so
``get_accessible_conversation`` can import them without a circular
dep.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Workspace, WorkspaceFile, WorkspaceShare
from app.chat.shares import ShareUserBrief, _brief, _resolve_invitee
from app.database import get_db
from app.files.models import UserFile
from app.workspaces.knowledge import delete_workspace_file_chunks

logger = logging.getLogger("promptly.workspaces.shares")
router = APIRouter()

WorkspaceShareStatus = Literal["pending", "accepted", "declined"]


# ====================================================================
# Access helpers
# ====================================================================
async def is_owner_of_workspace(
    workspace_id: uuid.UUID, user: User, db: AsyncSession
) -> Workspace:
    """Return the workspace iff ``user`` owns it, else 404.

    Matches :func:`is_owner_of_conversation` in semantics — used
    by share-management and destructive endpoints (delete workspace,
    archive) that should never be exposed to a collaborator, even
    one with an accepted workspace share.
    """
    ws = await db.get(Workspace, workspace_id)
    if ws is None or ws.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )
    return ws


WorkspaceAccessRole = Literal["owner", "editor", "viewer"]


async def get_accessible_workspace(
    workspace_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[Workspace, WorkspaceAccessRole]:
    """Owner *or* accepted collaborator, else 404.

    Returns the caller's effective role: ``owner`` for the creator, or
    the accepted share's ``role`` (``editor`` / ``viewer``) for a
    collaborator. Read endpoints can ignore the role; write endpoints
    pass it through :func:`require_workspace_write`. Destructive endpoints
    keep calling :func:`is_owner_of_workspace` directly.
    """
    ws = await db.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )
    if ws.user_id == user.id:
        return ws, "owner"
    share = (
        await db.execute(
            select(WorkspaceShare).where(
                WorkspaceShare.workspace_id == workspace_id,
                WorkspaceShare.invitee_user_id == user.id,
                WorkspaceShare.status == "accepted",
            )
        )
    ).scalars().first()
    if share is not None:
        # ``role`` is non-null post-0071; default to editor for any
        # pre-migration row that somehow lacks it.
        role: WorkspaceAccessRole = (
            "viewer" if share.role == "viewer" else "editor"
        )
        return ws, role
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Workspace not found",
    )


def require_workspace_write(role: WorkspaceAccessRole) -> None:
    """403 when the caller is a read-only viewer. Owner + editor pass."""
    if role == "viewer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You have view-only access to this workspace.",
        )


# ====================================================================
# DTOs
# ====================================================================
class WorkspaceShareRow(BaseModel):
    """One row in the owner's "people on this workspace" list."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    invitee: ShareUserBrief
    status: WorkspaceShareStatus
    role: Literal["editor", "viewer"]
    created_at: datetime
    accepted_at: datetime | None


class WorkspaceInviteRow(BaseModel):
    """A pending workspace-share invitation as seen by the invitee."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    workspace_title: str
    inviter: ShareUserBrief
    created_at: datetime


class CreateWorkspaceShareRequest(BaseModel):
    """Owner asks to share a workspace with ``username`` or ``email``.

    Mirrors ``CreateShareRequest`` for conversations — one of the
    two fields must be present. The user-picker in the frontend
    populates ``username`` directly after the caller picks from the
    directory autocomplete.
    """

    username: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=320)
    # Permission level for the invite. Defaults to full editor access
    # (back-compat with the pre-role share UI).
    role: Literal["editor", "viewer"] = "editor"


class WorkspaceParticipants(BaseModel):
    """Owner + accepted collaborators surfaced in workspace detail."""

    owner: ShareUserBrief
    collaborators: list[ShareUserBrief] = Field(default_factory=list)


async def load_workspace_participants(
    ws: Workspace, db: AsyncSession
) -> WorkspaceParticipants:
    """Fetch the workspace's owner and every accepted collaborator.

    One round-trip for the owner, one for the collaborators. Called
    from :mod:`app.workspaces.router` on the detail endpoint so
    the frontend can render a "shared with Jane, Alex" chip in the
    workspace header.
    """
    owner = await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Workspace owner missing",
        )
    rows = (
        await db.execute(
            select(User)
            .join(WorkspaceShare, WorkspaceShare.invitee_user_id == User.id)
            .where(
                WorkspaceShare.workspace_id == ws.id,
                WorkspaceShare.status == "accepted",
            )
            .order_by(User.username.asc())
        )
    ).scalars().all()
    return WorkspaceParticipants(
        owner=_brief(owner),
        collaborators=[_brief(u) for u in rows],
    )


# ====================================================================
# Endpoints — owner perspective
# ====================================================================
@router.get(
    "/{workspace_id}/shares",
    response_model=list[WorkspaceShareRow],
)
async def list_workspace_shares(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceShareRow]:
    """List every share row on a workspace. Owner only."""
    ws = await is_owner_of_workspace(workspace_id, user, db)
    rows = (
        await db.execute(
            select(WorkspaceShare, User)
            .join(User, User.id == WorkspaceShare.invitee_user_id)
            .where(WorkspaceShare.workspace_id == ws.id)
            .order_by(WorkspaceShare.created_at.desc())
        )
    ).all()
    return [
        WorkspaceShareRow(
            id=share.id,
            workspace_id=share.workspace_id,
            invitee=_brief(invitee),
            status=share.status,  # type: ignore[arg-type]
            role="viewer" if share.role == "viewer" else "editor",
            created_at=share.created_at,
            accepted_at=share.accepted_at,
        )
        for share, invitee in rows
    ]


@router.post(
    "/{workspace_id}/shares",
    response_model=WorkspaceShareRow,
    status_code=status.HTTP_201_CREATED,
)
async def create_workspace_share(
    workspace_id: uuid.UUID,
    payload: CreateWorkspaceShareRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceShareRow:
    """Invite someone to collaborate on a workspace. Owner only.

    Same idempotent behaviour as conversation shares: re-inviting a
    pending user returns the existing row; re-inviting after they
    declined flips the row back to ``pending``; self-invites 400.
    """
    ws = await is_owner_of_workspace(workspace_id, user, db)
    # Reuse the conversation-share resolver so "find user by
    # username or email" stays a single code path for both share
    # surfaces.
    from app.chat.shares import CreateShareRequest

    invitee = await _resolve_invitee(
        CreateShareRequest(
            username=payload.username, email=payload.email
        ),
        db,
    )
    if invitee.id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You already own this workspace.",
        )

    existing = (
        await db.execute(
            select(WorkspaceShare).where(
                WorkspaceShare.workspace_id == ws.id,
                WorkspaceShare.invitee_user_id == invitee.id,
            )
        )
    ).scalars().first()

    from app.auth.audit import record_event
    from app.auth.events import EVENT_WORKSPACE_SHARE_CREATED

    now = datetime.now(timezone.utc)
    if existing is not None:
        # Re-inviting updates the role (lets an owner promote/demote a
        # collaborator by re-sending). A declined row flips back to
        # pending; an accepted row keeps its status but adopts the new
        # role immediately.
        existing.role = payload.role
        if existing.status == "declined":
            existing.status = "pending"
        existing.updated_at = now
        await record_event(
            db,
            event_type=EVENT_WORKSPACE_SHARE_CREATED,
            request=request,
            user_id=user.id,
            detail=f'"{ws.title}" (ws={ws.id}) → {invitee.username} '
            f"as {payload.role} (re-invite)",
        )
        await db.commit()
        await db.refresh(existing)
        share = existing
    else:
        share = WorkspaceShare(
            workspace_id=ws.id,
            inviter_user_id=user.id,
            invitee_user_id=invitee.id,
            status="pending",
            role=payload.role,
        )
        db.add(share)
        await record_event(
            db,
            event_type=EVENT_WORKSPACE_SHARE_CREATED,
            request=request,
            user_id=user.id,
            detail=f'"{ws.title}" (ws={ws.id}) → {invitee.username} '
            f"as {payload.role}",
        )
        await db.commit()
        await db.refresh(share)

    # Tell the invitee — until now invites sat silently in the sidebar
    # waiting to be noticed. Best-effort (inbox row + push).
    if share.status == "pending":
        try:
            from app.notifications import notify_user

            await notify_user(
                user_id=invitee.id,
                category="invite",
                title=f"{user.username} invited you to a workspace",
                body=f'"{ws.title}" — accept or decline from the sidebar.',
                url="/workspaces",
                tag=f"promptly-invite-{ws.id}",
                actor_user_id=user.id,
                workspace_id=ws.id,
            )
        except Exception:  # pragma: no cover — never fail the invite
            logger.warning("invite notification failed", exc_info=True)

    return WorkspaceShareRow(
        id=share.id,
        workspace_id=share.workspace_id,
        invitee=_brief(invitee),
        status=share.status,  # type: ignore[arg-type]
        role="viewer" if share.role == "viewer" else "editor",
        created_at=share.created_at,
        accepted_at=share.accepted_at,
    )


@router.delete(
    "/{workspace_id}/shares/{share_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def revoke_workspace_share(
    workspace_id: uuid.UUID,
    share_id: uuid.UUID,
    background: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner revokes, or invitee leaves, a workspace share.

    Hard-deletes the row. The unique ``(workspace_id, invitee_user_id)``
    constraint means a follow-up invite starts cleanly as
    ``pending`` rather than surfacing a stale ``accepted`` row.

    Files the departing member owns are unpinned and their workspace
    chunks purged — otherwise their content would stay retrievable (and
    visible in the pinned list) for the remaining members after they left.
    """
    share = await db.get(WorkspaceShare, share_id)
    if share is None or share.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )
    ws = await db.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    is_owner = ws.user_id == user.id
    is_invitee = share.invitee_user_id == user.id
    if not (is_owner or is_invitee):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )

    # Unpin every workspace file whose backing Drive file belongs to the
    # departing member (covers their uploads and their auto-managed
    # chat-context files). Chunk deletion runs post-commit — it owns its
    # own session.
    member_pins = (
        (
            await db.execute(
                select(WorkspaceFile)
                .join(UserFile, UserFile.id == WorkspaceFile.file_id)
                .where(
                    WorkspaceFile.workspace_id == workspace_id,
                    UserFile.user_id == share.invitee_user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    purged_file_ids = [p.file_id for p in member_pins]
    for pin in member_pins:
        await db.delete(pin)

    departing_id = share.invitee_user_id
    await db.delete(share)
    from app.auth.audit import record_event
    from app.auth.events import EVENT_WORKSPACE_SHARE_REVOKED

    await record_event(
        db,
        event_type=EVENT_WORKSPACE_SHARE_REVOKED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={workspace_id}) — member {departing_id} '
        + ("left" if is_invitee and not is_owner else "removed by owner"),
    )
    await db.commit()

    if purged_file_ids:
        logger.info(
            "workspace %s: purging %d pinned file(s) owned by departing member %s",
            workspace_id,
            len(purged_file_ids),
            share.invitee_user_id,
        )
    for fid in purged_file_ids:
        background.add_task(delete_workspace_file_chunks, workspace_id, fid)


# ====================================================================
# Endpoints — invitee perspective
# ====================================================================
# Mounted at ``/api`` (sibling-namespace of conversations) so
# the "my workspace invites" inbox sits alongside the existing
# ``/api/chat/share-invites`` for chats. We use a *second* router
# with its own prefix-less endpoints below because it's the cleanest
# way to attach the same ``/api/workspace-share-invites`` URL
# space without overloading the workspaces router.
invite_router = APIRouter()


@invite_router.get("/workspace-share-invites", response_model=list[WorkspaceInviteRow])
async def list_workspace_share_invites(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceInviteRow]:
    """Pending workspace-share invites for the caller."""
    rows = (
        await db.execute(
            select(WorkspaceShare, Workspace, User)
            .join(Workspace, Workspace.id == WorkspaceShare.workspace_id)
            .join(User, User.id == WorkspaceShare.inviter_user_id)
            .where(
                WorkspaceShare.invitee_user_id == user.id,
                WorkspaceShare.status == "pending",
            )
            .order_by(WorkspaceShare.created_at.desc())
        )
    ).all()
    return [
        WorkspaceInviteRow(
            id=share.id,
            workspace_id=ws.id,
            workspace_title=ws.title,
            inviter=_brief(inviter),
            created_at=share.created_at,
        )
        for share, ws, inviter in rows
    ]


@invite_router.post(
    "/workspace-share-invites/{share_id}/accept",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def accept_workspace_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(WorkspaceShare, share_id)
    if share is None or share.invitee_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found"
        )
    if share.status == "accepted":
        return
    share.status = "accepted"
    share.accepted_at = datetime.now(timezone.utc)
    share.updated_at = datetime.now(timezone.utc)
    await db.commit()


@invite_router.post(
    "/workspace-share-invites/{share_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def decline_workspace_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(WorkspaceShare, share_id)
    if share is None or share.invitee_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found"
        )
    if share.status == "declined":
        return
    share.status = "declined"
    share.accepted_at = None
    share.updated_at = datetime.now(timezone.utc)
    await db.commit()


__all__ = [
    "WorkspaceInviteRow",
    "WorkspaceParticipants",
    "WorkspaceShareRow",
    "get_accessible_workspace",
    "invite_router",
    "is_owner_of_workspace",
    "load_workspace_participants",
    "require_workspace_write",
    "router",
]
