"""What the phone's widgets show, in one small snapshot (``docs/notes-plan.md`` §5).

Each section has an ``etag`` (a hash of what it holds). The phone sends back
the etags it has; a section that hasn't changed comes back as
``{etag, unchanged: true}``, so a refresh where nothing changed is a few
hundred bytes.

* **calendar** — your calendars (with their colour and whether you've
  unticked them on the web) and each event occurrence from the start of
  today for ``days`` days. Free/busy-only events, events you took off your
  calendar and ones you declined are left out, as on Today. Times are UTC
  instants (all-day: dates); the phone sorts them into its own days, so the
  Agenda stays right across midnight with no signal.
* **tasks** — your Tasks app's lists and its open tasks: overdue, today and
  the next ``days`` days (so tomorrow's are there when midnight comes with
  no signal), plus the undated ones when asked.
* **notes** — pinned then recent notes you can open, as small cards, plus
  the full note for each ``note=`` id (or ``{id, gone: true}`` when it
  isn't yours to open any more).

Only what the person can already open is ever read: their own calendars and
invitations (``calendars.core``), their own Tasks file, notes through
``notes.access.visible_predicate``.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.widgets")

UTC = timezone.utc
SECTIONS = ("calendar", "tasks", "notes")
MAX_DAYS = 14
PER_DAY = 50  # events a day, at most
MAX_TASKS = 150
RECENT_NOTES = 12
CARD_CHARS = 300
CARD_ITEMS = 12
FULL_CHARS = 4000
FULL_ITEMS = 200
MAX_NOTE_IDS = 8


def etag_of(section: dict[str, Any]) -> str:
    raw = json.dumps(section, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def with_etag(section: dict[str, Any], have: str | None) -> dict[str, Any]:
    tag = etag_of(section)
    if have and have == tag:
        return {"etag": tag, "unchanged": True}
    return {"etag": tag, **section}


def _bounds(day: date, days: int, tz: ZoneInfo) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time(0, 0), tzinfo=tz)
    end = datetime.combine(day + timedelta(days=days), time(0, 0), tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


# ------------------------------------------------------------------ calendar


async def calendar_section(db: AsyncSession, user: User, today: date, tz: ZoneInfo, days: int) -> dict[str, Any]:
    from app.calendars import core as cal
    from app.calendars.models import CalCalendar, CalMember

    rows = (
        await db.execute(
            select(CalMember, CalCalendar)
            .join(CalCalendar, CalCalendar.id == CalMember.calendar_id)
            .where(CalMember.user_id == user.id)
            .order_by(CalCalendar.personal.desc(), CalCalendar.name)
        )
    ).all()
    calendars = []
    colours: dict[str, str] = {}
    for m, c in rows:
        if m.role == "busy":  # someone else's time, never their events
            continue
        colour = m.color or c.color
        colours[str(c.id)] = colour
        calendars.append({"id": str(c.id), "name": c.name, "color": colour, "hidden": bool(m.hidden), "personal": bool(c.personal)})

    start, end = _bounds(today, days, tz)
    events = await cal.visible_events(db, user, start, end)
    out: list[dict[str, Any]] = []
    per_day: dict[str, int] = {}
    for o in await cal.occurrences_out(db, user, events, start, end):
        if o.get("busy_only") or o.get("my_status") == "declined":
            continue
        # On one of your calendars (not one you only see as free/busy), else an invitation.
        cid = o.get("calendar_id") if o.get("on_my_calendar") and o.get("calendar_id") in colours else None
        day_key = o["start"][:10]
        if per_day.get(day_key, 0) >= PER_DAY:
            continue
        per_day[day_key] = per_day.get(day_key, 0) + 1
        out.append(
            {
                "id": o["id"],
                "event_id": o["event_id"],
                "start": o["start"],
                "end": o["end"],
                "all_day": bool(o["all_day"]),
                "title": o["title"] or "Untitled event",
                "location": (o.get("location") or "")[:200],
                # Its own colour, else the calendar's as you see it.
                "color": o.get("color") or (colours.get(cid) if cid else None) or "#4F7FE0",
                # None: an invitation to an event on someone else's calendar.
                "calendar_id": cid,
            }
        )
    out.sort(key=lambda e: (e["start"][:10], not e["all_day"], e["start"], e["title"]))
    return {"from": today.isoformat(), "days": days, "calendars": calendars, "events": out}


# ------------------------------------------------------------------ tasks


def tasks_from(file_id: uuid.UUID, data: dict, today: date, days: int, someday: bool) -> dict[str, Any]:
    """Pure: the open tasks the widget can show, from a Tasks file's data."""
    from app.items.kinds.tasks import logic as L

    b = L.buckets(data, today, days=days)
    lists = [{"id": "inbox", "name": "Inbox", "color": None}] + [
        {"id": lst["id"], "name": lst["name"], "color": lst.get("color")} for lst in data.get("lists", [])
    ]

    def brief(t: dict) -> dict[str, Any]:
        return {
            "id": t["id"],
            "title": t["title"],
            "due": t.get("due"),
            "time": t.get("time"),
            "priority": t.get("priority", 0),
            "list_id": t.get("list_id", "inbox"),
            "repeats": bool(t.get("repeat")),
        }

    picked = b["overdue"] + b["today"] + b["upcoming"] + (b["someday"] if someday else [])
    return {
        "file_id": str(file_id),
        "lists": lists,
        "tasks": [brief(t) for t in picked[:MAX_TASKS]],
        "more": max(0, len(picked) - MAX_TASKS),
    }


