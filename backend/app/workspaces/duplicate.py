"""Copy a whole workspace's content into another (R-204).

Backs both "Duplicate workspace" and creating a workspace from one of your
own workspaces saved as a template. Copies what makes a setup reusable:
instructions and settings, notebooks and their pages, notes, sheets,
boards (columns, labels and cards), canvases and rosters, and the
caller's own automations (paused). Chats, discussions, comments, members
and pinned files stay behind — they're history and people, not setup.
"""
from __future__ import annotations

import logging
import uuid
from copy import deepcopy

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem
from app.workspaces.visibility import item_visible_to

logger = logging.getLogger("promptly.workspaces.duplicate")


async def copy_workspace_content(
    db: AsyncSession,
    *,
    src: Workspace,
    dest: Workspace,
    user: User,
    copy_settings: bool = True,
) -> list[tuple[str, uuid.UUID]]:
    """Copy ``src``'s content into ``dest`` (owned by ``user``). Flushes,
    doesn't commit. Returns ``(kind, item id)`` pairs to re-index."""
    from app.tasks.models import Task
    from app.workspaces.items_router import COPYABLE_KINDS, copy_item_into

    if copy_settings:
        dest.description = dest.description or src.description
        dest.system_prompt = dest.system_prompt or src.system_prompt
        if dest.default_model_id is None:
            dest.default_model_id = src.default_model_id
            dest.default_provider_id = src.default_provider_id
        dest.memory_mode = src.memory_mode
        dest.auto_memory_enabled = src.auto_memory_enabled

    items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == src.id,
                    WorkspaceItem.trashed_at.is_(None),
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.kind.in_(COPYABLE_KINDS),
                    item_visible_to(user.id),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    # Notebooks first, so their pages have somewhere to go.
    items.sort(key=lambda i: (i.kind != "container", i.parent_id is not None, i.position))
    new_ids: dict[uuid.UUID, uuid.UUID] = {}
    to_index: list[tuple[str, uuid.UUID]] = []
    for it in items:
        parent = new_ids.get(it.parent_id) if it.parent_id else None
        if it.parent_id and parent is None:
            continue  # its notebook wasn't copied (private / trashed)
        try:
            async with db.begin_nested():
                copy = await copy_item_into(
                    db,
                    it,
                    dest_ws=dest,
                    owner=user,
                    creator_id=user.id,
                    parent_id=parent,
                    position=it.position,
                    title=it.title,
                )
        except Exception:  # noqa: BLE001 — one bad item mustn't sink the copy
            logger.warning("copy of item %s (%s) failed", it.id, it.kind, exc_info=True)
            continue
        new_ids[it.id] = copy.id
        if it.kind in ("note", "sheet", "board", "canvas"):
            to_index.append((it.kind, copy.id))

    # The caller's own automations homed here — paused, so a copy never
    # double-fires next to its source.
    for t in (
        await db.execute(
            select(Task).where(Task.workspace_id == src.id, Task.user_id == user.id)
        )
    ).scalars():
        copy_task = Task(
            user_id=user.id,
            title=t.title,
            prompt=t.prompt,
            provider_id=t.provider_id,
            model_id=t.model_id,
            reasoning_effort=t.reasoning_effort,
            use_web_search=t.use_web_search,
            workspace_id=dest.id,
            frequency=t.frequency,
            hour=t.hour,
            minute=t.minute,
            weekday=t.weekday,
            day_of_month=t.day_of_month,
            interval_minutes=t.interval_minutes,
            weekdays=list(t.weekdays) if t.weekdays else None,
            timezone=t.timezone,
            enabled=False,
            notify=t.notify,
            retention_runs=t.retention_runs,
            concurrency=t.concurrency,
            flow_graph=deepcopy(t.flow_graph) if t.flow_graph else None,
        )
        copy_task.next_run_at = None
        db.add(copy_task)
    await db.flush()
    return to_index


def schedule_indexing(background, workspace_id: uuid.UUID, to_index) -> None:
    from app.workspaces.knowledge import (
        index_board_for_workspace,
        index_canvas_for_workspace,
        index_note_for_workspace,
        index_sheet_for_workspace,
    )

    fns = {
        "note": index_note_for_workspace,
        "sheet": index_sheet_for_workspace,
        "board": index_board_for_workspace,
        "canvas": index_canvas_for_workspace,
    }
    for kind, item_id in to_index:
        background.add_task(fns[kind], workspace_id, item_id)
