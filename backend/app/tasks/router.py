"""Scheduled Tasks CRUD + run API (Phase 1).

Every endpoint is owner-scoped via ``get_current_user``; a task belonging
to another user 404s (not 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, Message
from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.database import get_db
from app.mcp.models import McpConnector
from app.tasks.models import Task, TaskConnector, TaskRun
from app.tasks.flow_graph import FlowGraph
from app.tasks.flow_service import apply_graph, load_or_derive_graph, promote_task
from app.tasks.recurrence import compute_next_run, describe_schedule
from app.tasks.runner import execute_run
from app.tasks.schemas import (
    TaskCreate,
    TaskResponse,
    TaskRunResponse,
    TaskRunSummary,
    TaskUpdate,
)
from app.workspaces.shares import get_accessible_workspace

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


async def _connector_ids_for(
    db: AsyncSession, task_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not task_ids:
        return {}
    rows = (
        await db.execute(
            select(TaskConnector.task_id, TaskConnector.connector_id).where(
                TaskConnector.task_id.in_(task_ids)
            )
        )
    ).all()
    out: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for tid, cid in rows:
        out[tid].append(cid)
    return out


async def _set_task_connectors(
    db: AsyncSession, task_id: uuid.UUID, connector_ids: list[uuid.UUID]
) -> None:
    """Replace a task's connector set with the valid ids among ``connector_ids``."""
    await db.execute(
        delete(TaskConnector).where(TaskConnector.task_id == task_id)
    )
    if connector_ids:
        valid = set(
            (
                await db.execute(
                    select(McpConnector.id).where(
                        McpConnector.id.in_(connector_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        for cid in dict.fromkeys(connector_ids):
            if cid in valid:
                db.add(TaskConnector(task_id=task_id, connector_id=cid))


def _serialize(
    task: Task,
    latest: TaskRun | None,
    connector_ids: list[uuid.UUID] | None = None,
) -> TaskResponse:
    return TaskResponse(
        id=task.id,
        title=task.title,
        prompt=task.prompt,
        provider_id=task.provider_id,
        model_id=task.model_id,
        reasoning_effort=task.reasoning_effort,
        use_web_search=task.use_web_search,
        workspace_id=task.workspace_id,
        connector_ids=connector_ids or [],
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
        is_advanced=task.is_advanced,
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
    ids = [t.id for t in tasks]
    latest = await _latest_runs(db, ids)
    conns = await _connector_ids_for(db, ids)
    return [_serialize(t, latest.get(t.id), conns.get(t.id, [])) for t in tasks]


async def _validate_workspace(
    db: AsyncSession, user: User, workspace_id: uuid.UUID | None
) -> None:
    """Reject a workspace the user can't access (404 like the rest of tasks)."""
    if workspace_id is None:
        return
    try:
        await get_accessible_workspace(workspace_id, user, db)
    except HTTPException as e:  # normalise to 404 — don't leak existence
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        ) from e


class AvailableConnector(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    kind: str
    tool_count: int


@router.get("/connectors/available", response_model=list[AvailableConnector])
async def available_connectors(
    workspace_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AvailableConnector]:
    """Connectors this user can put on a task — global ones, plus any
    granted to them via groups/direct, plus (when a workspace is chosen)
    that workspace's restricted connectors. Mirrors the chat resolution so
    the picker never offers a connector the run couldn't actually use."""
    if workspace_id is not None:
        await _validate_workspace(db, user, workspace_id)
    from app.mcp.service import connectors_for_turn

    conns = await connectors_for_turn(
        db, user_id=user.id, workspace_id=workspace_id
    )
    return [
        AvailableConnector(
            id=c.id,
            name=c.name,
            slug=c.slug,
            kind=c.kind,
            tool_count=len(c.tool_catalog or []),
        )
        for c in conns
    ]


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

    await _validate_workspace(db, user, payload.workspace_id)

    # Default the schedule timezone to the creator's own setting when the
    # client didn't pin one (the form sends it explicitly; API/skill callers
    # may not). Falls back to the AU default if the user has none.
    timezone = (payload.timezone or "").strip()
    if not timezone:
        user_tz = (user.settings or {}).get("timezone")
        timezone = (
            user_tz.strip()
            if isinstance(user_tz, str) and user_tz.strip()
            else "Australia/Sydney"
        )

    task = Task(
        user_id=user.id,
        title=payload.title.strip(),
        prompt=payload.prompt,
        provider_id=payload.provider_id,
        model_id=payload.model_id,
        reasoning_effort=payload.reasoning_effort,
        use_web_search=payload.use_web_search,
        workspace_id=payload.workspace_id,
        frequency=payload.frequency,
        hour=payload.hour,
        minute=payload.minute,
        weekday=payload.weekday,
        day_of_month=payload.day_of_month,
        timezone=timezone,
        enabled=payload.enabled,
        notify=payload.notify,
        retention_runs=payload.retention_runs,
    )
    task.next_run_at = _compute_next(task)
    db.add(task)
    await db.flush()
    await _set_task_connectors(db, task.id, payload.connector_ids)
    await db.commit()
    await db.refresh(task)
    conns = await _connector_ids_for(db, [task.id])
    return _serialize(task, None, conns.get(task.id, []))


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    task = await _get_owned_task(task_id, user, db)
    latest = await _latest_runs(db, [task.id])
    conns = await _connector_ids_for(db, [task.id])
    return _serialize(task, latest.get(task.id), conns.get(task.id, []))


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    task = await _get_owned_task(task_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    # ``connector_ids`` is a join, not a column — handle separately.
    connector_ids = data.pop("connector_ids", None)
    if "workspace_id" in data:
        await _validate_workspace(db, user, data["workspace_id"])
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
    if connector_ids is not None:
        await _set_task_connectors(db, task.id, connector_ids)
    await db.commit()
    await db.refresh(task)
    latest = await _latest_runs(db, [task.id])
    conns = await _connector_ids_for(db, [task.id])
    return _serialize(task, latest.get(task.id), conns.get(task.id, []))


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


# ------------------------------------------------------------------
# Flow graph (Automations Phase 1) — the node-graph view of a task.
# GET derives it (Simple) or loads it (Advanced); PUT saves an edited
# graph keeping Simple/Advanced coherent; promote materialises the
# derived graph so the editor has an explicit one to work on.
# ------------------------------------------------------------------
@router.get("/{task_id}/graph", response_model=FlowGraph)
async def get_task_graph(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    task = await _get_owned_task(task_id, user, db)
    return await load_or_derive_graph(db, task)


@router.put("/{task_id}/graph", response_model=FlowGraph)
async def put_task_graph(
    task_id: uuid.UUID,
    graph: FlowGraph,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    task = await _get_owned_task(task_id, user, db)
    try:
        await apply_graph(db, task, graph)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    # The schedule may have changed — recompute the next fire time.
    task.next_run_at = _compute_next(task)
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return await load_or_derive_graph(db, task)


@router.post("/{task_id}/promote", response_model=FlowGraph)
async def promote_task_to_advanced(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    task = await _get_owned_task(task_id, user, db)
    graph = await promote_task(db, task)
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return graph


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
