"""Scheduled Tasks CRUD + run API (Phase 1).

Every endpoint is owner-scoped via ``get_current_user``; a task belonging
to another user 404s (not 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, Message
from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.database import get_db
from app.tasks.models import Task, TaskRun
from app.tasks.recurrence import compute_next_run, describe_schedule
from app.tasks.runner import execute_run
from app.tasks.schemas import (
    TaskCreate,
    TaskResponse,
    TaskRunResponse,
    TaskRunSummary,
    TaskUpdate,
)

router = APIRouter()

# T.4 will promote this to an admin-tunable cap; a constant keeps a
# single user from spawning unbounded background spend in the meantime.
MAX_TASKS_PER_USER = 25


async def _get_owned_task(task_id: uuid.UUID, user: User, db: AsyncSession) -> Task:
    row = await db.get(Task, task_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    return row


async def _latest_runs(
    db: AsyncSession, task_ids: list[uuid.UUID]
) -> dict[uuid.UUID, TaskRun]:
    if not task_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(TaskRun)
                .where(TaskRun.task_id.in_(task_ids))
                .order_by(TaskRun.task_id, TaskRun.created_at.desc())
                .distinct(TaskRun.task_id)
            )
        )
        .scalars()
        .all()
    )
    return {r.task_id: r for r in rows}


def _serialize(task: Task, latest: TaskRun | None) -> TaskResponse:
    return TaskResponse(
        id=task.id,
        title=task.title,
        prompt=task.prompt,
        provider_id=task.provider_id,
        model_id=task.model_id,
        reasoning_effort=task.reasoning_effort,
        use_web_search=task.use_web_search,
        frequency=task.frequency,
        hour=task.hour,
        minute=task.minute,
        weekday=task.weekday,
        day_of_month=task.day_of_month,
        timezone=task.timezone,
        schedule_label=describe_schedule(
            frequency=task.frequency,
            hour=task.hour,
            minute=task.minute,
            weekday=task.weekday,
            day_of_month=task.day_of_month,
            tz_name=task.timezone,
        ),
        enabled=task.enabled,
        notify=task.notify,
        retention_runs=task.retention_runs,
        next_run_at=task.next_run_at,
        last_run_at=task.last_run_at,
        last_status=task.last_status,
        latest_run=TaskRunSummary.model_validate(latest) if latest else None,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _compute_next(task: Task) -> datetime | None:
    if not task.enabled:
        return None
    return compute_next_run(
        frequency=task.frequency,
        after=datetime.now(timezone.utc),
        hour=task.hour,
        minute=task.minute,
        weekday=task.weekday,
        day_of_month=task.day_of_month,
        tz_name=task.timezone,
    )


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[TaskResponse]:
    tasks = (
        (
            await db.execute(
                select(Task)
                .where(Task.user_id == user.id)
                .order_by(Task.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    latest = await _latest_runs(db, [t.id for t in tasks])
    return [_serialize(t, latest.get(t.id)) for t in tasks]


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    count = (
        await db.execute(
            select(func.count(Task.id)).where(Task.user_id == user.id)
        )
    ).scalar_one()
    if count >= MAX_TASKS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"You can have at most {MAX_TASKS_PER_USER} tasks.",
        )

    task = Task(
        user_id=user.id,
        title=payload.title.strip(),
        prompt=payload.prompt,
        provider_id=payload.provider_id,
        model_id=payload.model_id,
        reasoning_effort=payload.reasoning_effort,
        use_web_search=payload.use_web_search,
        frequency=payload.frequency,
        hour=payload.hour,
        minute=payload.minute,
        weekday=payload.weekday,
        day_of_month=payload.day_of_month,
        timezone=payload.timezone,
        enabled=payload.enabled,
        notify=payload.notify,
        retention_runs=payload.retention_runs,
    )
    task.next_run_at = _compute_next(task)
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _serialize(task, None)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    task = await _get_owned_task(task_id, user, db)
    latest = await _latest_runs(db, [task.id])
    return _serialize(task, latest.get(task.id))


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    task = await _get_owned_task(task_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    schedule_keys = {
        "frequency",
        "hour",
        "minute",
        "weekday",
        "day_of_month",
        "timezone",
        "enabled",
    }
    touched_schedule = bool(schedule_keys & data.keys())
    for key, value in data.items():
        if key == "title" and value is not None:
            value = value.strip()
        setattr(task, key, value)
    if touched_schedule:
        task.next_run_at = _compute_next(task)
    await db.commit()
    await db.refresh(task)
    latest = await _latest_runs(db, [task.id])
    return _serialize(task, latest.get(task.id))


@router.delete(
    "/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_task(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    task = await _get_owned_task(task_id, user, db)
    await db.delete(task)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{task_id}/run",
    response_model=TaskRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def run_task_now(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskRunResponse:
    task = await _get_owned_task(task_id, user, db)
    run = TaskRun(task_id=task.id, status="pending", trigger="manual")
    db.add(run)
    await db.commit()
    await db.refresh(run)
    # Detached execution — the request returns immediately with a pending
    # run the client can poll.
    asyncio.create_task(execute_run(run.id), name=f"task_run_{run.id}")
    return TaskRunResponse.model_validate(run)


@router.get("/{task_id}/runs", response_model=list[TaskRunSummary])
async def list_runs(
    task_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[TaskRunSummary]:
    await _get_owned_task(task_id, user, db)
    rows = (
        (
            await db.execute(
                select(TaskRun)
                .where(TaskRun.task_id == task_id)
                .order_by(TaskRun.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    return [TaskRunSummary.model_validate(r) for r in rows]


@router.get("/{task_id}/runs/{run_id}", response_model=TaskRunResponse)
async def get_run(
    task_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskRunResponse:
    await _get_owned_task(task_id, user, db)
    run = await db.get(TaskRun, run_id)
    if run is None or run.task_id != task_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found"
        )
    return TaskRunResponse.model_validate(run)


async def _get_owned_run(
    task_id: uuid.UUID, run_id: uuid.UUID, user: User, db: AsyncSession
) -> tuple[Task, TaskRun]:
    task = await _get_owned_task(task_id, user, db)
    run = await db.get(TaskRun, run_id)
    if run is None or run.task_id != task_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found"
        )
    return task, run


@router.post("/{task_id}/runs/{run_id}/to-chat")
async def run_to_chat(
    task_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Seed a real conversation from a run so the user can follow up.

    The task prompt becomes the opening user turn and the run's report
    becomes the assistant reply, so the thread reads naturally and the
    user can keep chatting. Lineage is set so the versioning model
    (parent_id / active_leaf) stays consistent.
    """
    task, run = await _get_owned_run(task_id, run_id, user, db)
    if run.status != "success" or not run.output_markdown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a finished report can be opened in chat.",
        )

    conv = Conversation(
        user_id=user.id,
        title=task.title[:255],
        model_id=task.model_id,
        provider_id=task.provider_id,
    )
    db.add(conv)
    await db.flush()

    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=task.prompt,
        author_user_id=user.id,
    )
    db.add(user_msg)
    await db.flush()

    asst_msg = Message(
        conversation_id=conv.id,
        role="assistant",
        content=run.output_markdown,
        parent_id=user_msg.id,
        sources=run.sources or None,
        completion_tokens=run.completion_tokens,
    )
    db.add(asst_msg)
    await db.flush()

    conv.active_leaf_message_id = asst_msg.id
    await db.commit()
    return {"conversation_id": str(conv.id)}


@router.get("/{task_id}/runs/{run_id}/pdf")
async def export_run_pdf(
    task_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Render a finished run to a PDF download (reuses the chat renderer)."""
    task, run = await _get_owned_run(task_id, run_id, user, db)
    if run.status != "success" or not run.output_markdown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a finished report can be exported.",
        )
    try:
        pdf_bytes = render_markdown_to_pdf(run.output_markdown, task.title)
    except PdfRenderError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PDF rendering failed: {e}",
        ) from e

    safe = "".join(
        c if c.isalnum() or c in " -_" else "_" for c in task.title
    ).strip() or "report"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'},
    )


@router.delete(
    "/{task_id}/runs/{run_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_run(
    task_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    await _get_owned_task(task_id, user, db)
    run = await db.get(TaskRun, run_id)
    if run is None or run.task_id != task_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found"
        )
    await db.delete(run)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