async def tasks_section(db: AsyncSession, user: User, today: date, days: int, someday: bool) -> dict[str, Any]:
    from app.items import service

    found = await service.primary_file(db, user, "tasks")
    if found is None:
        return {"file_id": None, "lists": [{"id": "inbox", "name": "Inbox", "color": None}], "tasks": [], "more": 0}
    row, doc = found
    await service.upgrade(db, doc)
    return tasks_from(row.id, doc.data or {}, today, days, someday)


# ------------------------------------------------------------------ notes


async def _items_of(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list]:
    from app.notes.models import NoteItem

    out: dict[uuid.UUID, list] = {}
    if not ids:
        return out
    for it in (
        await db.execute(select(NoteItem).where(NoteItem.note_id.in_(ids)).order_by(NoteItem.note_id, NoteItem.position, NoteItem.id))
    ).scalars():
        out.setdefault(it.note_id, []).append(it)
    return out


async def _attached(db: AsyncSession, ids: list[uuid.UUID], kind: str) -> set[uuid.UUID]:
    """The notes among ``ids`` with a live picture (``image``) or recording (``audio``)."""
    from app.files.models import UserFile
    from app.notes.attachments import live_join
    from app.notes.models import NoteAttachment

    if not ids:
        return set()
    q = (
        select(NoteAttachment.note_id)
        .join(UserFile, live_join())
        .where(NoteAttachment.note_id.in_(ids), NoteAttachment.kind == kind)
        .distinct()
    )
    return set((await db.execute(q)).scalars())


