"""Making and changing events — shared by the API and the chat tools.

A repeating event is one row. Changing or deleting "this occurrence" cuts it
out of the series (an exdate) and, for a change, adds a one-off in its place;
"this and following" ends the series the day before and starts a new one.
"""
from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import core, notify, recur
from .models import CalAttendee, CalCalendar, CalEvent, CalMember

UTC = timezone.utc
MAX_REMINDER = 10080  # a week
MAX_GUESTS = 50


def bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# ------------------------------------------------------------------ times


def parse_times(all_day: bool, start: str, end: str | None, tz_name: str) -> tuple[datetime, datetime]:
    """Wire times → stored ones. All-day: dates, ``end`` the last day
    (inclusive); stored as midnights with an exclusive end. Timed: ISO
    instants (a time without an offset is read in ``tz_name``)."""
    try:
        if all_day:
            s = date.fromisoformat(start[:10])
            e = date.fromisoformat(end[:10]) if end else s
            if e < s:
                raise bad("The event ends before it starts.")
            return _midnight(s), _midnight(e + timedelta(days=1))
        tz = recur.zone(tz_name)
        s_dt = _instant(start, tz)
        e_dt = _instant(end, tz) if end else s_dt + timedelta(hours=1)
    except ValueError as exc:
        raise bad("Couldn't read that date or time.") from exc
    if e_dt <= s_dt:
        raise bad("The event ends before it starts.")
    if e_dt - s_dt > timedelta(days=60):
        raise bad("An event can't be longer than 60 days.")
    return s_dt, e_dt


def _midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


def _instant(raw: str, tz) -> datetime:  # noqa: ANN001
    dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(UTC)


def clean_reminders(raw: list[int] | None) -> list[int]:
    vals = sorted({int(m) for m in (raw or []) if 0 <= int(m) <= MAX_REMINDER})
    return vals[:5]


# ------------------------------------------------------------------ input


@dataclass
class EventFields:
    """What a create or change says (``None`` = leave as it is)."""

    title: str | None = None
    description: str | None = None
    location: str | None = None
    all_day: bool | None = None
    start: str | None = None
    end: str | None = None
    tz: str | None = None
    calendar_id: uuid.UUID | None = None
    repeat: dict[str, Any] | None = None
    repeat_set: bool = False  # True when ``repeat`` was given (None = stop repeating)
    reminders: list[int] | None = None
    guests: list[uuid.UUID] | None = None  # the full guest list
    guests_can_edit: bool | None = None
    color: str | None = None
    color_set: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


