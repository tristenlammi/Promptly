"""Scheduled Tasks CRUD + run API (Phase 1).

Every endpoint is owner-scoped via ``get_current_user``; a task belonging
to another user 404s (not 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import secrets
import uuid
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Response,
    status,
)
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, Message, Workspace
from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.database import get_db
from app.mcp.models import McpConnector
from app.mcp.service import connectors_for_turn
from app.tasks.models import FlowGraphVersion, Task, TaskConnector, TaskRun
from app.tasks.flow_graph import FlowGraph
from app.tasks.flow_service import (
    apply_graph,
    load_or_derive_graph,
    promote_task,
    snapshot_flow_version,
)
from app.tasks.queue import enqueue_run
from app.tasks.recurrence import compute_next_run, describe_schedule
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


def _reindex_automations(
    background: BackgroundTasks, *workspace_ids: uuid.UUID | None
) -> None:
    """Re-embed a workspace's automations index after a task definition
    changes (Phase 10). No-op for top-level tasks (no workspace). De-dupes
    ids so a move between workspaces reindexes each side once."""
    from app.workspaces.knowledge import index_automations_for_workspace

    seen: set[uuid.UUID] = set()
    for wid in workspace_ids:
        if wid is None or wid in seen:
            continue
        seen.add(wid)
        background.add_task(index_automations_for_workspace, wid)


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
    db: AsyncSession,
    task_id: uuid.UUID,
    connector_ids: list[uuid.UUID],
    *,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID | None,
) -> None:
    """Replace a task's connector set with the ids the owner can actually reach.

    Only connectors resolvable for this owner (global, granted to them or a
    group, or attached to the task's workspace) are stored — so a caller can't
    attach a connector they were never granted (and can't use the accept/drop
    behaviour as a connector-id existence oracle). The runners re-check grants
    at run time too, so this is defense-in-depth + input hygiene."""
    await db.execute(
        delete(TaskConnector).where(TaskConnector.task_id == task_id)
    )
    if connector_ids:
        reachable = {
            c.id
            for c in await connectors_for_turn(
                db, user_id=user_id, workspace_id=workspace_id
            )
        }
        for cid in dict.fromkeys(connector_ids):
            if cid in reachable:
                db.add(TaskConnector(task_id=task_id, connector_id=cid))


def _serialize(
    task: Task,
    latest: TaskRun | None,
    connector_ids: list[uuid.UUID] | None = None,
    workspace_title: str | None = None,
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
        workspace_title=workspace_title,
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
            interval_minutes=task.interval_minutes,
            weekdays=task.weekdays,
        ),
        interval_minutes=task.interval_minutes,
        weekdays=list(task.weekdays) if task.weekdays else None,
        enabled=task.enabled,
        notify=task.notify,
        retention_runs=task.retention_runs,
        concurrency=task.concurrency,
        is_advanced=task.is_advanced,
        webhook_secret=task.webhook_secret,
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
        interval_minutes=task.interval_minutes,
        weekdays=list(task.weekdays) if task.weekdays else None,
        tz_name=task.timezone,
    )


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    scope: str = "personal",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[TaskResponse]:
    # Default scope lists personal automations only — workspace-homed ones
    # live in their workspace. ``scope=all`` adds them (with their home
    # workspace's title) so the Automations page can show everything that
    # runs on the account, grouped by home.
    q = select(Task).where(Task.user_id == user.id)
    if scope != "all":
        q = q.where(Task.workspace_id.is_(None))
    tasks = (
        (await db.execute(q.order_by(Task.created_at.desc()))).scalars().all()
    )
    ws_titles: dict[uuid.UUID, str] = {}
    ws_ids = {t.workspace_id for t in tasks if t.workspace_id is not None}
    if ws_ids:
        rows = await db.execute(
            select(Workspace.id, Workspace.title).where(Workspace.id.in_(ws_ids))
        )
        ws_titles = {wid: title for wid, title in rows.all()}
    ids = [t.id for t in tasks]
    latest = await _latest_runs(db, ids)
    conns = await _connector_ids_for(db, ids)
    return [
        _serialize(
            t,
            latest.get(t.id),
            conns.get(t.id, []),
            workspace_title=(
                ws_titles.get(t.workspace_id) if t.workspace_id else None
            ),
        )
        for t in tasks
    ]


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


class ConnectorTool(BaseModel):
    name: str
    description: str = ""


class AvailableConnector(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    kind: str
    tool_count: int
    # The connector's callable tools (A2 MCP-action picker) — honours the
    # allow-list + drops blocked destructive tools, mirroring what the AI
    # path can invoke.
    tools: list[ConnectorTool] = []


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
    from app.mcp.service import build_tools_from_connectors

    out: list[AvailableConnector] = []
    for c in conns:
        # Build the same invocable tool set the AI path would get, so the
        # MCP-action picker never offers a tool that can't actually run.
        _schemas, dispatch = build_tools_from_connectors([c])
        tools = [
            ConnectorTool(
                name=real,
                description=next(
                    (
                        (t.get("description") or "")
                        for t in (c.tool_catalog or [])
                        if t.get("name") == real
                    ),
                    "",
                )[:200],
            )
            for (_cid, real) in dispatch.values()
        ]
        out.append(
            AvailableConnector(
                id=c.id,
                name=c.name,
                slug=c.slug,
                kind=c.kind,
                tool_count=len(c.tool_catalog or []),
                tools=tools,
            )
        )
    return out


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate,
    background: BackgroundTasks,
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
        interval_minutes=payload.interval_minutes,
        weekdays=payload.weekdays,
        timezone=timezone,
        enabled=payload.enabled,
        notify=payload.notify,
        retention_runs=payload.retention_runs,
        concurrency=payload.concurrency,
    )
    task.next_run_at = _compute_next(task)
    db.add(task)
    await db.flush()
    await _set_task_connectors(
        db,
        task.id,
        payload.connector_ids,
        user_id=user.id,
        workspace_id=task.workspace_id,
    )
    await db.commit()
    await db.refresh(task)
    _reindex_automations(background, task.workspace_id)
    conns = await _connector_ids_for(db, [task.id])
    return _serialize(task, None, conns.get(task.id, []))


@router.post(
    "/{task_id}/duplicate",
    response_model=TaskResponse,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_task(
    task_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    """Copy an automation — same prompt/schedule/model/connectors/flow,
    but **paused** (enabled=False) so the copy never double-fires next to
    its source until the user has adjusted and re-enabled it."""
    src = await _get_owned_task(task_id, user, db)
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

    title = f"{src.title} (copy)"
    copy = Task(
        user_id=user.id,
        title=title[:120],
        prompt=src.prompt,
        provider_id=src.provider_id,
        model_id=src.model_id,
        reasoning_effort=src.reasoning_effort,
        use_web_search=src.use_web_search,
        workspace_id=src.workspace_id,
        frequency=src.frequency,
        hour=src.hour,
        minute=src.minute,
        weekday=src.weekday,
        day_of_month=src.day_of_month,
        interval_minutes=src.interval_minutes,
        weekdays=list(src.weekdays) if src.weekdays else None,
        timezone=src.timezone,
        enabled=False,
        notify=src.notify,
        retention_runs=src.retention_runs,
        concurrency=src.concurrency,
        flow_graph=deepcopy(src.flow_graph) if src.flow_graph else None,
    )
    copy.next_run_at = None  # paused — the scheduler ignores it until enabled
    db.add(copy)
    await db.flush()
    src_conns = await _connector_ids_for(db, [src.id])
    await _set_task_connectors(
        db,
        copy.id,
        src_conns.get(src.id, []),
        user_id=user.id,
        workspace_id=copy.workspace_id,
    )
    await db.commit()
    await db.refresh(copy)
    _reindex_automations(background, copy.workspace_id)
    conns = await _connector_ids_for(db, [copy.id])
    return _serialize(copy, None, conns.get(copy.id, []))


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
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TaskResponse:
    task = await _get_owned_task(task_id, user, db)
    old_workspace_id = task.workspace_id
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
        "interval_minutes",
        "weekdays",
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
        await _set_task_connectors(
            db,
            task.id,
            connector_ids,
            user_id=user.id,
            workspace_id=task.workspace_id,
        )
    await db.commit()
    await db.refresh(task)
    _reindex_automations(background, old_workspace_id, task.workspace_id)
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
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    task = await _get_owned_task(task_id, user, db)
    workspace_id = task.workspace_id
    await db.delete(task)
    await db.commit()
    _reindex_automations(background, workspace_id)
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
    # Durable execution — enqueue onto Arq for the worker; the request returns
    # immediately with a pending run the client can poll.
    await enqueue_run(run.id)
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
    background: BackgroundTasks,
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
    # Version history (A3): snapshot the saved graph so this edit can be undone
    # across saves. Append-then-prune; never the reason a save fails.
    await snapshot_flow_version(db, task, graph)
    # The schedule may have changed — recompute the next fire time. A flow
    # whose only trigger is a webhook (0136) must never fire on the clock:
    # the stale schedule columns are just a projection, so park next_run_at.
    from app.tasks.flow_graph import NodeType as _NT

    stored = task.flow_graph
    has_schedule_trigger = stored is None or any(
        n.get("type") == _NT.TRIGGER_SCHEDULE for n in stored.get("nodes", [])
    )
    task.next_run_at = _compute_next(task) if has_schedule_trigger else None
    # A webhook trigger needs its inbound credential minted exactly once.
    has_webhook_trigger = stored is not None and any(
        n.get("type") == _NT.TRIGGER_WEBHOOK for n in stored.get("nodes", [])
    )
    if has_webhook_trigger and not task.webhook_secret:
        task.webhook_secret = secrets.token_urlsafe(32)[:64]
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    _reindex_automations(background, task.workspace_id)
    return await load_or_derive_graph(db, task)


@router.post("/{task_id}/promote", response_model=FlowGraph)
async def promote_task_to_advanced(
    task_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    task = await _get_owned_task(task_id, user, db)
    graph = await promote_task(db, task)
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    _reindex_automations(background, task.workspace_id)
    return graph


# ------------------------------------------------------------------
# Flow version history (A3) — every graph save snapshots the graph so an
# edit can be undone across saves. List them, or restore one (which saves
# it as the current graph, itself becoming a new history entry).
# ------------------------------------------------------------------
class FlowVersionSummary(BaseModel):
    id: uuid.UUID
    summary: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


@router.get("/{task_id}/graph/versions", response_model=list[FlowVersionSummary])
async def list_flow_versions(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[FlowVersionSummary]:
    """Saved graph snapshots for this task, newest first."""
    task = await _get_owned_task(task_id, user, db)
    rows = (
        await db.execute(
            select(FlowGraphVersion)
            .where(FlowGraphVersion.task_id == task.id)
            .order_by(FlowGraphVersion.created_at.desc())
        )
    ).scalars().all()
    return [FlowVersionSummary.model_validate(r) for r in rows]


@router.post(
    "/{task_id}/graph/versions/{version_id}/restore", response_model=FlowGraph
)
async def restore_flow_version(
    task_id: uuid.UUID,
    version_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    """Restore a saved snapshot: it becomes the task's current graph (and is
    re-snapshotted so the restore itself is undoable)."""
    task = await _get_owned_task(task_id, user, db)
    version = await db.get(FlowGraphVersion, version_id)
    if version is None or version.task_id != task.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Version not found."
        )
    graph = FlowGraph.model_validate(version.graph)
    try:
        await apply_graph(db, task, graph)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    await snapshot_flow_version(db, task, graph)
    # Keep the schedule projection coherent, same as a normal save.
    from app.tasks.flow_graph import NodeType as _NT

    stored = task.flow_graph
    has_schedule_trigger = stored is None or any(
        n.get("type") == _NT.TRIGGER_SCHEDULE for n in stored.get("nodes", [])
    )
    task.next_run_at = _compute_next(task) if has_schedule_trigger else None
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    _reindex_automations(background, task.workspace_id)
    return await load_or_derive_graph(db, task)


class GraphTestRequest(BaseModel):
    """Run-to-here: execute the (possibly unsaved) graph up to ``target_node_id``
    and return each node's input/output — a build-time test, no persistence."""

    graph: FlowGraph
    target_node_id: str
    pinned: dict[str, str] = {}


