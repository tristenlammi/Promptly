"""Notes on a person page (N2.5): "the notes you and Sam both have".

Only notes **both** people can open (each is the owner or someone it's shared
with), not trashed, newest first, at most 12. The viewer can already open
every one of them and already sees who is on each in its share list, so this
tells them nothing new: never a note only Sam can open, and nothing about
Sam's own notes. Registered with ``people/sections.py``.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import sections

from . import access
from .models import Note, NoteItem
from .service import display_title, users_map

MAX = 12


async def shared_between(db: AsyncSession, viewer: User, target: User, limit: int = MAX) -> list[Note]:
    return list(
        (
            await db.execute(
                select(Note)
                .where(access.visible_predicate(viewer.id), access.visible_predicate(target.id))
                .order_by(Note.updated_at.desc(), Note.id)
                .limit(limit)
            )
        ).scalars()
    )


async def section(db: AsyncSession, viewer: User, target: User) -> dict[str, Any]:
    if viewer.id == target.id:
        return {"items": []}
    notes = await shared_between(db, viewer, target)
    if not notes:
        return {"items": []}
    lists = [n.id for n in notes if n.kind == "list"]
    left: dict = {}
    if lists:
        left = dict(
            (
                await db.execute(
                    select(NoteItem.note_id, func.count()).where(NoteItem.note_id.in_(lists), NoteItem.checked.is_(False)).group_by(NoteItem.note_id)
                )
            ).all()
        )
    people = await users_map(db, {n.owner_id for n in notes})
    items = []
    for n in notes:
        owner = "You" if n.owner_id == viewer.id else (people.get(str(n.owner_id)) or {}).get("username") or "Someone"
        bits = [f"{left.get(n.id, 0)} left" if n.kind == "list" else None, f"{owner}'s" if owner != "You" else "Yours"]
        items.append({
            "id": str(n.id),
            "title": display_title(n),
            "subtitle": " · ".join(b for b in bits if b),
            "kind": n.kind,
            "color": n.color,
            "owner": owner,
            "href": f"/notes/n/{n.id}",
        })
    return {"items": items, "more_url": f"/notes?with={target.id}"}


sections.register("notes", "Notes", section, order=50, kind="grid")

__all__ = ["MAX", "section", "shared_between"]