async def _check_guests(db: AsyncSession, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    ids = list(dict.fromkeys(ids))[:MAX_GUESTS]
    if not ids:
        return []
    found = set((await db.execute(select(User.id).where(User.id.in_(ids), User.disabled.is_(False)))).scalars())
    return [i for i in ids if i in found]


async def _target_calendar(db: AsyncSession, user: User, calendar_id: uuid.UUID | None) -> CalCalendar:
    if calendar_id is None:
        return await core.ensure_personal(db, user)
    cal, m = await core.load_calendar(db, calendar_id, user)
    if not core.can_write_calendar(m):
        raise core.forbidden("You can only look at that calendar, not add to it.")
    return cal


# ------------------------------------------------------------------ create


async def create_event(db: AsyncSession, user: User, f: EventFields, *, ping_guests: bool = True) -> CalEvent:
    if not (f.title or "").strip():
        raise bad("An event needs a title.")
    if not f.start:
        raise bad("An event needs a start.")
    cal = await _target_calendar(db, user, f.calendar_id)
    tz_name = f.tz or core.user_tz(user)
    all_day = bool(f.all_day)
    start_at, end_at = parse_times(all_day, f.start, f.end, tz_name)
    repeat = recur.clean(f.repeat)
    ev = CalEvent(
        calendar_id=cal.id,
        created_by=user.id,
        title=f.title.strip()[:200],
        description=(f.description or "")[:5000],
        location=(f.location or "").strip()[:300],
        all_day=all_day,
        start_at=start_at,
        end_at=end_at,
        tz=tz_name,
        repeat=repeat,
        exdates=[],
        reminders=clean_reminders(f.reminders if f.reminders is not None else ([] if all_day else [10])),
        color=f.color,
        guests_can_edit=bool(f.guests_can_edit),
    )
    ev.last_end = recur.last_end(start_at=start_at, end_at=end_at, all_day=all_day, tz_name=tz_name, repeat=repeat)
    db.add(ev)
    await db.flush()
    guests = [g for g in await _check_guests(db, f.guests or []) if g != user.id]
    for g in guests:
        db.add(CalAttendee(event_id=ev.id, user_id=g, invited_by=user.id))
    await db.flush()
    # People on a shared calendar hear about a new event only when invited
    # (a busy family calendar shouldn't buzz for every entry).
    if ping_guests:
        await notify.invited(db, ev, user, set(guests))
    return ev


# ------------------------------------------------------------------ change


_TIME_FIELDS = ("start_at", "end_at", "all_day", "repeat", "location", "title")


async def update_event(
    db: AsyncSession, user: User, event_id: uuid.UUID, f: EventFields, *, scope: str = "all", occurrence: str | None = None
) -> CalEvent:
    ev, m, att = await core.load_event(db, event_id, user, lock=True)
    if not core.can_edit(ev, m, att, user):
        raise core.forbidden("Only the organiser can change this event.")
    if ev.repeat and scope in ("this", "following"):
        occ = _occurrence(ev, occurrence)
        if scope == "this":
            return await _change_one(db, user, ev, occ, f)
        return await _change_following(db, user, ev, occ, f)

    before = {k: copy.deepcopy(getattr(ev, k)) for k in _TIME_FIELDS}
    old_viewers = await _viewers(db, ev)
    await _apply(db, user, ev, f, m)
    new_guests = await _set_guests(db, user, ev, f.guests) if f.guests is not None else set()
    await db.flush()
    removed = old_viewers - await _viewers(db, ev)
    if removed:
        await notify.cancelled(db, ev, user, removed)
    if new_guests:
        await notify.invited(db, ev, user, new_guests)
    if any(before[k] != getattr(ev, k) for k in _TIME_FIELDS):
        await notify.changed(db, ev, user, (await _guests_seeing(db, ev)) - new_guests)
    return ev


async def _apply(db: AsyncSession, user: User, ev: CalEvent, f: EventFields, m: CalMember | None) -> None:
    if f.title is not None:
        if not f.title.strip():
            raise bad("An event needs a title.")
        ev.title = f.title.strip()[:200]
    if f.description is not None:
        ev.description = f.description[:5000]
    if f.location is not None:
        ev.location = f.location.strip()[:300]
    if f.guests_can_edit is not None and (ev.created_by == user.id or core.can_write_calendar(m)):
        ev.guests_can_edit = f.guests_can_edit
    if f.color_set:
        ev.color = f.color
    if f.reminders is not None:
        ev.reminders = clean_reminders(f.reminders)
    if f.calendar_id is not None and f.calendar_id != ev.calendar_id:
        if not core.can_delete(ev, m, user):
            raise core.forbidden("Only the organiser can move this event.")
        ev.calendar_id = (await _target_calendar(db, user, f.calendar_id)).id
    if f.tz:
        ev.tz = f.tz
    if f.start is not None or f.end is not None or f.all_day is not None:
        all_day = ev.all_day if f.all_day is None else f.all_day
        start = f.start or core.iso(ev.start_at, all_day)
        end = f.end
        if end is None:
            # Keep the length when only the start moves.
            length = ev.end_at - ev.start_at
            if all_day == ev.all_day and f.start is not None:
                s, _ = parse_times(all_day, start, None, ev.tz)
                ev.start_at, ev.end_at = s, s + length
            else:
                ev.start_at, ev.end_at = parse_times(all_day, start, None, ev.tz)
        else:
            ev.start_at, ev.end_at = parse_times(all_day, start, end, ev.tz)
        ev.all_day = all_day
    if f.repeat_set:
        ev.repeat = recur.clean(f.repeat)
        ev.exdates = [] if ev.repeat is None else ev.exdates
    ev.last_end = recur.last_end(start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat)


async def _set_guests(db: AsyncSession, user: User, ev: CalEvent, wanted: list[uuid.UUID]) -> set[uuid.UUID]:
    """Make the guest list ``wanted``; returns who was newly invited."""
    want = set(await _check_guests(db, wanted)) - {ev.created_by}
    have = {a.user_id: a for a in (await db.execute(select(CalAttendee).where(CalAttendee.event_id == ev.id))).scalars()}
    for uid, a in have.items():
        # A shared-calendar member's own answer isn't a guest — keep it.
        if uid not in want and a.invited_by is not None:
            await db.delete(a)
    added = want - set(have)
    for uid in added:
        db.add(CalAttendee(event_id=ev.id, user_id=uid, invited_by=user.id))
    return added


def _occurrence(ev: CalEvent, occurrence: str | None) -> datetime:
    if not occurrence:
        raise bad("Which occurrence? (missing ``occurrence``)")
    try:
        occ = datetime.fromisoformat(occurrence.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError as exc:
        raise bad("Bad occurrence.") from exc
    hits = recur.occurrences(
        start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
        exdates=ev.exdates, range_start=occ - timedelta(seconds=1), range_end=occ + timedelta(seconds=1),
    )
    if not any(s == occ for s, _ in hits):
        raise bad("That occurrence isn't part of this event.")
    return occ


async def _copy_guests(db: AsyncSession, src: CalEvent, dst: CalEvent) -> None:
    for a in (await db.execute(select(CalAttendee).where(CalAttendee.event_id == src.id))).scalars():
        db.add(CalAttendee(event_id=dst.id, user_id=a.user_id, status=a.status, reminders=a.reminders, invited_by=a.invited_by, responded_at=a.responded_at))


def _clone(ev: CalEvent, start_at: datetime, repeat: dict[str, Any] | None) -> CalEvent:
    return CalEvent(
        calendar_id=ev.calendar_id, created_by=ev.created_by, title=ev.title, description=ev.description,
        location=ev.location, all_day=ev.all_day, start_at=start_at, end_at=start_at + (ev.end_at - ev.start_at),
        tz=ev.tz, repeat=repeat, exdates=[], reminders=list(ev.reminders or []), color=ev.color,
        guests_can_edit=ev.guests_can_edit,
    )


async def _change_one(db: AsyncSession, user: User, ev: CalEvent, occ: datetime, f: EventFields) -> CalEvent:
    """Change one occurrence: cut it from the series, add a one-off in its place."""
    ev.exdates = [*ev.exdates, recur.stamp(occ)]
    one = _clone(ev, occ, None)
    db.add(one)
    await db.flush()
    await _copy_guests(db, ev, one)
    await db.flush()
    f.repeat, f.repeat_set = None, True
    return await update_event(db, user, one.id, f)


async def _change_following(db: AsyncSession, user: User, ev: CalEvent, occ: datetime, f: EventFields) -> CalEvent:
    """Change this and later occurrences: end the series before, start a new one."""
    if occ == ev.start_at:
        f_all = copy.copy(f)
        return await update_event(db, user, ev.id, f_all)
    rest = dict(ev.repeat or {})
    rest.pop("count", None)  # counting restarts with the new series
    nxt = _clone(ev, occ, rest)
    nxt.exdates = [x for x in ev.exdates if x >= recur.stamp(occ)]
    _end_before(ev, occ)
    db.add(nxt)
    await db.flush()
    await _copy_guests(db, ev, nxt)
    await db.flush()
    return await update_event(db, user, nxt.id, f)


def _end_before(ev: CalEvent, occ: datetime) -> None:
    """End a series with the occurrence before ``occ``."""
    day_before = (recur.local_start(occ, ev.all_day, recur.zone(ev.tz)) - timedelta(days=1)).date()
    rep = dict(ev.repeat or {})
    rep.pop("count", None)
    rep["until"] = day_before.isoformat()
    ev.repeat = rep
    ev.exdates = [x for x in ev.exdates if x < recur.stamp(occ)]
    ev.last_end = recur.last_end(start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=rep)


# ------------------------------------------------------------------ delete


async def delete_event(db: AsyncSession, user: User, event_id: uuid.UUID, *, scope: str = "all", occurrence: str | None = None) -> None:
    ev, m, _att = await core.load_event(db, event_id, user, lock=True)
    if not core.can_delete(ev, m, user):
        raise core.forbidden("Only the organiser can delete this event — you can remove it from your calendar.")
    seeing = await _guests_seeing(db, ev)
    if ev.repeat and scope in ("this", "following"):
        occ = _occurrence(ev, occurrence)
        if scope == "following" and occ != ev.start_at:
            _end_before(ev, occ)
            await notify.cancelled(db, ev, user, seeing, occurrence=occ)
            return
        if scope == "this":
            ev.exdates = [*ev.exdates, recur.stamp(occ)]
            await notify.cancelled(db, ev, user, seeing, occurrence=occ)
            return
    await notify.cancelled(db, ev, user, seeing)
    await db.delete(ev)


# ------------------------------------------------------------------ answers


async def rsvp(db: AsyncSession, user: User, event_id: uuid.UUID, status: str) -> CalAttendee:
    if status not in ("going", "maybe", "declined"):
        raise bad("Answer going, maybe or declined.")
    ev, m, att = await core.load_event(db, event_id, user)
    if core.busy_only(m, att):
        raise core.not_found()
    if att is None:
        if m is not None:
            # Someone on a shared calendar answering ("who's coming to dinner?").
            att = CalAttendee(event_id=ev.id, user_id=user.id, invited_by=None)
        else:
            # Answering a card in a room it was shared to: you're a guest now.
            from .models import CalEventRoom

            rooms = await core.shared_rooms(db, ev.id, user)
            link = await db.get(CalEventRoom, (ev.id, rooms[0])) if rooms else None
            if link is None:
                raise core.not_found()
            att = CalAttendee(event_id=ev.id, user_id=user.id, invited_by=link.shared_by or ev.created_by or user.id)
        db.add(att)
    changed = att.status != status
    att.status = status
    att.hidden = False
    att.responded_at = core.now()
    await db.flush()
    if changed:
        await notify.answered(db, ev, user, status)
    return att


# ------------------------------------------------------------------ helpers


async def _viewers(db: AsyncSession, ev: CalEvent) -> set[uuid.UUID]:
    members = await core.member_ids(db, ev.calendar_id)
    atts = list((await db.execute(select(CalAttendee).where(CalAttendee.event_id == ev.id))).scalars())
    return core.people_on(ev, members, atts)


async def _guests_seeing(db: AsyncSession, ev: CalEvent) -> set[uuid.UUID]:
    """Who to tell about a change or cancellation: the guests still showing it.
    (Members of a shared calendar see changes there, but aren't pinged for
    each one — a busy family calendar shouldn't buzz all day.)"""
    atts = (await db.execute(select(CalAttendee.user_id).where(CalAttendee.event_id == ev.id, CalAttendee.hidden.is_(False)))).scalars()
    return set(atts)
