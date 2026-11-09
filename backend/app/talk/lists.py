"""Adding to a list without a yes, and "undo" (Talk phase 2, WP-T10; owner
decision 5).

"Add milk to the shopping list" runs at once: "Added milk to Shopping. Say undo
to take it off." Saying yes for every grocery is the kind of friction that
makes people stop using it, and an add is harmless and easy to take back. Only
for adds to a checklist (your Shopping note, or the Shopping list in Tasks when
you have no such note), and never on a turn that read outside content: then it
is read back and waits for a yes like any change. An add to a text note waits
for a yes too, because it can't be taken back exactly.

"Undo" ("undo that", "take it off") within :data:`UNDO_S` of the add removes
exactly the items it added, without the model.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from app.auth.models import User

logger = logging.getLogger("promptly.talk")

QUICK = frozenset({"add_to_note"})
UNDO_S = 120.0
SAY_UNDO = "Say undo to take it off."
_UNDO = re.compile(
    r"^\W*(?:(?:please|okay|ok|no)\W+)?(?:undo(?:\W+(?:that|it|this))?|take\W+(?:it|that|them|those)\W+(?:off|back(?:\W+off)?)|scratch\W+that|remove\W+(?:it|that))(?:\W+please)?\W*$",
    re.IGNORECASE,
)


def is_undo(words: str) -> bool:
    return bool(_UNDO.match(words or ""))


async def quick(user: User, args: dict[str, Any]) -> bool:
    """Can this add run without a yes? It can, unless it would go onto a text note.
    (A note that can't be found runs too: the tool then says so.)"""
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.notes import _resolve
    from app.database import SessionLocal
    from app.notes import shopping

    ref = str(args.get("note") or "").strip()
    async with SessionLocal() as db:
        me = await db.get(User, user.id)
        if me is None:
            return False
        if shopping.means_shopping(ref):
            note = await shopping.find_note(db, me)
            return note is None or note.kind == "list"
        ctx = ToolContext(db=db, user=me, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
        try:
            note = await _resolve(ctx, ref)
        except ToolError:
            return True
        return note.kind == "list"


def added_line(meta: dict[str, Any]) -> str:
    """ "Added milk and eggs to Shopping. Say undo to take it off." """
    items = [str(i).strip() for i in meta.get("items") or [] if str(i).strip()]
    title = str(meta.get("title") or "your list").strip()
    if not items:
        what = "that"
    elif len(items) <= 3:
        what = items[0] if len(items) == 1 else ", ".join(items[:-1]) + f" and {items[-1]}"
    else:
        what = f"{len(items)} things"
    tail = f" {SAY_UNDO}" if meta.get("undo") else ""
    return f"Added {what[:160]} to {title[:80]}.{tail}"


async def undo(user: User, held: dict[str, Any]) -> str:
    """Take back exactly what a quick add added. Returns what to say."""
    from app.database import SessionLocal

    info = held.get("undo") or {}
    items = [str(i) for i in info.get("items") or []]
    title = str(held.get("title") or "your list")
    names = [str(i) for i in held.get("items") or []]
    what = names[0] if len(names) == 1 else "those"
    try:
        async with SessionLocal() as db:
            me = await db.get(User, user.id)
            if me is None or not items:
                return "There's nothing to undo."
            if info.get("note"):
                from app.chat.tools.notes import _tell
                from app.chat.tools.base import ToolContext
                from app.notes import access, service

                note = await access.load(db, me, uuid.UUID(str(info["note"])), lock=True)
                for iid in items:
                    await service.delete_item(db, me, note, uuid.UUID(iid))
                await db.commit()
                await _tell(ToolContext(db=db, user=me, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={}), note)
            elif info.get("tasks"):
                from app.items import service as item_service
                from app.notes.reminders import _edit_tasks

                async def drop(ctx: Any, spec: Any, data: dict) -> None:
                    await item_service.run_action(ctx, spec, data, "delete_tasks", {"tasks": items})

                await _edit_tasks(db, me, uuid.UUID(str(info["tasks"])), drop)
                await db.commit()
            else:
                return "There's nothing to undo."
    except Exception:  # noqa: BLE001 - say so rather than pretend
        logger.exception("talk: undoing a list add failed")
        return "I couldn't undo that. You can take it off in the app."
    return f"Took {what[:120]} off {title[:80]}."
