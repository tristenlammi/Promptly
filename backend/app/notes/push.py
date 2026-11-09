"""Notes' pushes — every one goes through here, in the one category ``notes``.

Only being added to a note pushes ("Sam shared 'Shopping' with you").
Changes to a shared note don't (Keep doesn't either; the grid shows a
"changed" dot instead), and reminders arrive from Tasks as
``item_reminder`` with its Done / Snooze buttons — never as ``notes``.

So ``notes`` is safe to **hold** during quiet hours: nothing time-critical
uses it. When the shared quiet-hours groundwork lands
(``notifications/quiet.py``, migration ``0272_push_quiet``), add ``"notes"``
to its set of holdable categories — that one line is all Notes needs; the
held push is collapsed by app using ``extra["app"]`` / the ``notes:`` tag
prefix below. Blocks are dropped centrally in ``dispatch`` by
``actor_user_id``, which every push here sets.
"""
from __future__ import annotations

import uuid

from app.auth.models import User

CATEGORY = "notes"


def _quote(title: str) -> str:
    t = (title or "").strip()
    if not t:
        return "a note"
    return f"“{t[:60]}{'…' if len(t) > 60 else ''}”"


async def shared_with(*, note_id: uuid.UUID, title: str, actor: User, user_ids: list[uuid.UUID]) -> None:
    """Tell each of ``user_ids`` that ``actor`` shared the note with them."""
    from app.notifications.dispatch import notify_user

    for uid in user_ids:
        await notify_user(
            user_id=uid,
            category=CATEGORY,
            title=f"{actor.username} shared {_quote(title)} with you",
            body="Open it in Notes. You can both edit it.",
            url=f"/notes/n/{note_id}",
            tag=f"notes:share:{note_id}",
            actor_user_id=actor.id,
            extra={"app": "notes", "kind": "share", "note_id": str(note_id)},
        )


__all__ = ["CATEGORY", "shared_with"]
