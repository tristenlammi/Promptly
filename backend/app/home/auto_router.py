"""A home's automations (``/api/home/{home}/automations``).

Everyone in the home sees them, can run one and can see how its runs went.
Making, changing and deleting them is for whoever looks after the home
(``access.py``). Nobody outside the home gets anything but a 404, an admin
included.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.tasks.flow_graph import FlowGraph
from app.tasks.models import Task, TaskRun

from . import access, assistant, automations, relay
from .models import Home, HomeBox
from .router import _on

router = APIRouter()


async def _limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("120/minute"), bucket="home_auto")(request)


AUTO = [Depends(_on), Depends(_limit)]


async def _role(db: AsyncSession, user: User, home_id: uuid.UUID) -> str:
    role = await access.role_in(db, user.id, home_id)
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Home not found")
    return role


async def _manager(db: AsyncSession, user: User, home_id: uuid.UUID) -> None:
    if not access.manages(await _role(db, user, home_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, access.ONLY_MANAGER)


async def _task(db: AsyncSession, home_id: uuid.UUID, auto_id: uuid.UUID) -> Task:
    row = await db.get(Task, auto_id)
    if row is None or row.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation not found")
    return row


def _run_out(run: TaskRun, *, steps: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(run.id),
        "status": run.status,
        "trigger": run.trigger,
        "started_at": (run.started_at or run.created_at).isoformat() if (run.started_at or run.created_at) else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "error": run.error,
    }
    if steps:
        out["steps"] = [
            {"node_id": r.get("node_id"), "status": r.get("status"), "text": str(r.get("output") or "")[:300]}
            for r in (run.node_runs or [])
            if not str(r.get("type") or "").startswith("trigger.") and r.get("status") != "skipped"
        ]
    return out


def _out(task: Task, latest: TaskRun | None, can_edit: bool, *, graph: bool = False) -> dict[str, Any]:
    g = automations.graph_of(task)
    kind, words = automations.trigger_words(g)
    out: dict[str, Any] = {
        "id": str(task.id),
        "name": task.title,
        "phrases": list(task.phrases or []),
        "enabled": bool(task.enabled),
        "trigger": {"kind": kind, "words": words},
        "steps": automations.steps_in(g),
        "next_run_at": task.next_run_at.isoformat() if task.next_run_at else None,
        "last": _run_out(latest) if latest is not None else None,
        "can_edit": can_edit,
    }
    if graph:
        out["graph"] = g.model_dump(mode="json")
    return out


async def _latest(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, TaskRun]:
    if not ids:
        return {}
    rows = (
        await db.execute(select(TaskRun).where(TaskRun.task_id.in_(ids)).order_by(TaskRun.task_id, TaskRun.created_at.desc()).distinct(TaskRun.task_id))
    ).scalars().all()
    return {r.task_id: r for r in rows}


@router.get("/{home_id}/automations", dependencies=AUTO)
async def list_automations(home_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    role = await _role(db, user, home_id)
    rows = (await db.execute(select(Task).where(Task.home_id == home_id).order_by(func.lower(Task.title)))).scalars().all()
    latest = await _latest(db, [t.id for t in rows])
    can_edit = access.manages(role)
    return {"can_edit": can_edit, "automations": [_out(t, latest.get(t.id), can_edit) for t in rows]}


class NewBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    timezone: str = Field(default="", max_length=64)


@router.post("/{home_id}/automations", dependencies=AUTO, status_code=status.HTTP_201_CREATED)
async def create_automation(home_id: uuid.UUID, body: NewBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    await _manager(db, user, home_id)
    name = " ".join(body.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Give it a name.")
    count = await db.scalar(select(func.count(Task.id)).where(Task.home_id == home_id))
    if int(count or 0) >= automations.MAX_PER_HOME:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"A home can have {automations.MAX_PER_HOME} automations. Delete one you no longer use.")
    home = await db.get(Home, home_id)
    assert home is not None
    task = Task(
        # It runs as the home's owner, so it goes with the home, not with
        # whoever happened to make it.
        user_id=home.owner_id,
        home_id=home_id,
        title=name[:80],
        prompt="",
        frequency="daily",
        hour=7,
        minute=0,
        timezone=_zone(body.timezone, user),
        # Off until it has something to do: saving its first steps turns it on.
        enabled=False,
        notify=False,
        notify_mode="never",
        retention_runs=automations.RUNS_KEPT,
        flow_graph=automations.blank_graph(),
        phrases=[],
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    relay.bump(home_id)
    return _out(task, None, True, graph=True)


def _zone(given: str, user: User) -> str:
    from zoneinfo import ZoneInfo

    for name in (given, str((getattr(user, "settings", None) or {}).get("timezone") or ""), "Australia/Sydney"):
        try:
            if name:
                ZoneInfo(name)
                return name
        except Exception:  # noqa: BLE001
            continue
    return "UTC"


@router.get("/{home_id}/automations/{auto_id}", dependencies=AUTO)
async def get_automation(home_id: uuid.UUID, auto_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    role = await _role(db, user, home_id)
    task = await _task(db, home_id, auto_id)
    latest = await _latest(db, [task.id])
    return _out(task, latest.get(task.id), access.manages(role), graph=True)


class SaveBody(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    phrases: list[str] | None = None
    enabled: bool | None = None
    graph: FlowGraph | None = None
    timezone: str = Field(default="", max_length=64)


@router.put("/{home_id}/automations/{auto_id}", dependencies=AUTO)
async def save_automation(
    home_id: uuid.UUID, auto_id: uuid.UUID, body: SaveBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _manager(db, user, home_id)
    task = await _task(db, home_id, auto_id)
    try:
        if body.name is not None:
            name = " ".join(body.name.split())
            if not name:
                raise automations.Problem("Give it a name.")
            task.title = name[:80]
        if body.phrases is not None:
            phrases = automations.clean_phrases(body.phrases)
            taken = await automations.clash(db, home_id, phrases, but=task.id)
            if taken:
                raise automations.Problem(taken)
            task.phrases = phrases
        first = False
        if body.graph is not None:
            checked = await automations.validate(db, home_id, body.graph, tz_default=_zone(body.timezone, user) if body.timezone else task.timezone)
            first = automations.steps_in(automations.graph_of(task)) < 1
            from app.tasks.flow_service import snapshot_flow_version

            await snapshot_flow_version(db, task, checked)
            automations.apply(task, checked)
        if body.enabled is not None:
            task.enabled = bool(body.enabled)
        elif first:
            task.enabled = True
        if task.enabled and automations.steps_in(automations.graph_of(task)) < 1:
            raise automations.Problem("Add at least one thing for it to do before switching it on.")
        # The schedule follows the switch.
        automations.apply(task, automations.graph_of(task))
    except automations.Problem as e:
        await db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    relay.bump(home_id)
    latest = await _latest(db, [task.id])
    return _out(task, latest.get(task.id), True, graph=True)


@router.delete("/{home_id}/automations/{auto_id}", dependencies=AUTO)
async def delete_automation(home_id: uuid.UUID, auto_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _manager(db, user, home_id)
    task = await _task(db, home_id, auto_id)
    await db.delete(task)
    await db.commit()
    automations.forget(home_id)
    relay.bump(home_id)
    return {"ok": True}


@router.post("/{home_id}/automations/{auto_id}/run", dependencies=AUTO)
async def run_automation(home_id: uuid.UUID, auto_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Anyone in the home, switched on or not (trying one out)."""
    await _role(db, user, home_id)
    task = await _task(db, home_id, auto_id)
    try:
        run = await automations.run_now(db, task, "manual", wait=3.0)
    except automations.Problem as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    ok, words = automations.result_words(task.title, run)
    return {"ok": ok, "words": words, "run": _run_out(run, steps=True)}


