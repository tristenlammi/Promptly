"""The Meal Planner's grocery list → a list in Tasks ("Send to Tasks").

The list lands in *your* Tasks file as "Groceries" — one list per meal plan
(its id comes from the plan's file, so sending again updates the same list
instead of making another). Items are ordered by aisle, the aisle and the
recipes in each task's notes, amounts already merged by the grocery list in
the title ("Milk (2 L)").

Sending again:

* an item still on the list updates its task (new amount, new place);
* an item ticked off in the grocery list ticks its task;
* a task for an item that's no longer on the list goes (unless it's done);
* a new week's list starts fresh tasks (last week's done ones stay in
  Completed), and tasks you added to the list yourself are left alone.

Sharing comes from Tasks: if the person shares their Tasks file, the list
goes with it.
"""
from __future__ import annotations

import copy
import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.items import service as items
from app.items.spec import ActionError, ActionOutcome, ItemContext

LIST_NAME = "Groceries"
LIST_COLOR = "#4E9F5B"
TASK_PREFIX = "gr"


def list_id_for(mealplan_id: uuid.UUID | str) -> str:
    return "groceries-" + hashlib.sha1(str(mealplan_id).encode()).hexdigest()[:8]


def task_id_for(mealplan_id: uuid.UUID | str, start: str | None, key: str) -> str:
    return TASK_PREFIX + hashlib.sha1(f"{mealplan_id}|{start or ''}|{key}".encode()).hexdigest()[:12]


def _title(item: dict) -> str:
    from app.items.kinds.mealplan.grocery import amounts_text

    amt = amounts_text(item.get("amounts") or [])
    return (f"{item['name']} ({amt})" if amt else item["name"])[:500]


def _notes(item: dict) -> str:
    from app.items.kinds.mealplan import foods

    bits = [foods.AISLES.get(item.get("aisle") or "other", "Other")]
    if item.get("recipes"):
        bits.append("for " + ", ".join(item["recipes"][:4]))
    if item.get("note"):
        bits.append(item["note"])
    return " · ".join(bits)[:10_000]


def merge(tasks_data: dict, mealplan_id: uuid.UUID | str, grocery: dict, now_iso: str) -> dict:
    """Bring the Groceries list in ``tasks_data`` up to date with
    ``grocery`` (in place). Returns {list_id, added, updated, done, removed}."""
    from app.items.kinds.mealplan import foods

    lid = list_id_for(mealplan_id)
    lists = tasks_data.setdefault("lists", [])
    if not any(lst.get("id") == lid for lst in lists):
        lists.append({
            "id": lid, "name": LIST_NAME, "color": LIST_COLOR, "emoji": "🛒",
            "order": max([lst.get("order", 0) for lst in lists] or [0]) + 1,
        })
    tasks = tasks_data.setdefault("tasks", [])
    mine = {t["id"]: t for t in tasks if t.get("list_id") == lid and str(t.get("id", "")).startswith(TASK_PREFIX)}
    rank = {a: i for i, a in enumerate(foods.AISLE_ORDER)}
    rows = sorted(
        (i for i in grocery.get("items", []) if i.get("name")),
        key=lambda i: (rank.get(i.get("aisle") or "other", len(rank)), i["name"].lower()),
    )
    start = grocery.get("start")
    seen: set[str] = set()
    out = {"list_id": lid, "added": 0, "updated": 0, "done": 0, "removed": 0}
    for n, item in enumerate(rows):
        tid = task_id_for(mealplan_id, start, item.get("key") or item["name"].lower())
        if tid in seen:
            continue
        seen.add(tid)
        t = mine.get(tid)
        if item.get("checked"):
            if t is not None and not t.get("done"):
                t["done"], t["done_at"] = True, now_iso
                out["done"] += 1
            continue
        title, notes = _title(item), _notes(item)
        if t is None:
            tasks.append({
                "id": tid, "title": title, "notes": notes, "list_id": lid, "created_at": now_iso, "order": float(n),
            })
            out["added"] += 1
        elif not t.get("done") and (t.get("title"), t.get("notes"), t.get("order")) != (title, notes, float(n)):
            t["title"], t["notes"], t["order"] = title, notes, float(n)
            out["updated"] += 1
    stale = {tid for tid, t in mine.items() if tid not in seen and not t.get("done")}
    if stale:
        tasks_data["tasks"] = [t for t in tasks if t.get("id") not in stale]
        out["removed"] = len(stale)
    return out


class _EmptyList(Exception):
    pass


async def sync_to_tasks(db: AsyncSession, user: User, mealplan_id: uuid.UUID, grocery: dict) -> dict:
    """Merge ``grocery`` into the person's Tasks (flushed, not committed).
    Raises :class:`_EmptyList` when there's nothing to buy."""
    if not any(i.get("name") and not i.get("checked") for i in grocery.get("items", [])):
        raise _EmptyList()
    trow, _created = await items.open_app(db, user, "tasks")
    trow, tdoc, _ = await items.load(db, user, trow.id, need="edit", lock=True)
    data = copy.deepcopy(tdoc.data)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = merge(data, mealplan_id, grocery, now)
    await items.save_data(db, user, trow, tdoc, data, base_revision=None)
    open_count = sum(1 for t in data["tasks"] if t.get("list_id") == out["list_id"] and not t.get("done"))
    return {**out, "tasks_file_id": str(trow.id), "open": open_count, "href": f"/apps/tasks/{trow.id}?tab=lists"}


def summary_of(out: dict) -> str:
    bits = [f"{out['open']} to buy in Tasks → Groceries"]
    changes = [f"{out[k]} {w}" for k, w in (("added", "added"), ("updated", "updated"), ("done", "ticked"), ("removed", "removed")) if out.get(k)]
    return bits[0] + (f" ({', '.join(changes)})" if changes else "")


EMPTY = "The grocery list is empty — make it from the plan first."


async def send_to_tasks(db: AsyncSession, user: User, mealplan_id: uuid.UUID) -> dict:
    """Send the meal plan's grocery list to the person's Tasks. Commits."""
    try:
        _mrow, mdoc, _ = await items.load(db, user, mealplan_id)
    except items.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal plan not found")
    if mdoc.kind != "mealplan":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal plan not found")
    try:
        out = await sync_to_tasks(db, user, mealplan_id, (mdoc.data or {}).get("grocery") or {})
    except _EmptyList:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY)
    except (items.ItemNotFound, items.ItemError) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e) or "Tasks isn't available on this server.")
    await db.commit()
    return out


# ------------------------------------------------------------------ the action


async def send_action(ctx: ItemContext, data: dict, _p: BaseModel) -> ActionOutcome:
    """The Meal Planner's ``send_grocery_list_to_tasks`` action (the
    Groceries tab's "Send to Tasks" runs it, so pending edits land first)."""
    if ctx.file_id is None:
        raise ActionError("Open the meal plan first.")
    try:
        out = await sync_to_tasks(ctx.db, ctx.user, ctx.file_id, data.get("grocery") or {})
    except _EmptyList:
        raise ActionError(EMPTY)
    except (items.ItemNotFound, items.ItemError) as e:
        raise ActionError(str(e) or "Tasks isn't available on this server.")
    return ActionOutcome(summary=summary_of(out), result=out)
