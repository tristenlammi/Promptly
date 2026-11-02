"""Calendar reminders, in-process (one uvicorn worker).

Every 30 s: for each occurrence starting in the next week, each person who
sees it gets each of their reminders once, when it comes due (a row in
``cal_reminders_sent`` claims it, so a restart or a second pass never sends
it twice). One overdue by more than 10 minutes — the server was down — is
skipped rather than sent late.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.database import SessionLocal

logger = logging.getLogger("promptly.calendar.loops")

_TICK_S = 30
_GRACE = timedelta(minutes=10)
_AHEAD = timedelta(days=8)  # longest reminder offered is a week


async def send_due(db, now: datetime | None = None) -> int:  # noqa: ANN001
    from app.auth.models import User

    from . import core, notify, recur
    from .models import CalAttendee, CalCalendar, CalEvent, CalMember, CalReminderSent

    now = now or datetime.now(timezone.utc)
    events = list((await db.execute(select(CalEvent).where(core.in_range_filter(now - _GRACE, now + _AHEAD)))).scalars())
    if not events:
        return 0
    atts = await core.attendees_of(db, [e.id for e in events])
    # Who's reminded of a calendar's events by default: everyone on a shared
    # calendar ("Family"), but only the owner of someone's own calendar —
    # sharing yours lets them see it, not get your dentist reminders.
    members: dict[uuid.UUID, list[uuid.UUID]] = {}
    cal_ids = {e.calendar_id for e in events}
    personal = {c.id: c.owner_id for c in (await db.execute(select(CalCalendar).where(CalCalendar.id.in_(cal_ids), CalCalendar.personal.is_(True)))).scalars()}
    for cid, uid, role in (await db.execute(select(CalMember.calendar_id, CalMember.user_id, CalMember.role).where(CalMember.calendar_id.in_(cal_ids)))).all():
        if role == "busy" or (cid in personal and uid != personal[cid]):
            continue
        members.setdefault(cid, []).append(uid)
    everyone = {uid for ids in members.values() for uid in ids} | {a.user_id for al in atts.values() for a in al}
    users: dict[uuid.UUID, User] = {
        u.id: u for u in (await db.execute(select(User).where(User.id.in_(everyone)))).scalars()
    } if everyone else {}
    sent = 0
    for ev in events:
        # Who gets reminded, and of what: calendar members get the event's
        # reminders; guests their own (or the event's) unless they said no.
        plan: dict[uuid.UUID, list[int]] = {uid: list(ev.reminders or []) for uid in members.get(ev.calendar_id, [])}
        for a in atts.get(ev.id, []):
            if a.hidden or a.status == "declined":
                plan.pop(a.user_id, None)
                continue
            if a.invited_by is None and a.reminders is None and a.user_id not in plan:
                continue  # a member's answer row, on a calendar that doesn't remind them
            plan[a.user_id] = core.reminders_for(ev, a)
        if not any(plan.values()):
            continue
        longest = timedelta(minutes=max((m for ms in plan.values() for m in ms), default=0))
        if ev.all_day:
            longest += timedelta(days=1)  # all-day reminders count from 9:00 local
        for start, _end in recur.occurrences(
            start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz,
            repeat=ev.repeat, exdates=ev.exdates, range_start=now - _GRACE, range_end=now + longest + _GRACE,
        ):
            for uid, minutes in plan.items():
                for m in minutes:
                    due = _due(start, m, ev.all_day, ev.tz, users.get(uid))
                    if not (now - _GRACE < due <= now):
                        continue
                    claimed = await db.execute(
                        insert(CalReminderSent)
                        .values(event_id=ev.id, user_id=uid, occurrence=start, minutes=m)
                        .on_conflict_do_nothing(constraint="uq_cal_reminders_sent")
                        .returning(CalReminderSent.id)
                    )
                    if claimed.scalar_one_or_none() is None:
                        continue
                    user = users.get(uid)
                    if user is None or user.disabled:
                        continue
                    await notify.reminder(user, ev, start, m)
                    sent += 1
    await db.commit()
    return sent


def _due(start: datetime, minutes: int, all_day: bool, tz_name: str, user) -> datetime:  # noqa: ANN001
    """When a reminder fires. All-day events count from 9:00 on the day, in
    the person's own zone (so "1 day before" is 9:00 the day before)."""
    if not all_day:
        return start - timedelta(minutes=minutes)
    from . import recur

    tz = recur.zone(str(((user.settings or {}) if user else {}).get("timezone") or tz_name))
    nine = datetime.combine(start.date(), datetime.min.time()).replace(hour=9, tzinfo=tz)
    return nine.astimezone(timezone.utc) - timedelta(minutes=minutes)


async def _prune(db) -> None:  # noqa: ANN001
    from .models import CalReminderSent

    await db.execute(delete(CalReminderSent).where(CalReminderSent.sent_at < datetime.now(timezone.utc) - timedelta(days=30)))
    await db.commit()


async def _loop() -> None:
    logger.info("Calendar reminders started")
    last_prune = datetime.min.replace(tzinfo=timezone.utc)
    while True:
        try:
            async with SessionLocal() as db:
                await send_due(db)
            if datetime.now(timezone.utc) - last_prune > timedelta(days=1):
                last_prune = datetime.now(timezone.utc)
                async with SessionLocal() as db:
                    await _prune(db)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("calendar reminder pass failed")
        await asyncio.sleep(_TICK_S)


def start_calendar_loops() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="calendar_loops")
