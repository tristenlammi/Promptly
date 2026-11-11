"""Finding things: who's free (``busy``) and searching your events.

``busy`` says only *when* someone isn't available — never what they're
doing, or on which calendar. All-day events don't count (a birthday or a
holiday doesn't make you busy), nor do ones they've declined or removed.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import core, recur
from .models import CalAttendee, CalCalendar, CalEvent, CalMember

UTC = timezone.utc
MAX_PEOPLE = 20
MAX_RANGE = timedelta(days=31)


async def busy(db: AsyncSession, user_ids: list[uuid.UUID], start: datetime, end: datetime) -> dict[str, list[list[str]]]:
    """Each person's busy stretches in [start, end), merged."""
    ids = list(dict.fromkeys(user_ids))[:MAX_PEOPLE]
    people = list((await db.execute(select(User).where(User.id.in_(ids), User.disabled.is_(False)))).scalars()) if ids else []
    out: dict[str, list[list[str]]] = {}
    for u in people:
        events = [e for e in await core.visible_events(db, u, start, end) if not e.all_day]
        atts = await core.attendees_of(db, [e.id for e in events])
        own = set(
            (await db.execute(select(CalCalendar.id).where(CalCalendar.owner_id == u.id, CalCalendar.personal.is_(True)))).scalars()
        )
        spans: list[tuple[datetime, datetime]] = []
        for ev in events:
            mine = next((a for a in atts.get(ev.id, []) if a.user_id == u.id), None)
            if mine is not None and (mine.hidden or mine.status == "declined"):
                continue
            # What makes *them* busy: their own calendar, what they're invited
            # to or said they'd go to, and what they put on a shared one — not
            # every event on a calendar someone shared with them.
            if not (ev.calendar_id in own or ev.created_by == u.id or (mine is not None and (mine.invited_by is not None or mine.status in ("going", "maybe")))):
                continue
            for s, e in recur.occurrences(
                start_at=ev.start_at, end_at=ev.end_at, all_day=False, tz_name=ev.tz,
                repeat=ev.repeat, exdates=ev.exdates, range_start=start, range_end=end,
            ):
                spans.append((max(s, start), min(e, end)))
        out[str(u.id)] = [[core.iso(s, False), core.iso(e, False)] for s, e in _merge(spans)]
    return out


def _merge(spans: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    merged: list[tuple[datetime, datetime]] = []
    for s, e in sorted(spans):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def search(db: AsyncSession, user: User, q: str, limit: int = 40) -> list[dict]:
    """Your events whose title, place or notes match — upcoming ones first
    (at their next occurrence), then past ones, most recent first."""
    q = q.strip()
    if not q:
        return []
    my_cals = select(CalMember.calendar_id).where(CalMember.user_id == user.id, CalMember.role != "busy")
    invited = select(CalAttendee.event_id).where(CalAttendee.user_id == user.id, CalAttendee.hidden.is_(False))
    removed = select(CalAttendee.event_id).where(CalAttendee.user_id == user.id, CalAttendee.hidden.is_(True))
    pat = _like(q)
    rows = list(
        (
            await db.execute(
                select(CalEvent)
                .where(
                    or_(CalEvent.calendar_id.in_(my_cals), CalEvent.id.in_(invited)),
                    ~CalEvent.id.in_(removed),
                    or_(CalEvent.title.ilike(pat), CalEvent.location.ilike(pat), CalEvent.description.ilike(pat)),
                )
                .order_by(CalEvent.start_at.desc())
                .limit(200)
            )
        ).scalars()
    )
    if not rows:
        return []
    now = core.now()
    atts = await core.attendees_of(db, [e.id for e in rows])
    mine = {
        m.calendar_id: m
        for m in (await db.execute(select(CalMember).where(CalMember.user_id == user.id, CalMember.calendar_id.in_({e.calendar_id for e in rows})))).scalars()
    }
    upcoming: list[tuple[datetime, dict]] = []
    past: list[tuple[datetime, dict]] = []
    for ev in rows:
        al = atts.get(ev.id, [])
        my_att = next((a for a in al if a.user_id == user.id), None)
        base = core.event_out(ev, mine.get(ev.calendar_id), my_att, al, user)
        nxt = recur.occurrences(
            start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
            exdates=ev.exdates, range_start=now, range_end=now + timedelta(days=400),
        )[:1]
        if nxt:
            s, e = nxt[0]
            upcoming.append((s, _at(base, ev, s, e)))
        else:
            s, e = _last(ev, now)
            past.append((s, _at(base, ev, s, e)))
    upcoming.sort(key=lambda x: x[0])
    past.sort(key=lambda x: x[0], reverse=True)
    found = [o for _, o in upcoming + past][:limit]
    from .labels import fill

    await fill(db, user, found)
    return found


def _at(base: dict, ev: CalEvent, s: datetime, e: datetime) -> dict:
    return {**base, "id": f"{ev.id}:{recur.stamp(s)}", "occurrence": recur.stamp(s), "start": core.iso(s, ev.all_day), "end": core.end_iso(e, ev.all_day)}


def _last(ev: CalEvent, now: datetime) -> tuple[datetime, datetime]:
    """The last occurrence before now (a finished series, or a past one-off)."""
    if not ev.repeat:
        return ev.start_at, ev.end_at
    hits = recur.occurrences(
        start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
        exdates=ev.exdates, range_start=max(ev.start_at, now - timedelta(days=400)), range_end=now,
    )
    return hits[-1] if hits else (ev.start_at, ev.end_at)
