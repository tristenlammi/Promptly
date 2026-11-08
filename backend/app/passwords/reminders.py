"""Expiry reminders: a Calendar event and/or a task for an item's expiry date.

The vault is end-to-end encrypted, so the server can't see an item's date. The
person's device sends it, with a short label, only when they turn a reminder on, and
again when the date changes. What it sends is exactly what Calendar and Tasks show,
and they can edit it there.

Linked by the item's id, which the server already knows. When the item is deleted,
its vault goes, or the person loses access, the event and task go too: straight away
for a delete that passes through sync, and on the hourly sweep for the rest.
"""
from __future__ import annotations

import copy
import logging
import re
import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.passwords import schemas as s
from app.passwords import service
from app.passwords.reminder_models import PwReminder
from app.passwords.deps import VaultSession, parse_uuid, require_enabled, require_session
from app.passwords.models import PwItem
from app.passwords.router import _QuietRoute

logger = logging.getLogger("promptly.passwords.reminders")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

WEEK_MINUTES = 7 * 24 * 60
# Runs of three or more digits are dropped from a label: a document number never belongs there.
_DIGITS = re.compile(r"\d{3,}")
DESCRIPTION = "Added by Passwords. It moves if you change the date in your vault, and goes if you delete the item there. You can change the wording here."


def clean_label(raw: str) -> str:
    text = _DIGITS.sub(" ", raw or "")
    text = re.sub(r"\s+", " ", text).strip(" -–:#,./")
    return text[:60].strip() or "Document"


