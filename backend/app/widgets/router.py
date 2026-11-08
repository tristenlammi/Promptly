"""``/api/widgets`` — the phone's home-screen widgets (``docs/notes-plan.md`` §5, §9).

One small, reviewable surface. The phone signs in with its own app password
(``Authorization: Basic``) carrying the ``widgets`` scope, the same way the
map uses ``maps``; a normal session works too, for testing. A password
without ``widgets`` gets 403; a file or task that isn't yours is 404.

    GET  /widgets/snapshot?want=calendar,tasks,notes&days=7&someday=1&note=<id>…
         &calendar_etag=…&tasks_etag=…&notes_etag=…
    POST /widgets/tasks/complete  {client_id, file_id, task_id, due?, done?}
    POST /widgets/tasks           {client_id, title, due?: today|tomorrow|YYYY-MM-DD, list_id?}

Every write carries a ``client_id`` (one per change, made on the phone).
The answer is kept for a day under ``promptly:widget-op:<user>:<client_id>``,
so the phone's outbox can send the same change again — after a lost answer,
a reboot — and it's done once.
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.basic import client_ip, user_from_basic
from app.auth.deps import _bearer, get_current_user
from app.auth.models import User
from app.database import get_db

from . import snapshot

router = APIRouter()

SCOPE = "widgets"
OP_SECONDS = 24 * 60 * 60
_PENDING = "pending"


async def widget_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The phone's app password (scope ``widgets``), or the signed-in person."""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        return await user_from_basic(db, header, scope=SCOPE, ip=client_ip(request))
    return await get_current_user(request, credentials, db)


# ------------------------------------------------------------------ snapshot


@router.get("/snapshot")
async def get_snapshot(
    want: str = Query("calendar,tasks", max_length=60),
    days: int = Query(7, ge=1, le=snapshot.MAX_DAYS),
    someday: bool = False,
    note: list[uuid.UUID] = Query(default_factory=list),
    calendar_etag: str | None = Query(None, max_length=64),
    tasks_etag: str | None = Query(None, max_length=64),
    notes_etag: str | None = Query(None, max_length=64),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(widget_user),
) -> dict[str, Any]:
    wanted = [w for w in dict.fromkeys(x.strip() for x in want.split(",")) if w in snapshot.SECTIONS]
    if not wanted:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ask for calendar, tasks or notes.")
    have = {k: v for k, v in (("calendar", calendar_etag), ("tasks", tasks_etag), ("notes", notes_etag)) if v}
    return await snapshot.build(
        db, user, want=wanted, days=days, someday=someday, note_ids=list(dict.fromkeys(note))[: snapshot.MAX_NOTE_IDS], have=have
    )


# ------------------------------------------------------------------ safe replays


def _op_key(user: User, client_id: uuid.UUID) -> str:
    return f"promptly:widget-op:{user.id}:{client_id}"


async def _replayed(user: User, client_id: uuid.UUID) -> dict[str, Any] | None:
    """The answer already given for this change, or None after claiming it.
    A change still being made (a double send) is 409: try again shortly."""
    from app.redis_client import redis

    key = _op_key(user, client_id)
    if await redis.set(key, _PENDING, ex=60, nx=True):
        return None
    raw = await redis.get(key)
    if raw is None or raw == _PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That change is still being saved. Try again in a moment.")
    return {**json.loads(raw), "replayed": True}


async def _remember(user: User, client_id: uuid.UUID, answer: dict[str, Any]) -> None:
    from app.redis_client import redis

    await redis.set(_op_key(user, client_id), json.dumps(answer), ex=OP_SECONDS)


async def _forget(user: User, client_id: uuid.UUID) -> None:
    from app.redis_client import redis

    await redis.delete(_op_key(user, client_id))


def _gone(what: str = "That task isn't there any more.") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, what)


# ------------------------------------------------------------------ tasks


class CompleteBody(BaseModel):
    client_id: uuid.UUID
    file_id: uuid.UUID
    task_id: str = Field(min_length=1, max_length=64)
    # The day the widget showed it due: a repeating task already moved on
    # past it (ticked somewhere else) isn't ticked a second time.
    due: date | None = None
    done: bool = True


