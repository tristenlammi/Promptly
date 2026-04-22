"""Project-level share / invite lifecycle (migration 0031).

Mirrors ``app.chat.shares`` for **projects**: create a pending
``ProjectShare`` row, the invitee accepts or declines, the owner
can revoke, and once accepted the invitee gets complete access to
every conversation under the project (past and future) plus the
project's pinned files and settings.

Splitting this out from ``shares.py`` keeps the chat-share module
focused and gives project sharing its own router prefix. The
low-level access helpers (``_has_project_access``,
``list_accessible_project_ids``) still live in ``shares.py`` so
``get_accessible_conversation`` can import them without a circular
dep.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import ChatProject, ProjectShare
from app.chat.shares import ShareUserBrief, _brief, _resolve_invitee
from app.database import get_db

logger = logging.getLogger("promptly.chat.project_shares")
router = APIRouter()

ProjectShareStatus = Literal["pending", "accepted", "declined"]


# ====================================================================
# Access helpers
# ====================================================================
async def is_owner_of_project(
    project_id: uuid.UUID, user: User, db: AsyncSession
) -> ChatProject:
    """Return the project iff ``user`` owns it, else 404.

    Matches :func:`is_owner_of_conversation` in semantics — used
    by share-management and destructive endpoints (delete project,
    archive) that should never be exposed to a collaborator, even
    one with an accepted project share.
    """
    proj = await db.get(ChatProject, project_id)
    if proj is None or proj.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )
    return proj


async def get_accessible_project(
    project_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[ChatProject, Literal["owner", "collaborator"]]:
    """Owner *or* accepted collaborator, else 404.

    Used by the project detail / settings endpoints so a collaborator
    can view the project page, edit settings, and pin files. Destructive
    endpoints keep calling :func:`is_owner_of_project` directly.
    """
    proj = await db.get(ChatProject, project_id)
    if proj is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )
    if proj.user_id == user.id:
        return proj, "owner"
    share = (
        await db.execute(
            select(ProjectShare).where(
                ProjectShare.project_id == project_id,
                ProjectShare.invitee_user_id == user.id,
                ProjectShare.status == "accepted",
            )
        )
    ).scalars().first()
    if share is not None:
        return proj, "collaborator"
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Project not found",
    )


# ====================================================================
# DTOs
# ====================================================================
class ProjectShareRow(BaseModel):
    """One row in the owner's "people on this project" list."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    invitee: ShareUserBrief
    status: ProjectShareStatus
    created_at: datetime
    accepted_at: datetime | None


class ProjectInviteRow(BaseModel):
    """A pending project-share invitation as seen by the invitee."""

    id: uuid.UUID
    project_id: uuid.UUID
    project_title: str
    inviter: ShareUserBrief
    created_at: datetime


class CreateProjectShareRequest(BaseModel):
    """Owner asks to share a project with ``username`` or ``email``.

    Mirrors ``CreateShareRequest`` for conversations — one of the
    two fields must be present. The user-picker in the frontend
    populates ``username`` directly after the caller picks from the
    directory autocomplete.
    """

    username: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=320)


class ProjectParticipants(BaseModel):
    """Owner + accepted collaborators surfaced in project detail."""

    owner: ShareUserBrief
    collaborators: list[ShareUserBrief] = Field(default_factory=list)


async def load_project_participants(
    proj: ChatProject, db: AsyncSession
) -> ProjectParticipants:
    """Fetch the project's owner and every accepted collaborator.

    One round-trip for the owner, one for the collaborators. Called
    from :mod:`app.chat.projects_router` on the detail endpoint so
    the frontend can render a "shared with Jane, Alex" chip in the
    project header.
    """
    owner = await db.get(User, proj.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Project owner missing",
        )
    rows = (
        await db.execute(
            select(User)
            .join(ProjectShare, ProjectShare.invitee_user_id == User.id)
            .where(
                ProjectShare.project_id == proj.id,
                ProjectShare.status == "accepted",
            )
            .order_by(User.username.asc())
        )
    ).scalars().all()
    return ProjectParticipants(
        owner=_brief(owner),
        collaborators=[_brief(u) for u in rows],
    )


