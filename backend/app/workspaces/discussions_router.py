"""Workspace discussions API — threaded messaging between members.

A ``kind='discussion'`` workspace item is the "channel"; it holds threads
(topics), each a chronological list of messages. Any workspace member can
read; posting requires write access (editor+), matching every other content
surface. A message can be removed by its author or a workspace admin/owner.

@-mentions reuse the comment fan-out (inbox + push).

**RAG is opt-in.** Nothing here is embedded unless the discussion item's
``context_enabled`` is turned on by a member — see
``knowledge.index_discussion_for_workspace``. Team chatter stays out of the
AI's context by default.

Mounted under ``/api/workspaces``.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import DiscussionMessage, DiscussionThread, WorkspaceItem
from app.database import get_db
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

logger = logging.getLogger("promptly.workspaces.discussions")

router = APIRouter()

_MAX_BODY = 8000
_MAX_TITLE = 200


# ---------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------
class ThreadCreate(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)
    # Optional opening post so "new thread" is one round-trip.
    body: str | None = Field(default=None, max_length=_MAX_BODY)


class ThreadResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    title: str
    created_by: uuid.UUID | None
    created_by_name: str
    message_count: int
    last_message_at: datetime | None
    created_at: datetime


class MessageCreate(BaseModel):
    body: str = Field(min_length=1, max_length=_MAX_BODY)


class MessageResponse(BaseModel):
    id: uuid.UUID
    thread_id: uuid.UUID
    body: str
    author_user_id: uuid.UUID | None
    author_name: str
    edited_at: datetime | None
    created_at: datetime


def _msg_response(m: DiscussionMessage, author_name: str) -> MessageResponse:
    return MessageResponse(
        id=m.id,
        thread_id=m.thread_id,
        body=m.body,
        author_user_id=m.author_user_id,
        author_name=author_name,
        edited_at=m.edited_at,
        created_at=m.created_at,
    )


# ---------------------------------------------------------------------
# Loaders / guards
# ---------------------------------------------------------------------
async def _require_discussion_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession,
    user: User,
) -> WorkspaceItem:
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Discussion not found"
        )
    if item.kind != "discussion":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That item is not a discussion.",
        )
    from app.workspaces.items_router import require_item_visible

    require_item_visible(item, user)
    return item


async def _require_thread(
    workspace_id: uuid.UUID,
    thread_id: uuid.UUID,
    db: AsyncSession,
    user: User,
) -> tuple[DiscussionThread, WorkspaceItem]:
    thread = await db.get(DiscussionThread, thread_id)
    if thread is None or thread.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        )
    item = await _require_discussion_item(workspace_id, thread.item_id, db, user)
    return thread, item


async def _reindex_if_opted_in(item: WorkspaceItem) -> None:
    """Re-embed the discussion **only** when the member has opted in.

    Opt-in is the whole contract here: with ``context_enabled`` off we never
    create embeddings for team chatter at all (unlike notes, which are always
    embedded and merely filtered at query time).
    """
    if not item.context_enabled:
        return
    try:
        from app.workspaces.knowledge import index_discussion_for_workspace

        await index_discussion_for_workspace(item.workspace_id, item.id)
    except Exception:  # noqa: BLE001 — indexing must never fail a post
        logger.warning("discussion index failed", exc_info=True)


# ---------------------------------------------------------------------
# Threads
# ---------------------------------------------------------------------
@router.get(
    "/{workspace_id}/discussions/{item_id}/threads",
    response_model=list[ThreadResponse],
)
async def list_threads(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ThreadResponse]:
    """Threads in a discussion, most recently active first."""
    await get_accessible_workspace(workspace_id, user, db)
    await _require_discussion_item(workspace_id, item_id, db, user)

    counts = (
        select(
            DiscussionMessage.thread_id.label("tid"),
            func.count().label("n"),
        )
        .group_by(DiscussionMessage.thread_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(DiscussionThread, User.username, counts.c.n)
            .outerjoin(User, User.id == DiscussionThread.created_by)
            .outerjoin(counts, counts.c.tid == DiscussionThread.id)
            .where(DiscussionThread.item_id == item_id)
            .order_by(
                func.coalesce(
                    DiscussionThread.last_message_at, DiscussionThread.created_at
                ).desc()
            )
        )
    ).all()

    return [
        ThreadResponse(
            id=t.id,
            item_id=t.item_id,
            title=t.title,
            created_by=t.created_by,
            created_by_name=username or "former member",
            message_count=int(n or 0),
            last_message_at=t.last_message_at,
            created_at=t.created_at,
        )
        for t, username, n in rows
    ]


@router.post(
    "/{workspace_id}/discussions/{item_id}/threads",
    response_model=ThreadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_thread(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: ThreadCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ThreadResponse:
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    item = await _require_discussion_item(workspace_id, item_id, db, user)

    now = datetime.now(timezone.utc)
    thread = DiscussionThread(
        workspace_id=workspace_id,
        item_id=item_id,
        title=payload.title.strip()[:_MAX_TITLE],
        created_by=user.id,
    )
    db.add(thread)
    await db.flush()

    count = 0
    body = (payload.body or "").strip()
    if body:
        db.add(
            DiscussionMessage(
                thread_id=thread.id,
                workspace_id=workspace_id,
                author_user_id=user.id,
                body=body,
            )
        )
        thread.last_message_at = now
        count = 1

    await db.commit()
    await db.refresh(thread)

    if body:
        await _notify_mentions(db, ws, user, body, workspace_id, item)
        await _reindex_if_opted_in(item)

    return ThreadResponse(
        id=thread.id,
        item_id=thread.item_id,
        title=thread.title,
        created_by=thread.created_by,
        created_by_name=user.username,
        message_count=count,
        last_message_at=thread.last_message_at,
        created_at=thread.created_at,
    )


@router.delete(
    "/{workspace_id}/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_thread(
    workspace_id: uuid.UUID,
    thread_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a thread + its messages. Author or workspace admin/owner."""
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    thread, item = await _require_thread(workspace_id, thread_id, db, user)
    if thread.created_by != user.id and role not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the thread's author or a workspace admin can delete it.",
        )
    await db.delete(thread)  # messages cascade
    await db.commit()
    await _reindex_if_opted_in(item)


