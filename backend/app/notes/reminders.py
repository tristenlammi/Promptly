"""Reminders on notes are tasks in your Tasks (``docs/notes-plan.md`` §4
decision 3, §6). "Remind me tomorrow 9am" on a note makes a task in your
own Tasks file — due then, with an "at the time" alert and the repeat you
chose — linked to the note both ways (``entity_links``, so the task shows
the note under Linked and the note can find its task).

**The task is the source of truth.** A ``note_reminders`` row only says
which task is this person's reminder for this note; everything shown (the
chip, the Reminders view, the filter) is read live from the task:

* done (from the push's **Done**, Tasks, Today or a widget) → no chip;
  a repeating task moves to its next day instead, so the chip moves too;
* moved or renamed in Tasks → the chip follows;
* deleted in Tasks → the row goes too (:func:`after_tasks_save`).

Reminders are each person's own: on a shared note, Sam's reminder is in
Sam's Tasks and nobody else sees it. Leaving a note (or being removed)
takes your open reminder task with it, as does deleting a note forever.

A change to a linked task tells that person's open Notes (the live
stream, after commit) so the chip clears or moves within a second.
"""
from __future__ import annotations

import copy
import logging
import uuid
from datetime import date
from typing import Any, Awaitable, Callable, Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.auth.models import User

from .models import Note, NoteReminder

logger = logging.getLogger("promptly.notes.reminders")

#: What a reminder can repeat as (the Tasks ``Repeat`` it becomes).
REPEATS = ("daily", "weekly", "monthly", "yearly")
_EVENTS_KEY = "notes_reminder_events"


class ReminderIn(BaseModel):
    due: date
    time: str | None = Field(default=None, description="HH:MM, 24-hour, your own time; none = all day")
    repeat: Literal["daily", "weekly", "monthly", "yearly"] | None = None

    @field_validator("time", mode="before")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        from app.items.kinds.tasks.models import _clock

        return _clock(v)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


async def tasks_available(db: AsyncSession) -> bool:
    from app.items.service import available_specs

    try:
        return "tasks" in await available_specs(db)
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------------------------ the Tasks file


async def _edit_tasks(
    db: AsyncSession, user: User, file_id: uuid.UUID | None, fn: Callable[[Any, Any, dict], Awaitable[Any]]
) -> tuple[uuid.UUID, Any]:
    """Change ``user``'s Tasks file in place (their primary one when
    ``file_id`` is None), the way Mail's "Add to Tasks" and Passwords do."""
    from app.items import service as items
    from app.items.registry import get_spec

    if file_id is None:
        row, _ = await items.open_app(db, user, "tasks")
        file_id = row.id
    row, doc, _ = await items.load(db, user, file_id, need="edit", lock=True)
    if doc.kind != "tasks" or row.trashed_at is not None:
        raise items.ItemNotFound()
    spec = get_spec("tasks")
    data = copy.deepcopy(doc.data)
    ctx = items.make_context(db, user, row.id, spec)
    result = await fn(ctx, spec, data)
    await items.save_data(db, user, row, doc, data, base_revision=None)
    return row.id, result


def _task_args(note: Note, r: ReminderIn) -> dict[str, Any]:
    from .service import display_title

    args: dict[str, Any] = {
        "title": display_title(note)[:500],
        "due": r.due.isoformat(),
        "time": r.time,
        "alerts": [0],
        "repeat": {"freq": r.repeat} if r.repeat else None,
    }
    return args


def _ref(file_id: uuid.UUID, task_id: str) -> tuple[str, str]:
    return ("task", f"{file_id}:{task_id}")


async def _link(db: AsyncSession, user: User, note: Note, file_id: uuid.UUID, task_id: str) -> None:
    from app.links.service import add_link

    try:
        await add_link(db, user, ("note", str(note.id)), _ref(file_id, task_id))
    except Exception:  # noqa: BLE001 — the reminder works without its link
        logger.warning("linking note %s to its task failed", note.id, exc_info=True)


async def _unlink(db: AsyncSession, note_id: uuid.UUID, file_id: uuid.UUID, task_id: str) -> None:
    from app.links.models import EntityLink
    from app.links.service import canonical

    (sk, sid), (tk, tid) = canonical(("note", str(note_id)), (_ref(file_id, task_id)[0], f"{file_id}:{task_id}"))
    await db.execute(
        delete(EntityLink).where(
            EntityLink.link_type == "link",
            EntityLink.source_kind == sk,
            EntityLink.source_id == sid,
            EntityLink.target_kind == tk,
            EntityLink.target_id == tid,
        )
    )


# ------------------------------------------------------------------ set / clear