# ====================================================================
# Endpoints — owner perspective
# ====================================================================
@router.get(
    "/{project_id}/shares",
    response_model=list[ProjectShareRow],
)
async def list_project_shares(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ProjectShareRow]:
    """List every share row on a project. Owner only."""
    proj = await is_owner_of_project(project_id, user, db)
    rows = (
        await db.execute(
            select(ProjectShare, User)
            .join(User, User.id == ProjectShare.invitee_user_id)
            .where(ProjectShare.project_id == proj.id)
            .order_by(ProjectShare.created_at.desc())
        )
    ).all()
    return [
        ProjectShareRow(
            id=share.id,
            project_id=share.project_id,
            invitee=_brief(invitee),
            status=share.status,  # type: ignore[arg-type]
            created_at=share.created_at,
            accepted_at=share.accepted_at,
        )
        for share, invitee in rows
    ]


@router.post(
    "/{project_id}/shares",
    response_model=ProjectShareRow,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_share(
    project_id: uuid.UUID,
    payload: CreateProjectShareRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProjectShareRow:
    """Invite someone to collaborate on a project. Owner only.

    Same idempotent behaviour as conversation shares: re-inviting a
    pending user returns the existing row; re-inviting after they
    declined flips the row back to ``pending``; self-invites 400.
    """
    proj = await is_owner_of_project(project_id, user, db)
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
            detail="You already own this project.",
        )

    existing = (
        await db.execute(
            select(ProjectShare).where(
                ProjectShare.project_id == proj.id,
                ProjectShare.invitee_user_id == invitee.id,
            )
        )
    ).scalars().first()

    now = datetime.now(timezone.utc)
    if existing is not None:
        if existing.status == "declined":
            existing.status = "pending"
            existing.updated_at = now
            await db.commit()
            await db.refresh(existing)
        share = existing
    else:
        share = ProjectShare(
            project_id=proj.id,
            inviter_user_id=user.id,
            invitee_user_id=invitee.id,
            status="pending",
        )
        db.add(share)
        await db.commit()
        await db.refresh(share)

    return ProjectShareRow(
        id=share.id,
        project_id=share.project_id,
        invitee=_brief(invitee),
        status=share.status,  # type: ignore[arg-type]
        created_at=share.created_at,
        accepted_at=share.accepted_at,
    )


@router.delete(
    "/{project_id}/shares/{share_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def revoke_project_share(
    project_id: uuid.UUID,
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner revokes, or invitee leaves, a project share.

    Hard-deletes the row. The unique ``(project_id, invitee_user_id)``
    constraint means a follow-up invite starts cleanly as
    ``pending`` rather than surfacing a stale ``accepted`` row.
    """
    share = await db.get(ProjectShare, share_id)
    if share is None or share.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )
    proj = await db.get(ChatProject, project_id)
    if proj is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    is_owner = proj.user_id == user.id
    is_invitee = share.invitee_user_id == user.id
    if not (is_owner or is_invitee):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )
    await db.delete(share)
    await db.commit()


# ====================================================================
# Endpoints — invitee perspective
# ====================================================================
# Mounted at ``/api/chat`` (sibling-namespace of conversations) so
# the "my project invites" inbox sits alongside the existing
# ``/api/chat/share-invites`` for chats. We use a *second* router
# with its own prefix-less endpoints below because it's the cleanest
# way to attach the same ``/api/chat/project-share-invites`` URL
# space without overloading the projects router.
invite_router = APIRouter()


@invite_router.get("/project-share-invites", response_model=list[ProjectInviteRow])
async def list_project_share_invites(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ProjectInviteRow]:
    """Pending project-share invites for the caller."""
    rows = (
        await db.execute(
            select(ProjectShare, ChatProject, User)
            .join(ChatProject, ChatProject.id == ProjectShare.project_id)
            .join(User, User.id == ProjectShare.inviter_user_id)
            .where(
                ProjectShare.invitee_user_id == user.id,
                ProjectShare.status == "pending",
            )
            .order_by(ProjectShare.created_at.desc())
        )
    ).all()
    return [
        ProjectInviteRow(
            id=share.id,
            project_id=proj.id,
            project_title=proj.title,
            inviter=_brief(inviter),
            created_at=share.created_at,
        )
        for share, proj, inviter in rows
    ]


@invite_router.post(
    "/project-share-invites/{share_id}/accept",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def accept_project_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(ProjectShare, share_id)
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
    "/project-share-invites/{share_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def decline_project_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(ProjectShare, share_id)
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
    "ProjectInviteRow",
    "ProjectParticipants",
    "ProjectShareRow",
    "get_accessible_project",
    "invite_router",
    "is_owner_of_project",
    "load_project_participants",
    "router",
]
