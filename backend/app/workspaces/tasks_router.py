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

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import WorkspaceTask
from app.database import get_db
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()

_MAX_TITLE = 500


# ---------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------
class WorkspaceTaskResponse(BaseModel):
    id: uuid.UUID
    title: str
    done: bool
    position: float
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkspaceTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)


class WorkspaceTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=_MAX_TITLE)
    done: bool | None = None
    position: float | None = None


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


# ---------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/tasks", response_model=list[WorkspaceTaskResponse])
async def list_tasks(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceTask]:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    rows = list(
        (
            await db.execute(
                select(WorkspaceTask)
                .where(WorkspaceTask.workspace_id == ws.id)
                # Open tasks first (the actionable ones), then by hand order.
                .order_by(
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
    task = WorkspaceTask(
        workspace_id=ws.id,
        title=payload.title.strip(),
        position=float(max_pos or 0.0) + 1.0,
        created_by=user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


@router.patch(
    "/{workspace_id}/tasks/{task_id}", response_model=WorkspaceTaskResponse
)
async def update_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: WorkspaceTaskUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)

    if payload.title is not None:
        task.title = payload.title.strip()
    if payload.position is not None:
        task.position = payload.position
    if payload.done is not None and payload.done != task.done:
        task.done = payload.done
        # Stamp / clear the completion time as the task flips state.
        task.completed_at = (
            datetime.now(timezone.utc) if payload.done else None
        )

    await db.commit()
    await db.refresh(task)
    return task


@router.delete(
    "/{workspace_id}/tasks/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    await db.delete(task)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
