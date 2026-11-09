"""Shopping lists by aisle (N2.2) — no AI, the same answer every time.

Meal Plan already knows which aisle a food is in (``items/kinds/mealplan/
foods.py::aisle_for``, 17 aisles) and each person's own store order (Meal
Plan's Kitchen view, ``preferences.aisle_order``). Notes uses both:

* **Sort by aisle** (``bulk_items`` action ``sort_aisle``) puts a list's items
  in store order, then A–Z inside an aisle; children stay under their parent.
* **Keep sorted by aisle** (``list_opts.aisles``) makes everything added later
  land in its aisle — from the web, the widgets, chat, the phone assistant, a
  family member or a Meal Plan send — instead of at the bottom. Every one of
  those goes through ``service.add_item``, which asks :func:`placement`.

The store order is the note's own (``list_opts.aisle_order``), saved from the
Meal Plan of whoever first sorted the list or turned keeping sorted on, so it
doesn't change with who adds. English food names only (that's what the food
list knows); anything it doesn't know is "Other", at the end.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.items.kinds.mealplan import foods

from .models import Note, NoteItem

AISLES: dict[str, str] = dict(foods.AISLES)
DEFAULT_ORDER: list[str] = list(foods.AISLE_ORDER)


def aisle_of(text: str) -> str:
    """The aisle for an item's words (``other`` when unsure)."""
    return foods.aisle_for(text or "") if (text or "").strip() else "other"


def clean_order(raw: Any) -> list[str]:
    """A store order: known aisle keys, each once, the missing ones after in
    the usual order."""
    if not isinstance(raw, list):
        raise ValueError("aisle_order is a list of aisles")
    out = list(dict.fromkeys(a for a in raw if isinstance(a, str) and a in AISLES))
    return out + [a for a in DEFAULT_ORDER if a not in out]


async def chooser_order(db: AsyncSession, user: User) -> list[str]:
    """This person's store order from their Meal Plan, else the usual one."""
    from app.items import service as items

    try:
        found = await items.primary_file(db, user, "mealplan")
    except Exception:  # noqa: BLE001 — no Meal Plan (or Item Store off): the usual order
        found = None
    if found is not None:
        prefs = ((found[1].data or {}).get("preferences") or {}) if isinstance(found[1].data, dict) else {}
        raw = prefs.get("aisle_order")
        if isinstance(raw, list) and raw:
            return clean_order(raw)
    return list(DEFAULT_ORDER)


def order_of(note: Note) -> list[str]:
    raw = (note.list_opts or {}).get("aisle_order")
    try:
        return clean_order(raw) if raw else list(DEFAULT_ORDER)
    except ValueError:
        return list(DEFAULT_ORDER)


async def ensure_order(db: AsyncSession, user: User, note: Note) -> list[str]:
    """The note's store order; the first time, ``user``'s (whoever chose to
    sort it). Changes ``list_opts`` without a revision bump (the caller
    bumps)."""
    if (note.list_opts or {}).get("aisle_order"):
        return order_of(note)
    order = await chooser_order(db, user)
    note.list_opts = {**(note.list_opts or {}), "aisle_order": order}
    return order


def _rank(order: list[str]) -> dict[str, int]:
    return {a: i for i, a in enumerate(order)}


def sorted_items(items: list[NoteItem], order: list[str]) -> list[NoteItem]:
    """Every item in store order: top-level items by aisle then A–Z (ticked
    ones too, so the ticked section reads the same way), each followed by
    its own items. Gives items without an aisle theirs (a child its
    parent's)."""
    rank = _rank(order)
    for i in items:
        if i.parent_id is None and not i.aisle:
            i.aisle = aisle_of(i.text)
    tops = [i for i in items if i.parent_id is None]
    by_id = {i.id: i for i in tops}
    kids: dict[uuid.UUID, list[NoteItem]] = {}
    for i in items:
        if i.parent_id is not None:
            kids.setdefault(i.parent_id, []).append(i)
            parent = by_id.get(i.parent_id)
            if parent is not None:
                i.aisle = parent.aisle
    tops.sort(key=lambda t: (rank.get(t.aisle or "other", len(rank)), t.text.casefold(), t.position))
    out = [x for t in tops for x in (t, *kids.get(t.id, []))]
    seen = {x.id for x in out}
    return out + [i for i in items if i.id not in seen]  # orphans keep their place at the end


def placement(items: list[NoteItem], aisle: str, order: list[str]) -> NoteItem | None:
    """Where a new top-level item in ``aisle`` goes on a list kept by aisle:
    after the last item (with its own items) of its aisle or of an aisle
    before it. ``None``: first on the list. Items are in position order."""
    rank = _rank(order)
    mine = rank.get(aisle, len(rank))
    last: NoteItem | None = None
    group_end: dict[uuid.UUID, NoteItem] = {}
    for i in items:
        top = i.parent_id or i.id
        group_end[top] = i
    tops = [i for i in items if i.parent_id is None]
    if not tops:
        return items[-1] if items else None
    for t in tops:
        r = rank.get(t.aisle or aisle_of(t.text), len(rank))
        if r <= mine:
            last = group_end.get(t.id, t)
    if last is None:
        return None
    return last


__all__ = ["AISLES", "DEFAULT_ORDER", "aisle_of", "chooser_order", "clean_order", "ensure_order", "order_of", "placement", "sorted_items"]
