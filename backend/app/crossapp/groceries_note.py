"""The Meal Planner's grocery list → a note (N2.3, "Send to list").

Where it goes: the note you pick, else your Shopping/Groceries note (the one
"my shopping list" means in chat, ``notes/shopping.find_note``), else a new
checklist "Groceries", yours, kept sorted by aisle, in green. You must be able
to open the note (its owner or someone it's shared with); anything else is a
404, as everywhere in Notes. Everyone on the note sees the items arrive live.

Sending again follows the Tasks version's rules (``crossapp/groceries.py``),
for the items it sent — each carries ``note_items.ref`` = ``mp:<plan>:<week>:
<item>``:

* an item still on the list has its words ("Milk (2 L)") and aisle updated;
* ticked in the Meal Plan → ticked in the note;
* no longer on the list and not ticked → removed;
* a new week → last week's items go, ticked ones included;
* items people typed themselves (no ``ref``) are never touched.

A version of the note is kept first (reason ``send``), so the toast's Undo
restores it and Earlier versions shows it. On a list kept by aisle, new items
land in their aisle (``notes.service.add_item``).
"""
from __future__ import annotations

import hashlib
import uuid
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.items import service as items
from app.items.spec import ActionError, ActionOutcome, ItemContext

NEW_TITLE = "Groceries"
NEW_COLOR = "sage"
EMPTY = "The grocery list is empty — make it from the plan first."


def _h(raw: str, n: int) -> str:
    return hashlib.sha1(raw.encode()).hexdigest()[:n]


def plan_prefix(mealplan_id: uuid.UUID | str) -> str:
    return f"mp:{_h(str(mealplan_id), 8)}:"


def week_prefix(mealplan_id: uuid.UUID | str, start: str | None) -> str:
    return plan_prefix(mealplan_id) + _h(start or "", 6) + ":"


def ref_for(mealplan_id: uuid.UUID | str, start: str | None, key: str) -> str:
    return week_prefix(mealplan_id, start) + _h(key, 16)


class NotFound(Exception):
    pass


async def _target(db: AsyncSession, user: User, note_id: uuid.UUID | None) -> tuple[Any, bool]:
    """(note, made): the picked note, else your shopping note, else a new
    Groceries list."""
    from app.notes import access, service, shopping

    if note_id is not None:
        try:
            note = await access.load(db, user, note_id, lock=True)
        except HTTPException:
            raise NotFound() from None
        if note.kind != "list":
            raise ActionError("That note isn't a checklist. Pick a list, or show checkboxes on it first.")
        return note, False
    found = await shopping.find_note(db, user)
    if found is not None and found.kind == "list":
        return await access.load(db, user, found.id, lock=True), False
    note, _ = await service.create(db, user, note_id=None, kind="list", title=NEW_TITLE, color=NEW_COLOR, source="web")
    note.list_opts = {"aisles": True}
    from app.notes.aisles import ensure_order

    await ensure_order(db, user, note)
    await db.flush()
    return note, True


