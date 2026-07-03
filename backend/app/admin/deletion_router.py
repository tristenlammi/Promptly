"""Operator controls for the soft-delete / purge lifecycle.

Mounted under ``/api/admin/deletion``. Gated on :func:`require_admin` — the
single platform operator. Customer-initiated deletions always flow through the
grace window (recoverable); the irreversible actions here — purge-now and
restore — are the operator's alone.

  GET  /pending              → everything currently soft-deleted + when it purges
  POST /users/{id}/purge     → hard-delete a user now (skip the grace window)
  POST /users/{id}/restore   → un-delete a user (clear the clock, re-enable)
  POST /orgs/{id}/purge      → hard-delete an org now
  POST /orgs/{id}/restore    → un-delete an org
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import Organization, User
from app.config import get_settings
from app.database import get_db
from app.tasks.deletion import purge_org, purge_user

router = APIRouter()


class PendingUser(BaseModel):
    id: uuid.UUID
    email: str
    username: str
    deleted_at: str
    purge_after: str


class PendingOrg(BaseModel):
    id: uuid.UUID
    name: str
    deleted_at: str
    purge_after: str


class PendingDeletions(BaseModel):
    grace_days: int
    users: list[PendingUser]
    orgs: list[PendingOrg]


def _purge_after(deleted_at, grace_days: int) -> str:
    return (deleted_at + timedelta(days=grace_days)).isoformat()


@router.get("/pending", response_model=PendingDeletions)
async def list_pending(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> PendingDeletions:
    """Everything soft-deleted, with the date it will be purged."""
    grace = max(int(get_settings().DELETION_GRACE_DAYS or 0), 0)
    users = (
        await db.execute(
            select(User)
            .where(User.deleted_at.is_not(None))
            .order_by(User.deleted_at.asc())
        )
    ).scalars().all()
    orgs = (
        await db.execute(
            select(Organization)
            .where(Organization.deleted_at.is_not(None))
            .order_by(Organization.deleted_at.asc())
        )
    ).scalars().all()
    return PendingDeletions(
        grace_days=grace,
        users=[
            PendingUser(
                id=u.id,
                email=u.email,
                username=u.username,
                deleted_at=u.deleted_at.isoformat(),
                purge_after=_purge_after(u.deleted_at, grace),
            )
            for u in users
        ],
        orgs=[
            PendingOrg(
                id=o.id,
                name=o.name,
                deleted_at=o.deleted_at.isoformat(),
                purge_after=_purge_after(o.deleted_at, grace),
            )
            for o in orgs
        ],
    )


@router.post("/users/{user_id}/purge")
async def purge_user_now(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> dict[str, bool]:
    """Irreversibly hard-delete a user + all their content NOW, skipping grace.
    Only a *soft-deleted* user can be purged — you can't nuke a live account
    through this path (delete it in Clerk first)."""
    if user_id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot purge your own account.",
        )
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is not soft-deleted; nothing to purge.",
        )
    purged = await purge_user(db, user)
    if not purged:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is protected and cannot be purged.",
        )
    return {"purged": True}


@router.post("/users/{user_id}/restore")
async def restore_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, bool]:
    """Un-delete a soft-deleted user: clear the purge clock and re-enable.
    (Their content was never touched — this simply reverses the mark.)"""
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    user.deleted_at = None
    user.disabled = False
    await db.commit()
    return {"restored": True}


@router.post("/orgs/{org_id}/purge")
async def purge_org_now(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, bool]:
    """Irreversibly hard-delete a soft-deleted org + its config NOW."""
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if org.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Organization is not soft-deleted; nothing to purge.",
        )
    await purge_org(db, org)
    return {"purged": True}


@router.post("/orgs/{org_id}/restore")
async def restore_org(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, bool]:
    """Un-delete a soft-deleted org: clear the purge clock. Its config survived,
    so it comes back intact — but note members detached at Clerk deletion time
    must rejoin via Clerk (Clerk is the source of truth for membership)."""
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    org.deleted_at = None
    await db.commit()
    return {"restored": True}


__all__ = ["router"]