async def set_reminder(db: AsyncSession, user: User, note: Note, r: ReminderIn) -> NoteReminder:
    """Remind ``user`` about ``note``: move their task, or make one. Flushed."""
    from app.items import service as items

    if not await tasks_available(db):
        raise _bad("Reminders use the Tasks app, which is turned off on this server.")
    row = await db.get(NoteReminder, (note.id, user.id))
    args = _task_args(note, r)

    if row is not None:
        async def move(ctx, spec, data):  # noqa: ANN001, ANN202
            t = next((x for x in data.get("tasks", []) if x.get("id") == row.task_id), None)
            if t is None or (t.get("done") and not t.get("repeat")):
                return False  # gone, or ticked off: a fresh task below
            await items.run_action(ctx, spec, data, "update_task", {"task": row.task_id, **args})
            return True

        try:
            _fid, moved = await _edit_tasks(db, user, row.tasks_file_id, move)
        except items.ItemNotFound:
            moved = False
        if moved:
            await _link(db, user, note, row.tasks_file_id, row.task_id)
            await db.flush()
            return row
        await _unlink(db, note.id, row.tasks_file_id, row.task_id)

    async def add(ctx, spec, data):  # noqa: ANN001, ANN202
        new = {k: v for k, v in args.items() if v is not None}
        new["notes"] = "A reminder from Notes. Tick it off here or from the reminder, and the note's reminder goes too."
        out = await items.run_action(ctx, spec, data, "add_tasks", {"tasks": [new]})
        return out.result[0]["id"]

    try:
        fid, tid = await _edit_tasks(db, user, None, add)
    except (items.ItemError, items.ItemNotFound) as e:
        raise _bad(str(e) or "Couldn't add the reminder to your Tasks.") from e
    if row is None:
        row = NoteReminder(note_id=note.id, user_id=user.id, tasks_file_id=fid, task_id=tid)
        db.add(row)
    else:
        row.tasks_file_id, row.task_id = fid, tid
    await db.flush()
    await _link(db, user, note, fid, tid)
    await db.flush()
    return row


async def _drop_task(db: AsyncSession, user: User, row: NoteReminder, *, open_only: bool = True) -> None:
    """Delete the reminder's task from ``user``'s Tasks (by id only — never
    a task that merely has the same title). A ticked-off task is history
    and stays, unless ``open_only`` is False."""
    from app.items import service as items

    async def drop(ctx, spec, data):  # noqa: ANN001, ANN202
        t = next((x for x in data.get("tasks", []) if x.get("id") == row.task_id), None)
        if t is None or (open_only and t.get("done")):
            return
        data["tasks"] = [x for x in data["tasks"] if x.get("id") != row.task_id]

    try:
        await _edit_tasks(db, user, row.tasks_file_id, drop)
    except (items.ItemNotFound, items.ItemError):
        pass


async def clear_reminder(db: AsyncSession, user: User, note_id: uuid.UUID) -> bool:
    """Take ``user``'s reminder off the note (and its open task out of
    their Tasks). Returns whether there was one. Flushed."""
    row = await db.get(NoteReminder, (note_id, user.id))
    if row is None:
        return False
    file_id, task_id = row.tasks_file_id, row.task_id
    await _drop_task(db, user, row)  # (the Tasks hook may already drop the row)
    await _unlink(db, note_id, file_id, task_id)
    await db.execute(delete(NoteReminder).where(NoteReminder.note_id == note_id, NoteReminder.user_id == user.id))
    await db.flush()
    return True


async def clear_for(db: AsyncSession, user_id: uuid.UUID, note_id: uuid.UUID) -> None:
    """Someone lost a note (left, removed, or it was deleted for good):
    their reminder goes with it."""
    u = await db.get(User, user_id)
    if u is None:
        await db.execute(delete(NoteReminder).where(NoteReminder.note_id == note_id, NoteReminder.user_id == user_id))
        return
    await clear_reminder(db, u, note_id)


async def clear_all(db: AsyncSession, note_ids: list[uuid.UUID]) -> None:
    """Everyone's reminders on these notes (before they're deleted for good)."""
    if not note_ids:
        return
    rows = list((await db.execute(select(NoteReminder.note_id, NoteReminder.user_id).where(NoteReminder.note_id.in_(note_ids)))).all())
    for nid, uid in rows:
        await clear_for(db, uid, nid)


# ------------------------------------------------------------------ reading (live)


def _out(file_id: uuid.UUID, t: dict, settings: dict, tz) -> dict[str, Any]:  # noqa: ANN001
    from app.items.kinds.tasks import logic as L

    m = L.moment(t, settings, tz)
    rep = t.get("repeat") or None
    return {
        "due": t.get("due"),
        "time": t.get("time"),
        "repeat": rep.get("freq") if isinstance(rep, dict) else None,
        "at": m.isoformat() if m else None,
        "task_file_id": str(file_id),
        "task_id": t["id"],
        "title": t.get("title") or "",
        "href": f"/apps/tasks/{file_id}?task={t['id']}",
    }


