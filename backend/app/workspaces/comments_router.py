"""Workspace item comments API (Phase 6 — collaboration).

A flat, chronological discussion thread attached to a workspace item.
Any workspace member (owner or accepted collaborator) can read; owner +
editor can post; a comment can be removed by its author or the workspace
owner. Mounted under ``/api/workspaces``.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import WorkspaceItem, WorkspaceItemComment
from app.database import get_db
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()

_MAX_BODY = 4000


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=_MAX_BODY)


class CommentResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    body: str
    author_user_id: uuid.UUID | None
    author_name: str
    created_at: datetime


async def _require_item(
    workspace_id: uuid.UUID, item_id: uuid.UUID, db: AsyncSession
) -> WorkspaceItem:
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    return item


@router.get(
    "/{workspace_id}/items/{item_id}/comments",
    response_model=list[CommentResponse],
)
async def list_comments(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CommentResponse]:
    await get_accessible_workspace(workspace_id, user, db)
    await _require_item(workspace_id, item_id, db)

    rows = (
        await db.execute(
            select(WorkspaceItemComment, User.username)
            .outerjoin(User, User.id == WorkspaceItemComment.author_user_id)
            .where(WorkspaceItemComment.item_id == item_id)
            .order_by(WorkspaceItemComment.created_at.asc())
        )
    ).all()

    return [
        CommentResponse(
            id=c.id,
            item_id=c.item_id,
            body=c.body,
            author_user_id=c.author_user_id,
            author_name=username or "former member",
            created_at=c.created_at,
        )
        for c, username in rows
    ]


@router.post(
    "/{workspace_id}/items/{item_id}/comments",
    response_model=CommentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: CommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommentResponse:
    _ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    await _require_item(workspace_id, item_id, db)

    comment = WorkspaceItemComment(
        workspace_id=workspace_id,
        item_id=item_id,
        author_user_id=user.id,
        body=payload.body.strip(),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    return CommentResponse(
        id=comment.id,
        item_id=comment.item_id,
        body=comment.body,
        author_user_id=comment.author_user_id,
        author_name=user.username,
        created_at=comment.created_at,
    )


@router.delete(
    "/{workspace_id}/items/{item_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_comment(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    comment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    comment = await db.get(WorkspaceItemComment, comment_id)
    if (
        comment is None
        or comment.item_id != item_id
        or comment.workspace_id != workspace_id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    # Author or workspace owner may delete.
    if comment.author_user_id != user.id and ws.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author or workspace owner can delete this comment.",
        )
    await db.delete(comment)
    await db.commit()