def _pretty(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def day_title(label: str) -> str:
    return f"{label} expires"


def early_title(label: str, weeks: int) -> str:
    return f"{label} expires in {weeks} week{'s' if weeks != 1 else ''}"


def task_title(label: str) -> str:
    return f"{label} expires soon"


def task_notes(on: date) -> str:
    return f"Expires on {_pretty(on)}. {DESCRIPTION}"


class ReminderIn(s._Base):
    expires_on: date
    weeks: int = Field(ge=1, le=52)
    label: str = Field(min_length=1, max_length=200)
    calendar: bool = True
    task: bool = False


class ReminderOut(s._Base):
    item_id: uuid.UUID
    expires_on: date
    weeks: int
    label: str
    calendar: bool
    task: bool
    event_url: str | None = None
    task_url: str | None = None
    # Turned on, then deleted from Calendar or Tasks by hand.
    calendar_gone: bool = False
    task_gone: bool = False


class RemindersOut(s._Base):
    reminders: list[ReminderOut]
    tasks_available: bool


async def _tasks_available(db: AsyncSession) -> bool:
    from app.items.service import available_specs

    try:
        return "tasks" in await available_specs(db)
    except Exception:  # noqa: BLE001
        return False


async def _task_exists(db: AsyncSession, user: User, r: PwReminder) -> bool:
    if not (r.task_file_id and r.task_id):
        return False
    from app.items import service as items

    try:
        _row, doc, _ = await items.load(db, user, r.task_file_id)
    except items.ItemNotFound:
        return False
    return any(t.get("id") == r.task_id for t in (doc.data or {}).get("tasks", []))


async def _out(db: AsyncSession, user: User, r: PwReminder) -> ReminderOut:
    task_there = await _task_exists(db, user, r) if r.task else False
    return ReminderOut(
        item_id=r.item_id,
        expires_on=r.expires_on,
        weeks=r.weeks,
        label=r.label,
        calendar=r.calendar,
        task=r.task,
        event_url=f"/calendar?event={r.event_id}" if r.event_id else None,
        task_url=f"/files/item/{r.task_file_id}" if task_there else None,
        calendar_gone=r.calendar and r.event_id is None,
        task_gone=r.task and not task_there,
    )


async def _item(db: AsyncSession, item_id: str, user: User) -> PwItem:
    item = await db.get(PwItem, parse_uuid(item_id))
    if item is None or item.deleted_at is not None or item.blob is None or await service.member_of(db, item.vault_id, user.id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return item


# ------------------------------------------------------------------ Calendar


async def _put_event(db: AsyncSession, user: User, event_id: uuid.UUID | None, day: date, title: str | None, reminders: list[int], fresh_title: str) -> uuid.UUID:
    """Move the event to ``day``, or make it. ``title`` is None to keep what the person wrote."""
    from app.calendars import service as cal
    from app.calendars.models import CalEvent

    if event_id is not None and await db.get(CalEvent, event_id) is not None:
        await cal.update_event(db, user, event_id, cal.EventFields(title=title, all_day=True, start=day.isoformat(), end=day.isoformat(), reminders=reminders))
        return event_id
    ev = await cal.create_event(
        db, user, cal.EventFields(title=fresh_title, description=DESCRIPTION, all_day=True, start=day.isoformat(), end=day.isoformat(), reminders=reminders), ping_guests=False
    )
    return ev.id


async def _drop_event(db: AsyncSession, user: User, event_id: uuid.UUID | None) -> None:
    if event_id is None:
        return
    from app.calendars import service as cal

    try:
        await cal.delete_event(db, user, event_id)
    except HTTPException:
        pass  # Already gone, or no longer theirs to delete.


# ------------------------------------------------------------------ Tasks


async def _edit_tasks(db: AsyncSession, user: User, file_id: uuid.UUID | None, fn) -> tuple[uuid.UUID, Any]:  # noqa: ANN001
    """Change the person's Tasks file in place, like Mail's "Add to Tasks" does."""
    from app.items import service as items
    from app.items.registry import get_spec

    if file_id is None:
        row, _ = await items.open_app(db, user, "tasks")
        file_id = row.id
    row, doc, _ = await items.load(db, user, file_id, need="edit", lock=True)
    spec = get_spec("tasks")
    data = copy.deepcopy(doc.data)
    ctx = items.make_context(db, user, row.id, spec)
    result = await fn(ctx, spec, data)
    await items.save_data(db, user, row, doc, data, base_revision=None)
    return row.id, result


async def _put_task(db: AsyncSession, user: User, r: PwReminder, label_changed: bool) -> None:
    from app.items import service as items

    due = (r.expires_on - timedelta(weeks=r.weeks)).isoformat()
    if r.task_file_id and r.task_id:
        async def move(ctx, spec, data):  # noqa: ANN001, ANN202
            if not any(t.get("id") == r.task_id for t in data.get("tasks", [])):
                return False
            args: dict[str, Any] = {"task": r.task_id, "due": due, "notes": task_notes(r.expires_on), "alerts": [0]}
            if label_changed:
                args["title"] = task_title(r.label)
            await items.run_action(ctx, spec, data, "update_task", args)
            return True

        try:
            _fid, moved = await _edit_tasks(db, user, r.task_file_id, move)
            if moved:
                return
        except items.ItemNotFound:
            pass

    async def add(ctx, spec, data):  # noqa: ANN001, ANN202
        out = await items.run_action(ctx, spec, data, "add_tasks", {"tasks": [{"title": task_title(r.label), "notes": task_notes(r.expires_on), "due": due, "alerts": [0]}]})
        return out.result[0]["id"]

    r.task_file_id, r.task_id = await _edit_tasks(db, user, None, add)


async def _drop_task(db: AsyncSession, user: User, r: PwReminder) -> None:
    if not (r.task_file_id and r.task_id):
        return
    from app.items import service as items

    async def drop(ctx, spec, data):  # noqa: ANN001, ANN202
        # By id only: the action also matches titles, and this must never take someone else's task.
        if any(t.get("id") == r.task_id for t in data.get("tasks", [])):
            await items.run_action(ctx, spec, data, "delete_tasks", {"tasks": [r.task_id]})

    try:
        await _edit_tasks(db, user, r.task_file_id, drop)
    except items.ItemNotFound:
        pass
    r.task_file_id, r.task_id = None, None


# ------------------------------------------------------------------ the whole reminder


def _event_reminders(weeks: int) -> list[int]:
    # Calendar reminds at most a week ahead; further out, the heads-up event does it.
    return sorted({0, min(weeks, 1) * WEEK_MINUTES})


async def apply(db: AsyncSession, user: User, r: PwReminder, *, label_changed: bool, weeks_changed: bool) -> None:
    if r.calendar:
        r.event_id = await _put_event(db, user, r.event_id, r.expires_on, day_title(r.label) if label_changed else None, _event_reminders(r.weeks), day_title(r.label))
        if r.weeks > 1:
            early = r.expires_on - timedelta(weeks=r.weeks)
            r.early_event_id = await _put_event(
                db, user, r.early_event_id, early, early_title(r.label, r.weeks) if (label_changed or weeks_changed) else None, [0], early_title(r.label, r.weeks)
            )
        else:
            await _drop_event(db, user, r.early_event_id)
            r.early_event_id = None
    else:
        await _drop_event(db, user, r.event_id)
        await _drop_event(db, user, r.early_event_id)
        r.event_id = r.early_event_id = None
    if r.task:
        await _put_task(db, user, r, label_changed)
    else:
        await _drop_task(db, user, r)


async def remove(db: AsyncSession, user: User, r: PwReminder) -> None:
    await _drop_event(db, user, r.event_id)
    await _drop_event(db, user, r.early_event_id)
    await _drop_task(db, user, r)
    await db.delete(r)


async def remove_for_items(db: AsyncSession, item_ids: list[uuid.UUID]) -> int:
    """Everyone's reminders for these items, which have just been deleted. Committed."""
    if not item_ids:
        return 0
    rows = (await db.execute(select(PwReminder).where(PwReminder.item_id.in_(item_ids)))).scalars().all()
    n = 0
    for r in rows:
        user = await db.get(User, r.user_id)
        try:
            if user is not None:
                await remove(db, user, r)
            else:
                await db.delete(r)
            await db.commit()
            n += 1
        except Exception:  # noqa: BLE001 — the sweep will try again
            await db.rollback()
            logger.exception("removing an expiry reminder failed")
    return n


async def sweep(db: AsyncSession) -> int:
    """Reminders whose item is gone, deleted, or no longer this person's to see."""
    from app.passwords.models import PwVaultMember

    stale = (
        await db.execute(
            select(PwReminder.item_id)
            .outerjoin(PwItem, PwItem.id == PwReminder.item_id)
            .outerjoin(PwVaultMember, (PwVaultMember.vault_id == PwItem.vault_id) & (PwVaultMember.user_id == PwReminder.user_id))
            .where((PwItem.id.is_(None)) | (PwItem.deleted_at.is_not(None)) | (PwItem.blob.is_(None)) | (PwVaultMember.user_id.is_(None)))
        )
    ).scalars().all()
    if not stale:
        return 0
    # Only the people who lost it; another member who can still see the item keeps theirs.
    rows = (
        await db.execute(
            select(PwReminder, PwItem, PwVaultMember)
            .outerjoin(PwItem, PwItem.id == PwReminder.item_id)
            .outerjoin(PwVaultMember, (PwVaultMember.vault_id == PwItem.vault_id) & (PwVaultMember.user_id == PwReminder.user_id))
            .where(PwReminder.item_id.in_(set(stale)))
        )
    ).all()
    n = 0
    for r, item, member in rows:
        if item is not None and item.deleted_at is None and item.blob is not None and member is not None:
            continue
        user = await db.get(User, r.user_id)
        try:
            if user is not None:
                await remove(db, user, r)
            else:
                await db.delete(r)
            await db.commit()
            n += 1
        except Exception:  # noqa: BLE001
            await db.rollback()
            logger.exception("sweeping an expiry reminder failed")
    return n


# ------------------------------------------------------------------ routes


@router.get("/reminders", response_model=RemindersOut)
async def list_reminders(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> RemindersOut:
    rows = (await db.execute(select(PwReminder).where(PwReminder.user_id == session.user.id).order_by(PwReminder.expires_on))).scalars().all()
    return RemindersOut(reminders=[await _out(db, session.user, r) for r in rows], tasks_available=await _tasks_available(db))


@router.put("/reminders/{item_id}", response_model=ReminderOut)
async def put_reminder(item_id: str, body: ReminderIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> ReminderOut:
    if not (body.calendar or body.task):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose Calendar, Tasks or both.")
    if body.task and not await _tasks_available(db):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tasks isn't available on this server.")
    item = await _item(db, item_id, session.user)
    label = clean_label(body.label)
    r = await db.scalar(select(PwReminder).where(PwReminder.user_id == session.user.id, PwReminder.item_id == item.id).with_for_update())
    if r is None:
        r = PwReminder(user_id=session.user.id, item_id=item.id, expires_on=body.expires_on, weeks=body.weeks, label=label, calendar=body.calendar, task=body.task)
        db.add(r)
        label_changed = weeks_changed = True
    else:
        label_changed, weeks_changed = r.label != label, r.weeks != body.weeks
        r.expires_on, r.weeks, r.label, r.calendar, r.task = body.expires_on, body.weeks, label, body.calendar, body.task
    await apply(db, session.user, r, label_changed=label_changed, weeks_changed=weeks_changed)
    await db.commit()
    return await _out(db, session.user, r)


@router.delete("/reminders/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reminder(item_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    # No item check: a reminder for an item that's gone must still be removable.
    r = await db.scalar(select(PwReminder).where(PwReminder.user_id == session.user.id, PwReminder.item_id == parse_uuid(item_id)))
    if r is not None:
        await remove(db, session.user, r)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router", "remove_for_items", "sweep", "clean_label"]