async def _voiced(db: AsyncSession, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    return await _attached(db, ids, "audio")


def _note_out(n, user: User, items: list, pinned: bool, voiced: bool, *, full: bool, pictured: bool = False) -> dict[str, Any]:
    from app.notes.service import display_title

    limit_items = FULL_ITEMS if full else CARD_ITEMS
    title = display_title(n)
    if voiced and not n.title.strip() and not (n.body_text or "").strip() and not items:
        title = "Voice note"  # a recording on its own (its words are under it, not in the text)
    out: dict[str, Any] = {
        "id": str(n.id),
        "kind": n.kind,
        "title": title,
        "color": n.color,
        "pinned": pinned,
        "shared": n.owner_id != user.id,
        "voice": voiced,
        "image": pictured,
        "updated_at": n.updated_at.astimezone(UTC).isoformat().replace("+00:00", "Z") if n.updated_at else None,
    }
    if n.kind == "list":
        # Unticked first, each in its own order.
        ordered = [i for i in items if not i.checked] + [i for i in items if i.checked]
        out["items"] = [{"id": str(i.id), "text": i.text[:300], "checked": bool(i.checked), "indent": i.parent_id is not None} for i in ordered[:limit_items]]
        out["left"] = sum(1 for i in items if not i.checked)
        out["total"] = len(items)
    else:
        out["text"] = (n.body_text or "")[: FULL_CHARS if full else CARD_CHARS]
    return out


async def notes_section(db: AsyncSession, user: User, note_ids: list[uuid.UUID]) -> dict[str, Any]:
    from app.notes import access
    from app.notes.models import Note, NoteUserState

    st = NoteUserState
    base = (
        select(Note, st.pinned)
        .outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
        .where(access.visible_predicate(user.id), st.archived_at.is_(None))
    )
    pinned = list((await db.execute(base.where(st.pinned.is_(True)).order_by(st.position, Note.id).limit(RECENT_NOTES))).all())
    recent = list(
        (await db.execute(base.where(st.pinned.is_not(True)).order_by(Note.updated_at.desc(), Note.id).limit(RECENT_NOTES))).all()
    )
    rows = pinned + recent
    wanted: list = []
    if note_ids:
        found = {n.id: (n, p) for n, p in (await db.execute(
            select(Note, st.pinned)
            .outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
            .where(access.visible_predicate(user.id), Note.id.in_(note_ids))
        )).all()}
        wanted = [found.get(i) or i for i in note_ids]
    ids = list({n.id for n, _ in rows} | {w[0].id for w in wanted if isinstance(w, tuple)})
    items = await _items_of(db, ids)
    voiced = await _voiced(db, ids)
    pictured = await _attached(db, ids, "image")
    cards = [_note_out(n, user, items.get(n.id, []), bool(p), n.id in voiced, full=False, pictured=n.id in pictured) for n, p in rows]
    full = []
    for w in wanted:
        if isinstance(w, tuple):
            n, p = w
            full.append(_note_out(n, user, items.get(n.id, []), bool(p), n.id in voiced, full=True, pictured=n.id in pictured))
        else:
            full.append({"id": str(w), "gone": True})
    return {"cards": cards, "notes": full}


async def note_views(db: AsyncSession, user: User, note) -> dict[str, Any]:
    """One note as the widgets show it — its card and the whole of it — for
    the answer to a change made on the phone (so the widget shows the
    server's copy at once, without waiting for the next snapshot)."""
    from app.notes.service import state_for

    st = await state_for(db, note.id, user.id)
    items = (await _items_of(db, [note.id])).get(note.id, [])
    voiced = note.id in await _voiced(db, [note.id])
    pictured = note.id in await _attached(db, [note.id], "image")
    pinned = bool(st.pinned)
    return {
        "card": _note_out(note, user, items, pinned, voiced, full=False, pictured=pictured),
        "full": _note_out(note, user, items, pinned, voiced, full=True, pictured=pictured),
        "archived": st.archived_at is not None,
    }


# ------------------------------------------------------------------ the whole thing


async def build(
    db: AsyncSession,
    user: User,
    *,
    want: list[str],
    days: int,
    someday: bool,
    note_ids: list[uuid.UUID],
    have: dict[str, str],
    now: datetime | None = None,
) -> dict[str, Any]:
    from app.items.service import zone_for

    tz = zone_for(user)
    moment = (now or datetime.now(UTC)).astimezone(tz)
    today = moment.date()
    out: dict[str, Any] = {
        "generated_at": moment.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "tz": str(tz.key),
        "today": today.isoformat(),
    }
    for name in want:
        try:
            if name == "calendar":
                section = await calendar_section(db, user, today, tz, days)
            elif name == "tasks":
                section = await tasks_section(db, user, today, days, someday)
            elif name == "notes":
                section = await notes_section(db, user, note_ids)
            else:
                continue
        except Exception:  # noqa: BLE001 — one section failing mustn't blank the others
            logger.exception("widget snapshot: %s failed", name)
            out[name] = {"error": True}
            continue
        out[name] = with_etag(section, have.get(name))
    return out


__all__ = ["MAX_DAYS", "MAX_NOTE_IDS", "SECTIONS", "build", "etag_of", "note_views", "tasks_from", "with_etag"]
