"""Workspace task list — a first-class, workspace-level to-do list.

Distinct from the TipTap checkboxes a note can hold (those still roll up
into the overview): a ``WorkspaceTask`` belongs to the project as a whole.
The overview "home" renders the open ones so a workspace doubles as a
lightweight planner.

    GET    /workspaces/{wid}/tasks            list (open first, then done)
    POST   /workspaces/{wid}/tasks            add a task
    PATCH  /workspaces/{wid}/tasks/{task_id}  edit title / toggle done / move
    DELETE /workspaces/{wid}/tasks/{task_id}  remove

Mounted under ``/api/workspaces`` from ``app.main``; the ``/tasks`` paths
don't collide with the core workspaces CRUD or the items router.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Response,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import WorkspaceItem, WorkspaceTask
from app.database import get_db
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()

_MAX_TITLE = 500

# ``status`` is a board *column id* — the three defaults (``todo`` /
# ``doing`` / ``done``) plus any custom columns the board defines in its
# config. Free string rather than an enum so custom columns work.
TaskStatus = str
TaskPriority = Literal["low", "medium", "high"]


async def _is_done_status(
    db: AsyncSession, board_item_id: uuid.UUID | None, status: str
) -> bool:
    """Whether ``status`` (a column id) counts as "done" for its board.

    A board's config can flag one or more columns ``done: true``; with no
    custom columns we fall back to the default ``done`` column id."""
    if board_item_id is None:
        return status == "done"
    item = await db.get(WorkspaceItem, board_item_id)
    cols = None
    if item is not None and isinstance(item.config, dict):
        cols = item.config.get("columns")
    if not cols:
        return status == "done"
    done_ids = {
        c.get("id") for c in cols if isinstance(c, dict) and c.get("done")
    }
    return status in done_ids


# ---------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------
class Subtask(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=500)
    done: bool = False


class WorkspaceTaskResponse(BaseModel):
    id: uuid.UUID
    board_item_id: uuid.UUID | None = None
    title: str
    description: str | None = None
    subtasks: list[Subtask] | None = None
    labels: list[str] | None = None
    assignee_user_id: uuid.UUID | None = None
    done: bool
    status: TaskStatus
    priority: TaskPriority
    due_at: datetime | None = None
    position: float
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkspaceTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)
    board_item_id: uuid.UUID | None = None
    status: TaskStatus = "todo"
    priority: TaskPriority = "medium"
    due_at: datetime | None = None


class WorkspaceTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=_MAX_TITLE)
    done: bool | None = None
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    # ``due_at`` is explicitly nullable: sending ``null`` clears the due
    # date, so we distinguish "field omitted" from "set to null" via
    # ``model_fields_set`` at the call site.
    due_at: datetime | None = None
    position: float | None = None
    # ``None`` clears the body; both are distinguished from "omitted" via
    # ``model_fields_set``.
    description: str | None = Field(default=None, max_length=20_000)
    subtasks: list[Subtask] | None = None
    labels: list[str] | None = None
    assignee_user_id: uuid.UUID | None = None


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
async def _load_task(
    db: AsyncSession, workspace_id: uuid.UUID, task_id: uuid.UUID
) -> WorkspaceTask:
    task = await db.get(WorkspaceTask, task_id)
    if task is None or task.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    return task


def _reindex_board(
    background: BackgroundTasks,
    workspace_id: uuid.UUID,
    board_item_id: uuid.UUID | None,
) -> None:
    """Re-embed the board's task list so it stays fresh in workspace RAG.
    No-op for tasks not attached to a board."""
    if board_item_id is None:
        return
    from app.workspaces.knowledge import index_board_for_workspace

    background.add_task(
        index_board_for_workspace, workspace_id, board_item_id
    )


# ---------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/tasks", response_model=list[WorkspaceTaskResponse])
async def list_tasks(
    workspace_id: uuid.UUID,
    board_item_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceTask]:
    """List a workspace's tasks. Scope to a single board with
    ``?board_item_id=``; omit it to count/list across all boards (the
    overview's open-task glance)."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    stmt = select(WorkspaceTask).where(WorkspaceTask.workspace_id == ws.id)
    if board_item_id is not None:
        stmt = stmt.where(WorkspaceTask.board_item_id == board_item_id)
    rows = list(
        (
            await db.execute(
                # Open tasks first (the actionable ones), then by hand order.
                stmt.order_by(
                    WorkspaceTask.done.asc(),
                    WorkspaceTask.position.asc(),
                    WorkspaceTask.created_at.asc(),
                )
            )
        ).scalars()
    )
    return rows


@router.post(
    "/{workspace_id}/tasks",
    response_model=WorkspaceTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_task(
    workspace_id: uuid.UUID,
    payload: WorkspaceTaskCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    # New task lands at the end: max(position) + 1.
    max_pos = await db.scalar(
        select(func.max(WorkspaceTask.position)).where(
            WorkspaceTask.workspace_id == ws.id
        )
    )
    is_done = await _is_done_status(db, payload.board_item_id, payload.status)
    task = WorkspaceTask(
        workspace_id=ws.id,
        board_item_id=payload.board_item_id,
        title=payload.title.strip(),
        status=payload.status,
        priority=payload.priority,
        due_at=payload.due_at,
        done=is_done,
        completed_at=datetime.now(timezone.utc) if is_done else None,
        position=float(max_pos or 0.0) + 1.0,
        created_by=user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    _reindex_board(background, ws.id, task.board_item_id)
    return task


@router.patch(
    "/{workspace_id}/tasks/{task_id}", response_model=WorkspaceTaskResponse
)
async def update_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: WorkspaceTaskUpdate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    sent = payload.model_fields_set

    if payload.title is not None:
        task.title = payload.title.strip()
    if payload.position is not None:
        task.position = payload.position
    if payload.priority is not None:
        task.priority = payload.priority
    if "due_at" in sent:
        task.due_at = payload.due_at  # may be None to clear it
    if "description" in sent:
        desc = (payload.description or "").strip()
        task.description = desc or None
    if "subtasks" in sent:
        task.subtasks = (
            [s.model_dump() for s in payload.subtasks]
            if payload.subtasks
            else None
        )
    if "labels" in sent:
        task.labels = list(payload.labels) if payload.labels else None
    if "assignee_user_id" in sent:
        task.assignee_user_id = payload.assignee_user_id  # None clears it

    # ``status`` (a column id) is the board's source of truth; ``done`` is
    # the legacy boolean kept in lockstep — derived from whether the target
    # column is flagged done in the board config.
    if payload.status is not None and payload.status != task.status:
        task.status = payload.status
        task.done = await _is_done_status(
            db, task.board_item_id, payload.status
        )
        task.completed_at = (
            datetime.now(timezone.utc) if task.done else None
        )
    elif payload.done is not None and payload.done != task.done:
        # Legacy boolean toggle (no column move).
        task.done = payload.done
        task.completed_at = (
            datetime.now(timezone.utc) if payload.done else None
        )

    await db.commit()
    await db.refresh(task)
    _reindex_board(background, ws.id, task.board_item_id)
    return task


@router.delete(
    "/{workspace_id}/tasks/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    board_item_id = task.board_item_id
    await db.delete(task)
    await db.commit()
    _reindex_board(background, ws.id, board_item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
