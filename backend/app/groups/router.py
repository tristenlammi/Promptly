"""Admin API for user groups (Phase 10 — Groups). Mounted /api/admin/groups."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.groups.models import UserGroup, UserGroupMember

router = APIRouter()


async def _get_owned_group(
    group_id: uuid.UUID, user: User, db: AsyncSession
) -> UserGroup:
    """Fetch a group the admin may manage. Missing groups 404."""
    g = await db.get(UserGroup, group_id)
    if g is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return g


class GroupMember(BaseModel):
    id: uuid.UUID
    username: str


class GroupResponse(BaseModel):
    id: uuid.UUID
    name: str
    members: list[GroupMember]
    # Model ids this group grants every member (provider ids + custom:<uuid>).
    allowed_models: list[str]
    created_at: datetime


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    allowed_models: list[str] = []


class GroupUpdate(BaseModel):
    # Omit a field to leave it unchanged.
    name: str | None = Field(default=None, min_length=1, max_length=80)
    allowed_models: list[str] | None = None


class SetMembersRequest(BaseModel):
    user_ids: list[uuid.UUID]


async def _members(db: AsyncSession, group_id: uuid.UUID) -> list[GroupMember]:
    rows = (
        await db.execute(
            select(User.id, User.username)
            .join(UserGroupMember, UserGroupMember.user_id == User.id)
            .where(UserGroupMember.group_id == group_id)
            .order_by(User.username.asc())
        )
    ).all()
    return [GroupMember(id=r[0], username=r[1]) for r in rows]


async def _to_response(db: AsyncSession, g: UserGroup) -> GroupResponse:
    return GroupResponse(
        id=g.id,
        name=g.name,
        members=await _members(db, g.id),
        allowed_models=list(g.allowed_models or []),
        created_at=g.created_at,
    )


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[GroupResponse]:
    stmt = select(UserGroup).order_by(UserGroup.name.asc())
    groups = (await db.execute(stmt)).scalars().all()
    return [await _to_response(db, g) for g in groups]


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    payload: GroupCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> GroupResponse:
    g = UserGroup(
        name=payload.name.strip(),
        allowed_models=list(payload.allowed_models or []),
        created_by=admin.id,
    )
    db.add(g)
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A group with that name exists") from e
    await db.refresh(g)
    return await _to_response(db, g)


@router.patch("/{group_id}", response_model=GroupResponse)
async def update_group(
    group_id: uuid.UUID,
    payload: GroupUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> GroupResponse:
    g = await _get_owned_group(group_id, user, db)
    if payload.name is not None:
        g.name = payload.name.strip()
    if payload.allowed_models is not None:
        g.allowed_models = list(payload.allowed_models)
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A group with that name exists") from e
    await db.refresh(g)
    return await _to_response(db, g)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    g = await _get_owned_group(group_id, user, db)
    await db.delete(g)
    await db.commit()


@router.put("/{group_id}/members", response_model=GroupResponse)
async def set_members(
    group_id: uuid.UUID,
    payload: SetMembersRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> GroupResponse:
    g = await _get_owned_group(group_id, user, db)
    # Keep only ids that are real users (any user is a valid member).
    valid_stmt = select(User.id).where(User.id.in_(payload.user_ids or []))
    valid = set((await db.execute(valid_stmt)).scalars().all())
    await db.execute(
        delete(UserGroupMember).where(UserGroupMember.group_id == group_id)
    )
    for uid in valid:
        db.add(UserGroupMember(group_id=group_id, user_id=uid))
    await db.commit()
    return await _to_response(db, g)