async def live_for(db: AsyncSession, user: User, note_ids: list[uuid.UUID] | None = None) -> dict[uuid.UUID, dict[str, Any]]:
    """``user``'s reminders on these notes (all of them when None), read
    from their tasks: only open tasks with a day count."""
    from app.items import service as items
    from app.items.service import zone_for

    stmt = select(NoteReminder).where(NoteReminder.user_id == user.id)
    if note_ids is not None:
        if not note_ids:
            return {}
        stmt = stmt.where(NoteReminder.note_id.in_(note_ids))
    rows = list((await db.execute(stmt)).scalars())
    if not rows:
        return {}
    by_file: dict[uuid.UUID, list[NoteReminder]] = {}
    for r in rows:
        by_file.setdefault(r.tasks_file_id, []).append(r)
    tz = zone_for(user)
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for fid, rs in by_file.items():
        try:
            frow, doc, _ = await items.load(db, user, fid)
        except items.ItemNotFound:
            continue
        if doc.kind != "tasks" or frow.trashed_at is not None:
            continue
        data = doc.data or {}
        tasks = {t.get("id"): t for t in data.get("tasks", [])}
        settings = data.get("settings") or {}
        for r in rs:
            t = tasks.get(r.task_id)
            if t is None or t.get("done") or not t.get("due"):
                continue
            out[r.note_id] = _out(fid, t, settings, tz)
    return out


async def live_note_ids(db: AsyncSession, user: User) -> list[uuid.UUID]:
    return list((await live_for(db, user)).keys())


# ------------------------------------------------------------------ when Tasks changes


_WATCHED = ("done", "due", "time", "repeat", "title")


async def after_tasks_save(db: AsyncSession, file_id: uuid.UUID, before: dict, after: dict) -> None:
    """A Tasks file was saved (``items.service.save_data``). For each note
    reminder in it: a deleted task drops the reminder (and its link); a
    changed one tells its person's Notes, after commit, so the chip moves
    or clears at once."""
    rows = list((await db.execute(select(NoteReminder).where(NoteReminder.tasks_file_id == file_id))).scalars())
    if not rows:
        return
    old = {t.get("id"): t for t in (before or {}).get("tasks", [])}
    new = {t.get("id"): t for t in (after or {}).get("tasks", [])}
    tell: list[tuple[str, dict]] = []
    for r in rows:
        t1 = new.get(r.task_id)
        t0 = old.get(r.task_id)
        if t1 is None:
            await _unlink(db, r.note_id, r.tasks_file_id, r.task_id)
            await db.delete(r)
        elif t0 is not None and all(t0.get(k) == t1.get(k) for k in _WATCHED):
            continue
        note = await db.get(Note, r.note_id)
        if note is not None:
            from .events import note_event

            tell.append((str(r.user_id), note_event(note)))
    await db.flush()
    if tell:
        db.sync_session.info.setdefault(_EVENTS_KEY, []).extend(tell)


def tell_after_commit(db: AsyncSession, user_ids: list[uuid.UUID], ev: dict) -> None:
    """Tell these people's Notes about ``ev`` once the caller commits
    (nothing if it rolls back). For writes that run inside someone else's
    transaction (a Meal Plan send through ``use_item``)."""
    db.sync_session.info.setdefault(_EVENTS_KEY, []).extend((str(u), ev) for u in dict.fromkeys(user_ids))


@event.listens_for(Session, "after_commit")
def _publish_after_commit(session: Session) -> None:
    pending = session.info.pop(_EVENTS_KEY, None)
    if not pending:
        return
    import asyncio

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    from app.background import spawn

    from .events import publish

    for uid, ev in pending:
        spawn(publish([uid], ev), name=f"notes-reminder-{ev.get('id')}")


@event.listens_for(Session, "after_rollback")
def _discard(session: Session) -> None:
    session.info.pop(_EVENTS_KEY, None)


# ------------------------------------------------------------------ the push's link


async def note_for_task(db: AsyncSession, user_id: uuid.UUID, file_id: uuid.UUID, task_id: str) -> uuid.UUID | None:
    """The note a reminder task belongs to (so its push opens the note)."""
    return (
        await db.execute(
            select(NoteReminder.note_id).where(
                NoteReminder.user_id == user_id, NoteReminder.tasks_file_id == file_id, NoteReminder.task_id == task_id
            )
        )
    ).scalar_one_or_none()


__all__ = [
    "REPEATS", "ReminderIn", "after_tasks_save", "clear_all", "clear_for", "clear_reminder", "live_for", "live_note_ids",
    "note_for_task", "set_reminder", "tasks_available",
]