async def send(db: AsyncSession, user: User, mealplan_id: uuid.UUID, grocery: dict, note_id: uuid.UUID | None = None) -> dict:
    """Merge ``grocery`` into the target note (flushed, not committed; the
    people on the note are told after commit)."""
    from app.notes import service
    from app.notes.models import NoteItem

    from .groceries import _title

    from app.notes.aisles import order_of

    rows = [i for i in grocery.get("items") or [] if i.get("name")]
    if not any(not i.get("checked") for i in rows):
        raise ActionError(EMPTY)
    note, made = await _target(db, user, note_id)
    # In store order, so a list not kept by aisle still reads aisle by aisle.
    rank = {a: n for n, a in enumerate(order_of(note))}
    rows.sort(key=lambda i: (rank.get(i.get("aisle") or "other", len(rank)), i["name"].lower()))
    version = None if made else await service.save_version(db, note, user, reason="send")
    start = grocery.get("start")
    mine = {
        it.ref: it
        for it in (await db.execute(select(NoteItem).where(NoteItem.note_id == note.id, NoteItem.ref.like(plan_prefix(mealplan_id) + "%")))).scalars()
    }
    week = week_prefix(mealplan_id, start)
    out = {"added": 0, "updated": 0, "ticked": 0, "removed": 0}
    seen: set[str] = set()
    for item in rows:
        ref = ref_for(mealplan_id, start, item.get("key") or item["name"].lower())
        if ref in seen:
            continue
        seen.add(ref)
        it = mine.get(ref)
        aisle = item.get("aisle") if item.get("aisle") in _aisles() else "other"
        if item.get("checked"):
            if it is not None and not it.checked:
                await service.update_item(db, user, note, it.id, {"checked": True})
                out["ticked"] += 1
            continue
        text = _title(item)[:1000]
        if it is None:
            await service.add_item(db, user, note, item_id=uuid.uuid4(), text=text, aisle=aisle, ref=ref)
            out["added"] += 1
        elif not it.checked:
            want = {k: v for k, v in (("text", text), ("aisle", aisle)) if getattr(it, k) != v}
            if want:
                await service.update_item(db, user, note, it.id, want)
                out["updated"] += 1
    for ref, it in mine.items():
        if ref in seen:
            continue
        if not ref.startswith(week) or not it.checked:
            await service.delete_item(db, user, note, it.id)
            out["removed"] += 1
    if version is not None and not any(out.values()):
        await db.delete(version)  # nothing new: no version to undo to
        version = None
    await db.flush()
    from app.notes import access
    from app.notes.events import note_event
    from app.notes.reminders import tell_after_commit

    tell_after_commit(db, await access.participants(db, note), note_event(note))
    left = sum(1 for i in await service.items_of(db, note.id) if not i.checked)
    return {
        **out,
        "note_id": str(note.id),
        "title": service.display_title(note),
        "made": made,
        "version_id": str(version.id) if version is not None else None,
        "open": left,
        "href": f"/notes/n/{note.id}",
    }


def _aisles() -> dict[str, str]:
    from app.notes.aisles import AISLES

    return AISLES


def summary_of(out: dict) -> str:
    where = f"the note “{out['title']}”"
    changes = [f"{out[k]} {w}" for k, w in (("added", "added"), ("updated", "updated"), ("ticked", "ticked"), ("removed", "removed")) if out.get(k)]
    head = f"{out['open']} to buy in {where}"
    return head + (f" ({', '.join(changes)})" if changes else " (nothing new)")


async def send_to_note(db: AsyncSession, user: User, mealplan_id: uuid.UUID, note_id: uuid.UUID | None) -> dict:
    """``POST /api/crossapp/mealplan/{id}/to-note``. Commits."""
    try:
        _mrow, mdoc, _ = await items.load(db, user, mealplan_id)
    except items.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal plan not found") from None
    if mdoc.kind != "mealplan":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal plan not found")
    try:
        out = await send(db, user, mealplan_id, (mdoc.data or {}).get("grocery") or {}, note_id)
    except NotFound:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That note isn't here.") from None
    except ActionError as e:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from None
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    return {**out, "summary": summary_of(out)}


async def target_preview(db: AsyncSession, user: User) -> dict:
    """What "Send to list" would use without a pick: your shopping note
    (a list), or a new Groceries note."""
    from app.notes import shopping
    from app.notes.service import display_title

    found = await shopping.find_note(db, user)
    if found is not None and found.kind == "list":
        return {"note": {"id": str(found.id), "title": display_title(found), "shared": found.owner_id != user.id}}
    return {"note": None, "new_title": NEW_TITLE}


# ------------------------------------------------------------------ the action


class SendToNote(BaseModel):
    note_id: str | None = None


async def send_action(ctx: ItemContext, data: dict, p: SendToNote) -> ActionOutcome:
    """The Meal Planner's ``send_grocery_list_to_note`` action (the Groceries
    tab's "Send to list", and chat through ``use_item``)."""
    if ctx.file_id is None:
        raise ActionError("Open the meal plan first.")
    nid = None
    if p.note_id:
        try:
            nid = uuid.UUID(str(p.note_id))
        except ValueError:
            raise ActionError("That isn't a note id. Leave it out to use the Shopping note.") from None
    try:
        out = await send(ctx.db, ctx.user, ctx.file_id, data.get("grocery") or {}, nid)
    except NotFound:
        raise ActionError("No note with that id. Leave it out to use the Shopping note.") from None
    except HTTPException as e:
        raise ActionError(str(e.detail)) from None
    return ActionOutcome(summary=summary_of(out), result=out)


__all__ = ["EMPTY", "SendToNote", "plan_prefix", "ref_for", "send", "send_action", "send_to_note", "summary_of", "target_preview"]
