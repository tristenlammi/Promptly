"""Live structure updates for open workspaces (R-187).

The tree, overview and detail were plain queries refreshed only by the
viewer's own mutations, so a teammate's new note, rename, move or trash
stayed invisible until navigation — collaboration felt single-player.

Rather than threading a publish call through every mutation endpoint (and
forgetting the next one), a session hook notices *structural* changes —
an item, chat, pinned file, share or automation created, deleted, renamed,
moved, trashed, archived, re-shared — and, once the transaction commits,
publishes one ``{"type": "structure"}`` envelope per touched workspace on
Redis. Open workspace pages listen over SSE
(``GET /workspaces/{id}/events``) and refetch. Content edits (a note's
text, a sheet's cells) aren't structural and publish nothing — those have
their own live channels.

Pub/sub is fire-and-forget: a page that isn't listening misses nothing it
won't refetch on its next load or window focus.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncGenerator

from fastapi import Request
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

logger = logging.getLogger("promptly.workspaces.live")

_HEARTBEAT_SECONDS = 20.0
_PENDING_KEY = "promptly_ws_structure"
_BOARDS_KEY = "promptly_ws_boards"
# Board content: any change to a card or a card comment re-syncs the
# board for everyone looking at it (R-170).
_BOARD_MODELS = frozenset({"WorkspaceTask", "WorkspaceTaskComment"})

# Per model: the columns whose change alters what the navigator, overview or
# member list shows. Anything else (content, indexing status, timestamps)
# is not a structural change.
_STRUCTURAL: dict[str, frozenset[str]] = {
    "WorkspaceItem": frozenset(
        {"title", "parent_id", "position", "trashed_at", "archived_at",
         "visibility", "icon", "pinned", "is_template", "context_enabled"}
    ),
    "Conversation": frozenset(
        {"title", "workspace_id", "visibility", "archived_at", "ws_parent_id",
         "ws_position", "pinned"}
    ),
    "WorkspaceFile": frozenset({"context_enabled"}),
    "WorkspaceShare": frozenset({"status", "role"}),
    "Workspace": frozenset(
        {"title", "description", "archived_at", "trashed_at", "user_id",
         "default_model_id", "memory_mode"}
    ),
    "Task": frozenset({"title", "workspace_id", "ws_parent_id", "ws_position", "enabled"}),
}


def channel(workspace_id: uuid.UUID) -> str:
    return f"workspace:{workspace_id}"


def _workspace_of(obj) -> uuid.UUID | None:
    name = type(obj).__name__
    if name == "Workspace":
        return obj.id
    return getattr(obj, "workspace_id", None)


def _structural_change(obj) -> bool:
    cols = _STRUCTURAL.get(type(obj).__name__)
    if not cols:
        return False
    state = inspect(obj)
    for key in cols:
        try:
            attr = state.attrs[key]
        except KeyError:
            continue
        if attr.history.has_changes():
            return True
    return False


def _previous_workspace(obj) -> uuid.UUID | None:
    """A chat or automation moved out of a workspace: the one it left."""
    try:
        deleted = inspect(obj).attrs["workspace_id"].history.deleted
    except KeyError:
        return None
    return deleted[0] if deleted else None


@event.listens_for(Session, "after_flush")
def _collect(session: Session, _ctx) -> None:
    try:
        boards: set[tuple[uuid.UUID, uuid.UUID]] = session.info.setdefault(_BOARDS_KEY, set())
        for obj in list(session.new) + list(session.deleted) + list(session.dirty):
            name = type(obj).__name__
            if name not in _BOARD_MODELS:
                continue
            task = obj
            if name == "WorkspaceTaskComment":
                # Comments carry only their card — resolved after commit.
                tid = getattr(obj, "task_id", None)
                if tid is not None:
                    boards.add((None, ("task", tid)))  # type: ignore[arg-type]
                continue
            if task.workspace_id is not None and task.board_item_id is not None:
                boards.add((task.workspace_id, task.board_item_id))
        touched: set[uuid.UUID] = session.info.setdefault(_PENDING_KEY, set())
        for obj in list(session.new) + list(session.deleted):
            if type(obj).__name__ in _STRUCTURAL:
                wid = _workspace_of(obj)
                if wid is not None:
                    touched.add(wid)
        for obj in session.dirty:
            if _structural_change(obj):
                for wid in (_workspace_of(obj), _previous_workspace(obj)):
                    if wid is not None:
                        touched.add(wid)
    except Exception:  # noqa: BLE001 — never break a flush over a hint
        logger.debug("workspace live: collect failed", exc_info=True)


@event.listens_for(Session, "after_commit")
def _publish_after_commit(session: Session) -> None:
    touched = session.info.pop(_PENDING_KEY, None)
    boards = session.info.pop(_BOARDS_KEY, None)
    if not touched and not boards:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # a sync context (scripts, migrations) — nobody's listening
    from app.background import spawn
    from app.billing.usage_context import billed_user

    actor = billed_user()
    for wid in touched or ():
        spawn(publish(wid, actor), name=f"ws-live-{wid}")
    for wid, board in boards or ():
        spawn(publish_board(wid, board, actor), name=f"ws-board-{wid}")


@event.listens_for(Session, "after_rollback")
def _discard(session: Session) -> None:
    session.info.pop(_PENDING_KEY, None)
    session.info.pop(_BOARDS_KEY, None)


async def publish_board(workspace_id: uuid.UUID | None, board, actor_id=None) -> None:
    """``board`` is a board item id, or ``("task", id)`` for a comment —
    resolved to its card's workspace and board here, off the commit path."""
    from app.redis_client import redis

    board_id = board
    if isinstance(board, tuple):
        from app.chat.models import WorkspaceTask
        from app.database import SessionLocal

        async with SessionLocal() as db:
            task = await db.get(WorkspaceTask, board[1])
            if task is None:
                return
            board_id, workspace_id = task.board_item_id, task.workspace_id
        if board_id is None or workspace_id is None:
            return
    try:
        await redis.publish(
            channel(workspace_id),
            json.dumps(
                {
                    "type": "board",
                    "workspace_id": str(workspace_id),
                    "board_item_id": str(board_id),
                    "actor_id": str(actor_id) if actor_id else None,
                }
            ),
        )
    except Exception:  # noqa: BLE001
        logger.debug("workspace live: board publish failed", exc_info=True)


async def publish(workspace_id: uuid.UUID, actor_id: uuid.UUID | None = None) -> None:
    """Best-effort: a dead Redis must never fail a write."""
    from app.redis_client import redis

    try:
        await redis.publish(
            channel(workspace_id),
            json.dumps(
                {
                    "type": "structure",
                    "workspace_id": str(workspace_id),
                    "actor_id": str(actor_id) if actor_id else None,
                }
            ),
        )
    except Exception:  # noqa: BLE001
        logger.debug("workspace live: publish failed", exc_info=True)


async def event_stream(
    workspace_id: uuid.UUID, request: Request
) -> AsyncGenerator[str, None]:
    from app.redis_client import redis

    pubsub = redis.pubsub()
    ch = channel(workspace_id)
    try:
        await pubsub.subscribe(ch)
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                return
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=_HEARTBEAT_SECONDS
            )
            if message is None:
                yield ": ping\n\n"
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            if data:
                yield f"data: {data}\n\n"
    except asyncio.CancelledError:
        return
    finally:
        try:
            await pubsub.unsubscribe(ch)
        except Exception:  # noqa: BLE001
            pass
        try:
            closer = getattr(pubsub, "aclose", None) or pubsub.close
            await closer()
        except Exception:  # noqa: BLE001
            pass