@router.post("/{task_id}/graph/test")
async def test_task_graph(
    task_id: uuid.UUID,
    body: GraphTestRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Synchronously run the flow up to one node and return per-node data. Skips
    all side effects (no notes/cards/messages created, memory not written)."""
    from app.models_config.provider import ProviderError
    from app.tasks.graph_runner import run_graph_flow
    from app.tasks.runner import TaskRunError

    task = await _get_owned_task(task_id, user, db)
    try:
        _report, _sources, _usage, node_runs = await run_graph_flow(
            task=task,
            graph=body.graph,
            user=user,
            run_started_at=datetime.now(timezone.utc),
            db=db,
            stop_at=body.target_node_id,
            pinned=body.pinned,
            dry_run=True,
        )
    except (TaskRunError, ProviderError) as exc:
        return {"ok": False, "error": str(exc), "nodes": []}
    except Exception as exc:  # noqa: BLE001 — surface build errors, don't 500
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "nodes": []}
    return {"ok": True, "nodes": node_runs}


class GraphDraftRequest(BaseModel):
    """Copilot (A2): draft a flow from a plain-language description."""

    description: str


class GraphExplainRequest(BaseModel):
    graph: FlowGraph


class CopilotTextResponse(BaseModel):
    text: str


@router.post("/{task_id}/graph/draft", response_model=FlowGraph)
async def draft_task_graph(
    task_id: uuid.UUID,
    body: GraphDraftRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FlowGraph:
    """AI copilot: turn a description into a runnable flow graph. Does NOT
    persist — the editor renders it for review, the user tweaks + saves."""
    from app.tasks.copilot import CopilotError, draft_graph

    task = await _get_owned_task(task_id, user, db)
    try:
        return await draft_graph(
            db,
            user=user,
            description=body.description,
            in_workspace=task.workspace_id is not None,
        )
    except CopilotError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )


@router.post("/{task_id}/graph/explain", response_model=CopilotTextResponse)
async def explain_task_graph(
    task_id: uuid.UUID,
    body: GraphExplainRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopilotTextResponse:
    """Plain-language walkthrough of what the (possibly unsaved) flow does."""
    from app.tasks.copilot import CopilotError, explain_graph

    await _get_owned_task(task_id, user, db)
    try:
        text = await explain_graph(db, user=user, graph=body.graph)
    except CopilotError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    return CopilotTextResponse(text=text)


@router.post(
    "/{task_id}/runs/{run_id}/diagnose", response_model=CopilotTextResponse
)
async def diagnose_task_run(
    task_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopilotTextResponse:
    """Explain why a failed run failed and how to fix it."""
    from app.tasks.copilot import CopilotError, diagnose_run
    from app.tasks.models import TaskRun

    task = await _get_owned_task(task_id, user, db)
    run = await db.get(TaskRun, run_id)
    if run is None or run.task_id != task.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    graph = await load_or_derive_graph(db, task)
    try:
        text = await diagnose_run(
            db,
            user=user,
            graph=graph,
            node_runs=run.node_runs or [],
            error=run.error,
        )
    except CopilotError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    return CopilotTextResponse(text=text)


@router.get("/{task_id}/memory")
async def get_task_memory(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, dict]:
    """Stored Memory-node state for this task, keyed by node id — so the editor
    can show each Memory node's current contents on its face."""
    from app.tasks.models import AutomationNodeMemory

    await _get_owned_task(task_id, user, db)
    rows = (
        await db.execute(
            select(AutomationNodeMemory).where(
                AutomationNodeMemory.task_id == task_id
            )
        )
    ).scalars()
    return {
        r.node_id: {
            "entries": r.entries or [],
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    }


@router.delete("/{task_id}/memory/{node_id}")
async def clear_task_memory(
    task_id: uuid.UUID,
    node_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """Wipe a Memory node's stored history."""
    from sqlalchemy import delete as _delete

    from app.tasks.models import AutomationNodeMemory

    await _get_owned_task(task_id, user, db)
    await db.execute(
        _delete(AutomationNodeMemory).where(
            AutomationNodeMemory.task_id == task_id,
            AutomationNodeMemory.node_id == node_id,
        )
    )
    await db.commit()
    return {"ok": True}


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
