"""Who sees what, and events → occurrences.

The one rule: you see an event when you're on its calendar or invited to it.
Someone you've shared your own calendar with as "free/busy only" (role
``busy``) sees just *when* — each event shows as "Busy", nothing else.
You can change it when you made it, when you can edit its (shared) calendar,
or when its organiser let guests edit.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import recur
from .models import CalAttendee, CalCalendar, CalEvent, CalMember

UTC = timezone.utc
PALETTE = ["#4F7FE0", "#E0584F", "#3FA66B", "#D9A23B", "#8E5BD9", "#D95B9E", "#3AA7B5", "#7A8597"]
STATUSES = ("invited", "going", "maybe", "declined")


def now() -> datetime:
    return datetime.now(UTC)


def not_found(what: str = "Event") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def user_tz(user: User) -> str:
    return str((user.settings or {}).get("timezone") or "UTC")


def user_out(u: User) -> dict:
    from app.rooms.core import user_out as room_user

    return room_user(u)


async def users_map(db: AsyncSession, ids: set[uuid.UUID]) -> dict[str, dict]:
    from app.rooms.core import users_map as room_users

    return await room_users(db, ids)


# ------------------------------------------------------------------ calendars


async def ensure_personal(db: AsyncSession, user: User) -> CalCalendar:
    """The person's own calendar, made on first need."""
    cal = (
        await db.execute(select(CalCalendar).where(CalCalendar.owner_id == user.id, CalCalendar.personal.is_(True)).limit(1))
    ).scalar_one_or_none()
    if cal is None:
        cal = CalCalendar(name="My calendar", personal=True, owner_id=user.id, color=PALETTE[0])
        db.add(cal)
        await db.flush()
        db.add(CalMember(calendar_id=cal.id, user_id=user.id, role="owner"))
        await db.flush()
    return cal


async def membership(db: AsyncSession, calendar_id: uuid.UUID, user_id: uuid.UUID) -> CalMember | None:
    return await db.get(CalMember, (calendar_id, user_id))


async def load_calendar(db: AsyncSession, calendar_id: uuid.UUID, user: User) -> tuple[CalCalendar, CalMember]:
    cal = await db.get(CalCalendar, calendar_id)
    m = await membership(db, calendar_id, user.id) if cal else None
    if cal is None or m is None:
        raise not_found("Calendar")
    return cal, m


def busy_only(m: CalMember | None, att: CalAttendee | None) -> bool:
    """On the calendar as free/busy only, and not invited to this event."""
    return m is not None and m.role == "busy" and (att is None or not _counts(att))


def can_write_calendar(m: CalMember | None) -> bool:
    return m is not None and m.role in ("owner", "editor")


async def member_ids(db: AsyncSession, calendar_id: uuid.UUID) -> list[uuid.UUID]:
    return list((await db.execute(select(CalMember.user_id).where(CalMember.calendar_id == calendar_id))).scalars())


# ------------------------------------------------------------------ events


async def attendees_of(db: AsyncSession, event_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[CalAttendee]]:
    out: dict[uuid.UUID, list[CalAttendee]] = {}
    if not event_ids:
        return out
    rows = (await db.execute(select(CalAttendee).where(CalAttendee.event_id.in_(event_ids)).order_by(CalAttendee.created_at))).scalars()
    for a in rows:
        out.setdefault(a.event_id, []).append(a)
    return out


async def load_event(db: AsyncSession, event_id: uuid.UUID, user: User, *, lock: bool = False) -> tuple[CalEvent, CalMember | None, CalAttendee | None]:
    """The event, your membership of its calendar, and your invite — 404 if you can't see it."""
    q = select(CalEvent).where(CalEvent.id == event_id)
    if lock:
        q = q.with_for_update()
    ev = (await db.execute(q)).scalar_one_or_none()
    if ev is None:
        raise not_found()
    m = await membership(db, ev.calendar_id, user.id)
    att = await db.get(CalAttendee, (ev.id, user.id))
    if m is None and att is None and not await shared_with_me(db, ev.id, user):
        raise not_found()
    return ev, m, att


async def shared_rooms(db: AsyncSession, event_id: uuid.UUID, user: User) -> list[uuid.UUID]:
    """The rooms this event was planned in or shared to that you're in."""
    from app.rooms.core import visible_room_ids

    from .models import CalEventRoom

    rooms = list((await db.execute(select(CalEventRoom.room_id).where(CalEventRoom.event_id == event_id))).scalars())
    if not rooms:
        return []
    mine = set(await visible_room_ids(db, user.id))
    return [r for r in rooms if r in mine]


async def shared_with_me(db: AsyncSession, event_id: uuid.UUID, user: User) -> bool:
    """Shared to a room you're in — you can see it, and add yourself. Or
    (Porch WP-P3.2) it's on a Porch post you can see: answer from its card."""
    if await shared_rooms(db, event_id, user):
        return True
    from app.porch.plans import event_post_for

    return await event_post_for(db, event_id, user) is not None


def can_edit(ev: CalEvent, m: CalMember | None, att: CalAttendee | None, user: User) -> bool:
    if ev.created_by == user.id or can_write_calendar(m):
        return True
    return att is not None and ev.guests_can_edit


def can_delete(ev: CalEvent, m: CalMember | None, user: User) -> bool:
    return ev.created_by == user.id or can_write_calendar(m)


