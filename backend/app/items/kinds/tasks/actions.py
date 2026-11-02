"""The assistant's (and normal chats') hands on a task file. Deterministic
for (data, args, ctx.now): ids derive from the inputs and the moment."""
from __future__ import annotations

import builtins
from collections import Counter
from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import logic as L
from .models import MAX_LISTS, MAX_TASKS, Repeat, Task


def _alerts_for(settings: dict, time: str | None, due: str | None, alerts: list[int] | None) -> list[int]:
    if alerts is not None:
        return alerts if due else []
    return [0] if (time and due and settings.get("alert_timed", True)) else []


def _brief(t: dict, data: dict) -> dict:
    return {"id": t["id"], "task": L.fmt_task(t, data), "done": t["done"]}


# ------------------------------------------------------------ add


class NewTask(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    notes: str = Field(default="", max_length=10_000)
    list: str | None = Field(default=None, description="List name (made if new); omit for the Inbox")
    due: date | None = Field(default=None, description="Due day, YYYY-MM-DD (the person's local day)")
    time: str | None = Field(default=None, description="Due time HH:MM, 24-hour; omit for all day")
    alerts: builtins.list[int] | None = Field(
        default=None,
        description="Reminder pushes, minutes before the due moment (0 = at the time; an all-day task's moment is the default time on the day). Omit for the default: at the time for timed tasks, none for all-day ones (the morning summary covers them).",
    )
    repeat: Repeat | None = None
    priority: int = Field(default=0, ge=0, le=3, description="0 none, 1 low, 2 medium, 3 high")
    tags: builtins.list[str] = Field(default_factory=builtins.list, max_length=20)
    steps: builtins.list[str] = Field(default_factory=builtins.list, max_length=100, description="Sub-steps (a checklist)")


class AddTasks(BaseModel):
    tasks: list[NewTask] = Field(min_length=1, max_length=100)


def add_tasks(ctx: ItemContext, data: dict, p: AddTasks) -> ActionOutcome:
    if len(data["tasks"]) + len(p.tasks) > MAX_TASKS:
        raise ActionError("This file is full — archive completed tasks first.")
    taken = {t["id"] for t in data["tasks"]}
    top = min([t.get("order", 0) for t in data["tasks"]] or [0])
    made = []
    for i, n in enumerate(p.tasks):
        tid = L.make_id("t", ctx.now.isoformat(), i, n.title, taken=taken)
        taken.add(tid)
        due = n.due.isoformat() if n.due else None
        time = n.time if due else None
        rep = n.repeat.model_dump(mode="json") if n.repeat else None
        if rep and not due:
            due = ctx.today.isoformat()
        if rep and rep["freq"] == "monthly" and not rep.get("month_day") and due:
            rep["month_day"] = int(due[8:10])
        raw = {
            "id": tid,
            "title": n.title.strip(),
            "notes": n.notes,
            "list_id": L.ensure_list(data, n.list),
            "due": due,
            "time": time,
            "alerts": _alerts_for(data["settings"], time, due, n.alerts),
            "repeat": rep,
            "priority": n.priority,
            "tags": n.tags,
            "steps": [{"id": f"{tid}s{j}", "title": s, "done": False} for j, s in enumerate(n.steps) if s.strip()],
            "created_at": ctx.now.isoformat(),
            "order": top - len(p.tasks) + i,
        }
        task = Task.model_validate(raw).model_dump(mode="json")
        data["tasks"].append(task)
        made.append(task)
    if len(made) == 1:
        summary = f"Added “{made[0]['title']}”" + (f" for {made[0]['due']}" if made[0]["due"] else "")
    else:
        summary = f"Added {len(made)} tasks"
    return ActionOutcome(summary=summary, result=[_brief(t, data) for t in made])


# ------------------------------------------------------------ edit


class UpdateTask(BaseModel):
    task: str = Field(description="Task id (or its exact title)")
    title: str | None = Field(default=None, min_length=1, max_length=500)
    notes: str | None = Field(default=None, max_length=10_000)
    list: str | None = Field(default=None, description="Move to this list (made if new); 'Inbox' for the inbox")
    due: date | None = Field(default=None, description="New due day; null clears it (also clears time, alerts, repeat)")
    time: str | None = Field(default=None, description="HH:MM; null makes it all day")
    alerts: builtins.list[int] | None = None
    repeat: Repeat | None = Field(default=None, description="New repeat rule; null stops it repeating")
    priority: int | None = Field(default=None, ge=0, le=3)
    tags: builtins.list[str] | None = Field(default=None, max_length=20)
    add_steps: builtins.list[str] = Field(default_factory=builtins.list, max_length=50)


def update_task(ctx: ItemContext, data: dict, p: UpdateTask) -> ActionOutcome:
    t = L.find_task(data, p.task)
    given = p.model_fields_set
    if "title" in given and p.title:
        t["title"] = p.title.strip()
    if "notes" in given:
        t["notes"] = p.notes or ""
    if "list" in given:
        t["list_id"] = L.ensure_list(data, None if (p.list or "").lower() == "inbox" else p.list)
    if "due" in given:
        t["due"] = p.due.isoformat() if p.due else None
        if not t["due"]:
            t["time"], t["alerts"], t["repeat"] = None, [], None
    if "time" in given:
        t["time"] = p.time if t["due"] else None
        if t["time"] and not t["alerts"] and "alerts" not in given:
            t["alerts"] = _alerts_for(data["settings"], t["time"], t["due"], None)
    if "alerts" in given:
        t["alerts"] = (p.alerts or []) if t["due"] else []
    if "repeat" in given:
        rep = p.repeat.model_dump(mode="json") if p.repeat else None
        if rep:
            if not t["due"]:
                t["due"] = ctx.today.isoformat()
            if rep["freq"] == "monthly" and not rep.get("month_day"):
                rep["month_day"] = int(t["due"][8:10])
        t["repeat"] = rep
    if "priority" in given and p.priority is not None:
        t["priority"] = p.priority
    if "tags" in given:
        t["tags"] = p.tags or []
    for j, s in enumerate(p.add_steps):
        if s.strip():
            t["steps"].append({"id": L.make_id("s", t["id"], ctx.now.isoformat(), j), "title": s.strip()[:300], "done": False})
    clean = Task.model_validate(t).model_dump(mode="json")
    t.clear()
    t.update(clean)
    return ActionOutcome(summary=f"Updated “{t['title']}”", result=_brief(t, data))


class TaskRefs(BaseModel):
    tasks: list[str] = Field(min_length=1, max_length=200, description="Task ids (or exact titles)")


class CompleteTasks(TaskRefs):
    done: bool = Field(default=True, description="False re-opens done tasks")


def complete_tasks(ctx: ItemContext, data: dict, p: CompleteTasks) -> ActionOutcome:
    out = []
    for ref in p.tasks:
        t = L.find_task(data, ref)
        if p.done:
            if t["done"]:
                continue
            what = L.complete(data, t, ctx.now)
            out.append({"id": t["id"], "title": t["title"], "result": what})
        elif t["done"]:
            L.reopen(data, t)
            out.append({"id": t["id"], "title": t["title"], "result": "reopened"})
    if not out:
        return ActionOutcome(summary="Nothing to change", result=[])
    verb = "Completed" if p.done else "Reopened"
    summary = f"{verb} “{out[0]['title']}”" if len(out) == 1 else f"{verb} {len(out)} tasks"
    return ActionOutcome(summary=summary, result=out)


class Postpone(BaseModel):
    tasks: list[str] = Field(default_factory=list, max_length=200, description="Task ids/titles; empty with overdue=true = every overdue task")
    overdue: bool = Field(default=False, description="Include every overdue open task")
    to: date | None = Field(default=None, description="Move to this day")
    days: int | None = Field(default=None, ge=1, le=3650, description="Or push each back this many days")


def postpone_tasks(ctx: ItemContext, data: dict, p: Postpone) -> ActionOutcome:
    if (p.to is None) == (p.days is None):
        raise ActionError("Give either `to` (a day) or `days`.")
    picked: dict[str, dict] = {}
    for ref in p.tasks:
        t = L.find_task(data, ref)
        picked[t["id"]] = t
    if p.overdue:
        for t in L.buckets(data, ctx.today)["overdue"]:
            picked[t["id"]] = t
    if not picked:
        raise ActionError("No tasks to move.")
    for t in picked.values():
        if p.to is not None:
            t["due"] = p.to.isoformat()
        else:
            # From its due day, or today if that's already past.
            base = max(date.fromisoformat(t["due"]), ctx.today) if t.get("due") else ctx.today
            t["due"] = (base + timedelta(days=p.days or 0)).isoformat()
    n = len(picked)
    first = next(iter(picked.values()))
    return ActionOutcome(
        summary=(f"Moved “{first['title']}” to {first['due']}" if n == 1 else f"Moved {n} tasks"),
        result=[_brief(t, data) for t in picked.values()],
    )


def delete_tasks(ctx: ItemContext, data: dict, p: TaskRefs) -> ActionOutcome:
    ids = {L.find_task(data, ref)["id"] for ref in p.tasks}
    gone = [t["title"] for t in data["tasks"] if t["id"] in ids]
    data["tasks"] = [t for t in data["tasks"] if t["id"] not in ids]
    return ActionOutcome(summary=f"Deleted “{gone[0]}”" if len(gone) == 1 else f"Deleted {len(gone)} tasks", result={"deleted": len(gone)})


# ------------------------------------------------------------ lists


class ManageList(BaseModel):
    op: Literal["create", "rename", "recolor", "delete"]
    list: str = Field(description="The list's name or id (the new name, for create)")
    name: str | None = Field(default=None, max_length=80, description="rename: the new name")
    color: str | None = Field(default=None, description="#RRGGBB")
    emoji: str | None = Field(default=None, max_length=8)
    delete_tasks: bool = Field(default=False, description="delete: also delete its tasks (default: move them to the Inbox)")


def manage_list(ctx: ItemContext, data: dict, p: ManageList) -> ActionOutcome:
    if p.op == "create":
        if L.find_list(data, p.list):
            raise ActionError(f"There's already a list called “{p.list}”.")
        if len(data["lists"]) >= MAX_LISTS:
            raise ActionError("That's the most lists a file can hold.")
        lid = L.ensure_list(data, p.list, p.color)
        lst = L.find_list(data, lid)
        if p.emoji and lst:
            lst["emoji"] = p.emoji
        return ActionOutcome(summary=f"Made the list “{p.list.strip()}”", result={"id": lid})
    lst = L.find_list(data, p.list)
    if lst is None:
        raise ActionError(f"No list called “{p.list}”. Lists: {', '.join(x['name'] for x in data['lists'])}.")
    if p.op == "delete":
        if lst["id"] == "inbox":
            raise ActionError("The Inbox can't be deleted.")
        mine = [t for t in data["tasks"] if t.get("list_id") == lst["id"]]
        if p.delete_tasks:
            data["tasks"] = [t for t in data["tasks"] if t.get("list_id") != lst["id"]]
        else:
            for t in mine:
                t["list_id"] = "inbox"
        data["lists"] = [x for x in data["lists"] if x["id"] != lst["id"]]
        what = "deleted" if p.delete_tasks else "moved to the Inbox"
        return ActionOutcome(summary=f"Deleted the list “{lst['name']}” ({len(mine)} tasks {what})", result={"tasks": len(mine)})
    if p.op == "rename":
        if not p.name or not p.name.strip():
            raise ActionError("rename needs `name`.")
        lst["name"] = p.name.strip()
    if p.color:
        lst["color"] = p.color
    if p.emoji is not None:
        lst["emoji"] = p.emoji
    return ActionOutcome(summary=f"Updated the list “{lst['name']}”", result={"id": lst["id"]})


# ------------------------------------------------------------ read-only


class FindTasks(BaseModel):
    query: str | None = Field(default=None, description="Words in the title, notes or tags")
    list: str | None = None
    tag: str | None = None
    due_from: date | None = None
    due_to: date | None = None
    include_done: bool = False
    limit: int = Field(default=50, ge=1, le=200)


def find_tasks(ctx: ItemContext, data: dict, p: FindTasks) -> ActionOutcome:
    lst = L.find_list(data, p.list) if p.list else None
    if p.list and lst is None:
        raise ActionError(f"No list called “{p.list}”.")
    q = (p.query or "").lower().split()
    out = []
    for t in sorted(data["tasks"], key=L.sort_key):
        if t["done"] and not p.include_done:
            continue
        if lst and t.get("list_id") != lst["id"]:
            continue
        if p.tag and p.tag.lstrip("#").lower() not in (x.lower() for x in t.get("tags", [])):
            continue
        if p.due_from and (not t.get("due") or t["due"] < p.due_from.isoformat()):
            continue
        if p.due_to and (not t.get("due") or t["due"] > p.due_to.isoformat()):
            continue
        hay = " ".join([t["title"], t.get("notes", ""), " ".join(t.get("tags", []))]).lower()
        if q and not all(w in hay for w in q):
            continue
        out.append(_brief(t, data))
    return ActionOutcome(summary="", result={"count": len(out), "tasks": out[: p.limit]})


class Agenda(BaseModel):
    days: int = Field(default=7, ge=1, le=60, description="How far ahead 'upcoming' looks")


def agenda(ctx: ItemContext, data: dict, p: Agenda) -> ActionOutcome:
    b = L.buckets(data, ctx.today, p.days)
    return ActionOutcome(
        summary="",
        result={
            "today": ctx.today.isoformat(),
            **{k: {"count": len(v), "tasks": [_brief(t, data) for t in v[:40]]} for k, v in b.items()},
        },
    )


class Review(BaseModel):
    days: int = Field(default=7, ge=1, le=365)


def review(ctx: ItemContext, data: dict, p: Review) -> ActionOutcome:
    since = (ctx.today - timedelta(days=p.days - 1)).isoformat()
    done = [x for x in data["log"] if x["at"][:10] >= since]
    by_day = Counter(x["at"][:10] for x in done)
    by_list = Counter(L.list_name(data, x["list_id"]) for x in done)
    b = L.buckets(data, ctx.today)
    created = sum(1 for t in data["tasks"] if (t.get("created_at") or "")[:10] >= since)
    # Tasks that keep getting pushed: open, created long ago, overdue.
    stale = [t for t in b["overdue"] if (ctx.today - date.fromisoformat(t["due"])).days >= 7]
    return ActionOutcome(
        summary="",
        result={
            "from": since,
            "to": ctx.today.isoformat(),
            "completed": len(done),
            "per_day": dict(sorted(by_day.items())),
            "per_list": dict(by_list.most_common()),
            "created": created,
            "open": sum(len(v) for v in b.values()),
            "overdue": len(b["overdue"]),
            "overdue_a_week_or_more": [_brief(t, data) for t in stale[:20]],
            "completed_titles": [x["title"] for x in done[-60:]],
        },
    )


ACTIONS = [
    ItemAction(
        "add_tasks",
        "Add one or more tasks (with due day/time, reminders, repeat, list, priority, tags, steps). Use for every 'remind me to…' / 'add…'.",
        AddTasks,
        add_tasks,
    ),
    ItemAction("update_task", "Change a task: title, notes, list, due day/time, reminders, repeat, priority, tags, or add steps. Only the fields you pass change.", UpdateTask, update_task),
    ItemAction("complete_tasks", "Tick tasks off (a repeating one moves to its next due day), or re-open them with done=false.", CompleteTasks, complete_tasks),
    ItemAction("postpone_tasks", "Move tasks to another day, or push them back N days — e.g. every overdue task to today.", Postpone, postpone_tasks),
    ItemAction("delete_tasks", "Delete tasks for good (prefer completing them).", TaskRefs, delete_tasks),
    ItemAction("manage_list", "Create, rename, recolour or delete a list.", ManageList, manage_list),
    ItemAction("find_tasks", "Search tasks by words, list, tag or due range. Returns ids.", FindTasks, find_tasks, writes=False),
    ItemAction("agenda", "What's overdue, due today, coming up, later and undated — with ids.", Agenda, agenda, writes=False),
    ItemAction("review", "What got done over the last N days (per day, per list), what's overdue and what keeps slipping.", Review, review, writes=False),
]