@router.get("/{home_id}/automations/{auto_id}/runs", dependencies=AUTO)
async def runs(
    home_id: uuid.UUID, auto_id: uuid.UUID, limit: int = Query(default=10, ge=1, le=30), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _role(db, user, home_id)
    task = await _task(db, home_id, auto_id)
    rows = (await db.execute(select(TaskRun).where(TaskRun.task_id == task.id).order_by(TaskRun.created_at.desc()).limit(limit))).scalars().all()
    return {"runs": [_run_out(r, steps=True) for r in rows]}


@router.get("/{home_id}/automations-music", dependencies=AUTO)
async def find_music(
    home_id: uuid.UUID,
    box_id: uuid.UUID,
    q: str = Query(min_length=1, max_length=120),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Music to pick for a "play music" step, from the home's own service."""
    await _manager(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id or box.revoked_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Home not found")
    # Nothing of ours holds a database connection while the box is asked.
    await db.commit()
    from . import music

    try:
        found = await assistant.music_search(box.id, q.strip())
    except assistant.CantDo as e:
        text = str(e)
        raise HTTPException(status.HTTP_409_CONFLICT, music.NOT_LINKED if "No music service" in text else text) from e
    return {"results": [{"uri": r["uri"], "kind": r["kind"], "words": music.describe(r)} for r in found[: music.MAX_OPTIONS]]}
