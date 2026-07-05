"""Workspace item comments API (Phase 6 — collaboration).

A flat, chronological discussion thread attached to a workspace item.
Any workspace member (owner or accepted collaborator) can read; owner +
editor can post; a comment can be removed by its author or the workspace
owner. Batch-3 finale additions: an optional ``quote`` anchor (the note
text a comment is about), resolve/unresolve, and @-mention fan-out.
Mounted under ``/api/workspaces``.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

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
_MAX_QUOTE = 500


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=_MAX_BODY)
    # The selected note text this comment anchors to. Text-quote
    # anchoring on purpose — editor marks wouldn't survive the
    # bleach/CRDT snapshot pipeline; a quoted string survives anything
    # (including the anchored text later being edited away — the quote
    # still reads as context).
    quote: str | None = Field(default=None, max_length=_MAX_QUOTE)


class CommentResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    body: str
    quote: str | None = None
    author_user_id: uuid.UUID | None
    author_name: str
    resolved_at: datetime | None = None
    created_at: datetime


def _to_response(
    c: WorkspaceItemComment, author_name: str
) -> CommentResponse:
    return CommentResponse(
        id=c.id,
        item_id=c.item_id,
        body=c.body,
        quote=c.quote,
        author_user_id=c.author_user_id,
        author_name=author_name,
        resolved_at=c.resolved_at,
        created_at=c.created_at,
    )


async def _require_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession,
    user: User,
) -> WorkspaceItem:
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    # Someone else's private draft 404s here too (0134).
    from app.workspaces.items_router import require_item_visible

    require_item_visible(item, user)
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
    await _require_item(workspace_id, item_id, db, user)

    rows = (
        await db.execute(
            select(WorkspaceItemComment, User.username)
            .outerjoin(User, User.id == WorkspaceItemComment.author_user_id)
            .where(WorkspaceItemComment.item_id == item_id)
            .order_by(WorkspaceItemComment.created_at.asc())
        )
    ).all()

    return [_to_response(c, username or "former member") for c, username in rows]


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
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    item = await _require_item(workspace_id, item_id, db, user)

    quote = (payload.quote or "").strip() or None
    comment = WorkspaceItemComment(
        workspace_id=workspace_id,
        item_id=item_id,
        author_user_id=user.id,
        body=payload.body.strip(),
        quote=quote,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    # @-mentions → inbox + push for named members (best-effort).
    from app.workspaces.mentions import notify_comment_mentions

    await notify_comment_mentions(
        db,
        ws=ws,
        author=user,
        text=comment.body,
        url=f"/workspaces/{workspace_id}?item={item_id}",
        where=f'a comment on "{item.title or "an item"}"',
    )

    return _to_response(comment, user.username)


class CommentResolveUpdate(BaseModel):
    resolved: bool


@router.post(
    "/{workspace_id}/items/{item_id}/comments/{comment_id}/resolve",
    response_model=CommentResponse,
)
async def set_comment_resolved(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    comment_id: uuid.UUID,
    payload: CommentResolveUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommentResponse:
    """Resolve / unresolve a comment. Any member who can post can
    resolve — resolution is a conversation state, not a moderation act."""
    _ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    await _require_item(workspace_id, item_id, db, user)
    comment = await db.get(WorkspaceItemComment, comment_id)
    if (
        comment is None
        or comment.item_id != item_id
        or comment.workspace_id != workspace_id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    comment.resolved_at = (
        datetime.now(timezone.utc) if payload.resolved else None
    )
    await db.commit()
    await db.refresh(comment)
    author = (
        await db.execute(
            select(User.username).where(User.id == comment.author_user_id)
        )
    ).scalar_one_or_none()
    return _to_response(comment, author or "former member")


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