async def visible_events(db: AsyncSession, user: User, start: datetime, end: datetime) -> list[CalEvent]:
    """Events (series included) you can see that may have an occurrence in the range."""
    my_cals = select(CalMember.calendar_id).where(CalMember.user_id == user.id)
    invited = select(CalAttendee.event_id).where(CalAttendee.user_id == user.id, CalAttendee.hidden.is_(False))
    q = select(CalEvent).where(
        or_(CalEvent.calendar_id.in_(my_cals), CalEvent.id.in_(invited)),
        CalEvent.start_at < end,
        or_(CalEvent.last_end.is_(None), CalEvent.last_end > start),
    )
    return list((await db.execute(q.order_by(CalEvent.start_at))).scalars())


def reminders_for(ev: CalEvent, att: CalAttendee | None) -> list[int]:
    if att is not None and att.reminders is not None:
        return list(att.reminders)
    return list(ev.reminders or [])


async def occurrences_out(db: AsyncSession, user: User, events: list[CalEvent], start: datetime, end: datetime) -> list[dict]:
    """Each visible occurrence in [start, end), ready for the client."""
    if not events:
        return []
    atts = await attendees_of(db, [e.id for e in events])
    cal_ids = {e.calendar_id for e in events}
    mine = {
        m.calendar_id: m
        for m in (await db.execute(select(CalMember).where(CalMember.user_id == user.id, CalMember.calendar_id.in_(cal_ids)))).scalars()
    }
    out: list[dict] = []
    for ev in events:
        ev_atts = atts.get(ev.id, [])
        my_att = next((a for a in ev_atts if a.user_id == user.id), None)
        m = mine.get(ev.calendar_id)
        # Hidden: a guest (or a shared calendar's member) took it off theirs.
        if (my_att is not None and my_att.hidden) or (m is None and my_att is None):
            continue
        base = event_out(ev, m, my_att, ev_atts, user)
        for s, e in recur.occurrences(
            start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz,
            repeat=ev.repeat, exdates=ev.exdates, range_start=start, range_end=end,
        ):
            out.append({**base, "id": f"{ev.id}:{recur.stamp(s)}", "occurrence": recur.stamp(s), "start": iso(s, ev.all_day), "end": end_iso(e, ev.all_day)})
    out.sort(key=lambda o: (o["start"], o["title"]))
    return out


def iso(dt: datetime, all_day: bool) -> str:
    return dt.astimezone(UTC).date().isoformat() if all_day else dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def end_iso(dt: datetime, all_day: bool) -> str:
    """An end for the client: all-day ends are the last day (inclusive)."""
    return iso(dt - timedelta(days=1), True) if all_day else iso(dt, False)


def event_out(ev: CalEvent, m: CalMember | None, my_att: CalAttendee | None, atts: list[CalAttendee], user: User) -> dict[str, Any]:
    if busy_only(m, my_att):
        return _busy_out(ev)
    return {
        "event_id": str(ev.id),
        "calendar_id": str(ev.calendar_id),
        "title": ev.title,
        "description": ev.description,
        "location": ev.location,
        "all_day": ev.all_day,
        "series_start": iso(ev.start_at, ev.all_day),
        "series_end": end_iso(ev.end_at, ev.all_day),
        "tz": ev.tz,
        "repeat": ev.repeat,
        "color": ev.color,
        "created_by": str(ev.created_by) if ev.created_by else None,
        "guests_can_edit": ev.guests_can_edit,
        "reminders": reminders_for(ev, my_att),
        "event_reminders": list(ev.reminders or []),
        # ``guest``: invited (vs a shared-calendar member who just answered).
        # A shared calendar's member who only set their own reminders (no
        # answer yet) isn't an attendee — just a settings row.
        "attendees": [{"user_id": str(a.user_id), "status": a.status, "guest": a.invited_by is not None} for a in atts if _counts(a)],
        "my_status": my_att.status if my_att and _counts(my_att) else None,
        "on_my_calendar": m is not None,
        "can_edit": can_edit(ev, m, my_att, user),
        "can_delete": can_delete(ev, m, user),
        # What it was made from (a task planned into a time slot), else None.
        "source": ev.source,
    }


def _busy_out(ev: CalEvent) -> dict[str, Any]:
    """An event as free/busy-only people see it: when, and nothing else."""
    return {
        "event_id": str(ev.id), "calendar_id": str(ev.calendar_id), "title": "Busy", "description": "", "location": "",
        "all_day": ev.all_day, "series_start": iso(ev.start_at, ev.all_day), "series_end": end_iso(ev.end_at, ev.all_day),
        "tz": ev.tz, "repeat": None, "color": None, "created_by": None, "guests_can_edit": False, "reminders": [],
        "event_reminders": [], "attendees": [], "my_status": None, "on_my_calendar": True, "can_edit": False,
        "can_delete": False, "busy_only": True,
    }


def _counts(a: CalAttendee) -> bool:
    """A guest, or a member who has answered."""
    return a.invited_by is not None or a.status != "invited"


def people_on(ev: CalEvent, cal_members: list[uuid.UUID], atts: list[CalAttendee]) -> set[uuid.UUID]:
    """Everyone who sees the event (calendar members + guests who haven't hidden it)."""
    return set(cal_members) | {a.user_id for a in atts if not a.hidden}


def in_range_filter(start: datetime, end: datetime):  # noqa: ANN201
    return and_(CalEvent.start_at < end, or_(CalEvent.last_end.is_(None), CalEvent.last_end > start))