@router.post("/tasks/complete")
async def complete_task(body: CompleteBody, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        try:
            row, doc, _access = await items.load(db, user, body.file_id, need="edit", lock=True)
        except items.ItemNotFound:
            raise _gone() from None
        spec = get_spec(doc.kind)
        if spec is None or doc.kind != "tasks":
            raise _gone()
        await items.upgrade(db, doc)
        data = copy.deepcopy(doc.data)
        task = next((t for t in data.get("tasks", []) if t.get("id") == body.task_id), None)
        if task is None:
            raise _gone()
        due = body.due.isoformat() if body.due else None
        if body.done and (task.get("done") or (due and task.get("due") and task["due"] != due and task.get("repeat"))):
            answer = {"ok": True, "result": "already", "task": {"id": task["id"], "done": bool(task.get("done")), "due": task.get("due")}}
        elif not body.done and not task.get("done"):
            answer = {"ok": True, "result": "already", "task": {"id": task["id"], "done": False, "due": task.get("due")}}
        else:
            ctx = items.make_context(db, user, row.id, spec)
            try:
                out = await items.run_action(ctx, spec, data, "complete_tasks", {"tasks": [task["id"]], "done": body.done})
                await items.save_data(db, user, row, doc, data, base_revision=None)
            except (ActionError, items.ItemError) as exc:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            await db.commit()
            now = next(t for t in data["tasks"] if t["id"] == task["id"])
            answer = {"ok": True, "result": out.summary, "task": {"id": now["id"], "done": bool(now.get("done")), "due": now.get("due")}}
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    return answer


class AddBody(BaseModel):
    client_id: uuid.UUID
    title: str = Field(min_length=1, max_length=500)
    # "today" / "tomorrow" in your Promptly time zone, or the day the phone
    # meant (it sends the day it was added on, so a task queued at 11 pm
    # with no signal isn't due a day late).
    due: str | None = Field(default=None, max_length=10)
    list_id: str | None = Field(default=None, max_length=64)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Give the task a name.")
        return v

    @field_validator("due")
    @classmethod
    def _due(cls, v: str | None) -> str | None:
        if v in (None, "", "none"):
            return None
        if v in ("today", "tomorrow"):
            return v
        try:
            return date.fromisoformat(v).isoformat()
        except ValueError:
            raise ValueError("due is today, tomorrow or a date (YYYY-MM-DD).") from None


def _due_day(due: str | None, user: User) -> date | None:
    from app.items.service import zone_for

    if due is None:
        return None
    if due in ("today", "tomorrow"):
        today = datetime.now(timezone.utc).astimezone(zone_for(user)).date()
        return today + timedelta(days=1 if due == "tomorrow" else 0)
    return date.fromisoformat(due)


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def add_task(body: AddBody, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        row, _made = await items.open_app(db, user, "tasks")
        row, doc, _access = await items.load(db, user, row.id, need="edit", lock=True)
        spec = get_spec("tasks")
        await items.upgrade(db, doc)
        data = copy.deepcopy(doc.data)
        lst = None
        if body.list_id and body.list_id != "inbox":
            lst = next((x for x in data.get("lists", []) if x.get("id") == body.list_id), None)
        due = _due_day(body.due, user)
        ctx = items.make_context(db, user, row.id, spec)
        try:
            out = await items.run_action(
                ctx, spec, data, "add_tasks",
                {"tasks": [{"title": body.title, "due": due.isoformat() if due else None, "list": lst["name"] if lst else None}]},
            )
            await items.save_data(db, user, row, doc, data, base_revision=None)
        except (ActionError, items.ItemError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        await db.commit()
        made = out.result[0]
        task = next(t for t in data["tasks"] if t["id"] == made["id"])
        answer = {
            "ok": True,
            "file_id": str(row.id),
            "task": {"id": task["id"], "title": task["title"], "due": task.get("due"), "time": task.get("time"), "list_id": task.get("list_id", "inbox"), "priority": task.get("priority", 0), "repeats": bool(task.get("repeat"))},
        }
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    return answer


__all__ = ["router", "widget_user"]
