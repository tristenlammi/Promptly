"""Where "my shopping list" lives (``docs/notes-plan.md`` §4 decision 5).

"Add oat milk and eggs to my shopping list", from a chat (and later the
phone assistant), goes to **your note titled Shopping or Groceries** when
you have one — your own or one shared with you, so a household list shared
per note just works — and otherwise to the **Shopping list in Tasks**
(what happened before Notes).

Which note: one you can open, not in your archive, whose title is the
shopping list's name ("Shopping", "Shopping list", "Groceries", "Grocery
list"; any case, a trailing colon or emoji is fine). A checklist beats a
text note, then the one changed most recently.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import access
from .models import Note, NoteUserState

# Titles that mean "the shopping list" (compared after :func:`_plain`).
NAMES = ("shopping", "shopping list", "groceries", "grocery list", "grocery", "groceries list", "the shopping")
# What the person might call it in a chat.
ASKED = ("shopping list", "shopping", "groceries", "grocery list", "my shopping list", "the shopping list", "grocery")
TASKS_LIST = "Shopping"


def _plain(title: str) -> str:
    t = re.sub(r"[^\w\s]", " ", (title or "").casefold())
    return re.sub(r"\s+", " ", t).strip()


def means_shopping(words: str) -> bool:
    """Whether a chat's "which note" is the shopping list."""
    return _plain(words) in {_plain(a) for a in ASKED}


async def find_note(db: AsyncSession, user: User) -> Note | None:
    """Your shopping list note, if you have one (see the module doc)."""
    names = {_plain(n) for n in NAMES}
    st = NoteUserState
    rows = list(
        (
            await db.execute(
                select(Note)
                .outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
                .where(
                    access.visible_predicate(user.id),
                    st.archived_at.is_(None),
                    func.length(Note.title) <= 40,
                    func.lower(Note.title).op("~")("(shop|grocer)"),
                )
                .order_by(Note.updated_at.desc())
                .limit(50)
            )
        ).scalars()
    )
    hits = [n for n in rows if _plain(n.title) in names]
    if not hits:
        return None
    hits.sort(key=lambda n: (n.kind != "list", -n.updated_at.timestamp()))
    return hits[0]


@dataclass
class Added:
    """Where the things went: a note (``note``), or Tasks (``tasks_file_id``)."""

    where: str  # "note" | "tasks"
    count: int
    note: Note | None = None
    tasks_file_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] = field(default_factory=list)
    # The tasks made in Tasks (Talk's "undo", phase 2).
    task_ids: list[str] = field(default_factory=list)

    def said(self) -> str:
        from .service import display_title

        what = f"{self.count} item{'' if self.count == 1 else 's'}"
        if self.where == "note" and self.note is not None:
            return f"Added {what} to the note “{display_title(self.note)}”."
        return f"Added {what} to the {TASKS_LIST} list in Tasks (there's no Shopping or Groceries note)."


async def add_items(db: AsyncSession, user: User, note: Note, texts: list[str]) -> list[uuid.UUID]:
    """Append each text as an item (a text note gets a line each). Flushed;
    the caller commits and tells the people on the note."""
    from . import body as B
    from . import service

    texts = [t.strip()[:1000] for t in texts if t and t.strip()]
    if not texts:
        return []
    if note.kind == "list":
        made: list[uuid.UUID] = []
        for t in texts:
            iid = uuid.uuid4()
            await service.add_item(db, user, note, item_id=iid, text=t)
            made.append(iid)
        return made
    doc = note.body_doc or {"type": "doc", "content": []}
    extra = (B.text_doc("\n".join(texts)) or {}).get("content") or []
    changes = await service.clean_changes({"body_doc": {"type": "doc", "content": [*doc.get("content", []), *extra]}})
    await service.patch(db, user, note, note.revision, changes)
    return []


async def add_to_tasks(db: AsyncSession, user: User, texts: list[str]) -> tuple[uuid.UUID, list[str]]:
    """Each text as a task on the Shopping list in your Tasks (made if
    missing). Returns (Tasks file id, task ids). Flushed."""
    from app.items import service as items

    from .reminders import _edit_tasks, tasks_available

    if not await tasks_available(db):
        raise items.ItemError("Tasks is turned off on this server.")

    async def add(ctx: Any, spec: Any, data: dict) -> list[str]:
        out = await items.run_action(ctx, spec, data, "add_tasks", {"tasks": [{"title": t[:500], "list": TASKS_LIST} for t in texts]})
        return [t["id"] for t in out.result or []]

    return await _edit_tasks(db, user, None, add)


async def add(db: AsyncSession, user: User, texts: list[str]) -> Added:
    """Put ``texts`` on your shopping list, wherever that is. Flushed."""
    from . import service

    texts = [t.strip() for t in texts if t and t.strip()]
    if not texts:
        raise service.bad("Nothing to add.")
    note = await find_note(db, user)
    if note is not None:
        note = await access.load(db, user, note.id, lock=True)
        ids = await add_items(db, user, note, texts)
        return Added(where="note", count=len(texts), note=note, item_ids=ids)
    fid, tids = await add_to_tasks(db, user, texts)
    return Added(where="tasks", count=len(texts), tasks_file_id=fid, task_ids=[str(t) for t in tids or []])


__all__ = ["ASKED", "Added", "NAMES", "TASKS_LIST", "add", "add_items", "add_to_tasks", "find_note", "means_shopping"]