# ---------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------
@router.get(
    "/{workspace_id}/threads/{thread_id}/messages",
    response_model=list[MessageResponse],
)
async def list_messages(
    workspace_id: uuid.UUID,
    thread_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MessageResponse]:
    await get_accessible_workspace(workspace_id, user, db)
    await _require_thread(workspace_id, thread_id, db, user)

    rows = (
        await db.execute(
            select(DiscussionMessage, User.username)
            .outerjoin(User, User.id == DiscussionMessage.author_user_id)
            .where(DiscussionMessage.thread_id == thread_id)
            .order_by(DiscussionMessage.created_at.asc())
        )
    ).all()
    return [
        _msg_response(m, username or "former member") for m, username in rows
    ]


@router.post(
    "/{workspace_id}/threads/{thread_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    workspace_id: uuid.UUID,
    thread_id: uuid.UUID,
    payload: MessageCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    thread, item = await _require_thread(workspace_id, thread_id, db, user)

    body = payload.body.strip()
    message = DiscussionMessage(
        thread_id=thread_id,
        workspace_id=workspace_id,
        author_user_id=user.id,
        body=body,
    )
    db.add(message)
    thread.last_message_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(message)

    await _notify_mentions(db, ws, user, body, workspace_id, item, thread)
    await _reindex_if_opted_in(item)

    return _msg_response(message, user.username)


@router.delete(
    "/{workspace_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_message(
    workspace_id: uuid.UUID,
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a message. Author or workspace admin/owner."""
    _ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    message = await db.get(DiscussionMessage, message_id)
    if message is None or message.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if message.author_user_id != user.id and role not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author or a workspace admin can delete a message.",
        )
    _thread, item = await _require_thread(workspace_id, message.thread_id, db, user)
    await db.delete(message)
    await db.commit()
    await _reindex_if_opted_in(item)


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
async def _notify_mentions(
    db: AsyncSession,
    ws,  # noqa: ANN001 — Workspace row
    author: User,
    text: str,
    workspace_id: uuid.UUID,
    item: WorkspaceItem,
    thread: DiscussionThread | None = None,
) -> None:
    """Fan @-mentions out to the inbox + push. Best-effort."""
    try:
        from app.workspaces.mentions import notify_comment_mentions

        where = f'"{item.title or "a discussion"}"'
        if thread is not None:
            where = f'the "{thread.title}" thread in {where}'
        await notify_comment_mentions(
            db,
            ws=ws,
            author=author,
            text=text,
            url=f"/workspaces/{workspace_id}?item={item.id}",
            where=where,
        )
    except Exception:  # noqa: BLE001 — a mention failure must not fail the post
        logger.warning("discussion mention fan-out failed", exc_info=True)
