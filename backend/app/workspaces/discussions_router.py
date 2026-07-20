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

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import DiscussionMessage, DiscussionThread, WorkspaceItem
from app.database import get_db
from app.redis_client import redis
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
    # Profile picture for the thread starter. ``None`` when they never set
    # one (the UI falls back to an initials chip) or the account is gone.
    created_by_avatar_url: str | None = None
    created_by_avatar_color: str | None = None
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
    author_avatar_url: str | None = None
    author_avatar_color: str | None = None
    edited_at: datetime | None
    created_at: datetime


_DELETED_AUTHOR = "former member"


def _identity(author: User | None) -> tuple[str, str | None, str | None]:
    """(display name, avatar url, avatar colour) for a possibly-deleted user.

    ``avatar_url`` is a *property* that signs a URL, so it can only be read
    off a real ``User`` — which is why the list queries select the entity
    rather than just ``User.username``.
    """
    if author is None:
        return _DELETED_AUTHOR, None, None
    return author.username, author.avatar_url, author.avatar_color


def _thread_response(
    t: DiscussionThread, author: User | None, message_count: int
) -> ThreadResponse:
    name, url, color = _identity(author)
    return ThreadResponse(
        id=t.id,
        item_id=t.item_id,
        title=t.title,
        created_by=t.created_by,
        created_by_name=name,
        created_by_avatar_url=url,
        created_by_avatar_color=color,
        message_count=message_count,
        last_message_at=t.last_message_at,
        created_at=t.created_at,
    )


def _msg_response(m: DiscussionMessage, author: User | None) -> MessageResponse:
    name, url, color = _identity(author)
    return MessageResponse(
        id=m.id,
        thread_id=m.thread_id,
        body=m.body,
        author_user_id=m.author_user_id,
        author_name=name,
        author_avatar_url=url,
        author_avatar_color=color,
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
# Realtime — Redis pub/sub fan-out over SSE
# ---------------------------------------------------------------------
# Every mutation publishes a small JSON envelope on a per-item channel;
# open panes subscribe over SSE and patch their react-query caches. This
# replaces the old 6s poll (the client keeps a slow safety-net refetch so a
# dropped stream still self-heals).
#
# Fan-out is deliberately Redis pub/sub rather than in-process: pub/sub is
# fire-and-forget with no history, which is exactly right for "something
# changed, here it is" — nothing accumulates and a subscriber that isn't
# there simply misses an event and recovers on its next refetch.
_HEARTBEAT_SECONDS = 20.0


def _discussion_channel(item_id: uuid.UUID) -> str:
    return f"discussion:{item_id}"


async def _publish(item_id: uuid.UUID, event: dict) -> None:
    """Best-effort fan-out. A dead Redis must never fail a post."""
    try:
        await redis.publish(
            _discussion_channel(item_id), json.dumps(event, default=str)
        )
    except Exception:  # noqa: BLE001
        logger.warning("discussion event publish failed", exc_info=True)


async def _discussion_event_stream(
    item_id: uuid.UUID, request: Request
) -> AsyncGenerator[str, None]:
    pubsub = redis.pubsub()
    channel = _discussion_channel(item_id)
    try:
        await pubsub.subscribe(channel)
        # An immediate comment flushes headers so the client knows it's live.
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                return
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=_HEARTBEAT_SECONDS
            )
            if message is None:
                # Idle tick — keeps proxies (and our own nginx) from
                # reaping the connection.
                yield ": ping\n\n"
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            if not data:
                continue
            yield f"data: {data}\n\n"
    except asyncio.CancelledError:
        # Starlette cancels us when the client drops — nothing to salvage.
        return
    finally:
        # Always hand the pub/sub connection back; a leaked subscription
        # holds a Redis connection open for the life of the process.
        try:
            await pubsub.unsubscribe(channel)
        except Exception:  # noqa: BLE001
            pass
        try:
            closer = getattr(pubsub, "aclose", None) or pubsub.close
            await closer()
        except Exception:  # noqa: BLE001
            pass


@router.get("/{workspace_id}/discussions/{item_id}/events")
async def discussion_events(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Live feed of thread/message changes in one discussion item.

    Gated by the same read check as every other discussion endpoint, so
    losing workspace access closes the tap on the next connect.
    """
    await get_accessible_workspace(workspace_id, user, db)
    await _require_discussion_item(workspace_id, item_id, db, user)

    return StreamingResponse(
        _discussion_event_stream(item_id, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
            select(DiscussionThread, User, counts.c.n)
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
        _thread_response(t, author, int(n or 0)) for t, author, n in rows
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

    response = _thread_response(thread, user, count)
    await _publish(
        item_id,
        {
            "type": "thread_created",
            "item_id": str(item_id),
            "thread_id": str(thread.id),
            "actor_id": str(user.id),
        },
    )
    return response


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
    await _publish(
        item.id,
        {
            "type": "thread_deleted",
            "item_id": str(item.id),
            "thread_id": str(thread_id),
            "actor_id": str(user.id),
        },
    )


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
            select(DiscussionMessage, User)
            .outerjoin(User, User.id == DiscussionMessage.author_user_id)
            .where(DiscussionMessage.thread_id == thread_id)
            .order_by(DiscussionMessage.created_at.asc())
        )
    ).all()
    return [_msg_response(m, author) for m, author in rows]


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

    response = _msg_response(message, user)
    # Carry the whole message so subscribers can append without a refetch;
    # they dedupe on ``message.id``, which also makes a duplicate delivery
    # after a reconnect a no-op.
    await _publish(
        item.id,
        {
            "type": "message_created",
            "item_id": str(item.id),
            "thread_id": str(thread_id),
            "actor_id": str(user.id),
            "message": response.model_dump(mode="json"),
        },
    )
    return response


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
    thread_id = message.thread_id
    await db.delete(message)
    await db.commit()
    await _reindex_if_opted_in(item)
    await _publish(
        item.id,
        {
            "type": "message_deleted",
            "item_id": str(item.id),
            "thread_id": str(thread_id),
            "message_id": str(message_id),
            "actor_id": str(user.id),
        },
    )


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
