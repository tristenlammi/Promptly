"""Calendar notifications (category ``calendar``): invites, changes,
cancellations, answers back to the organiser, and reminders. Times are
written in each recipient's own time zone."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.notifications import actions

from . import recur
from .models import CalEvent

logger = logging.getLogger("promptly.calendar.notify")

_ANSWER = {"going": "is going to", "maybe": "might go to", "declined": "can't make"}


def when_text(start: datetime, end: datetime, all_day: bool, tz_name: str) -> str:
    """"Sat 3 Nov, 2:00 pm" / "Sat 3 – Mon 5 Nov" in someone's time zone."""
    if all_day:
        s = start.date()
        last = (end - timedelta(days=1)).date()
        if last <= s:
            return f"{s:%a} {s.day} {s:%b}"
        return f"{s:%a} {s.day} – {last:%a} {last.day} {last:%b}"
    local = start.astimezone(recur.zone(tz_name))
    hour = local.strftime("%I:%M %p").lstrip("0").lower().replace(":00 ", " ")
    return f"{local:%a} {local.day} {local:%b}, {hour}"


async def _users(db: AsyncSession, ids: set[uuid.UUID]) -> list[User]:
    if not ids:
        return []
    return list((await db.execute(select(User).where(User.id.in_(ids), User.disabled.is_(False)))).scalars())


def _url(ev: CalEvent) -> str:
    return f"/calendar/?event={ev.id}"


async def _send(
    user: User, title: str, body: str, ev_id: uuid.UUID, url: str, actor: uuid.UUID | None, inbox: bool = True,
    extra: dict | None = None,
) -> None:
    from app.notifications.dispatch import notify_user

    await notify_user(
        user_id=user.id, category="calendar", title=title, body=body, url=url,
        tag=f"cal:{ev_id}", actor_user_id=actor, inbox=inbox, extra=extra,
    )


async def invited(db: AsyncSession, ev: CalEvent, actor: User, user_ids: set[uuid.UUID]) -> None:
    for u in await _users(db, user_ids - {actor.id}):
        when = when_text(ev.start_at, ev.end_at, ev.all_day, _tz(u))
        # Answer from the notification itself (app/notifications/actions.py).
        buttons = actions.buttons(u, ("cal_going", str(ev.id)), ("cal_declined", str(ev.id)))
        await _send(u, f"{actor.username} invited you", f"{ev.title} · {when}", ev.id, _url(ev), actor.id, extra=buttons)


async def added_to_calendar(db: AsyncSession, cal_name: str, actor: User, user_ids: set[uuid.UUID], own: bool = False) -> None:
    from app.notifications.dispatch import notify_user

    for u in await _users(db, user_ids - {actor.id}):
        if own:
            title, body = f"{actor.username} shared their calendar", f"{actor.username}'s calendar now shows on yours."
        else:
            title, body = f"{actor.username} shared a calendar", f"You're on “{cal_name}” — its events now show on your calendar."
        await notify_user(user_id=u.id, category="calendar", title=title, body=body, url="/calendar/", actor_user_id=actor.id)


async def changed(db: AsyncSession, ev: CalEvent, actor: User, user_ids: set[uuid.UUID]) -> None:
    for u in await _users(db, user_ids - {actor.id}):
        when = when_text(ev.start_at, ev.end_at, ev.all_day, _tz(u))
        await _send(u, f"{actor.username} changed an event", f"{ev.title} · now {when}", ev.id, _url(ev), actor.id)


async def cancelled(db: AsyncSession, ev: CalEvent, actor: User, user_ids: set[uuid.UUID], occurrence: datetime | None = None) -> None:
    for u in await _users(db, user_ids - {actor.id}):
        start = occurrence or ev.start_at
        when = when_text(start, start + (ev.end_at - ev.start_at), ev.all_day, _tz(u))
        what = "cancelled one" if occurrence else "cancelled"
        await _send(u, f"{actor.username} {what}", f"{ev.title} · {when}", ev.id, "/calendar/", actor.id)


async def answered(db: AsyncSession, ev: CalEvent, responder: User, status: str) -> None:
    if ev.created_by is None or ev.created_by == responder.id or status not in _ANSWER:
        return
    for u in await _users(db, {ev.created_by}):
        await _send(u, f"{responder.username} {_ANSWER[status]}", ev.title, ev.id, _url(ev), responder.id)


async def reminder(user: User, ev: CalEvent, start: datetime, minutes: int) -> None:
    end = start + (ev.end_at - ev.start_at)
    when = when_text(start, end, ev.all_day, _tz(user))
    if minutes == 0:
        lead = "Now"
    elif minutes < 60:
        lead = f"In {minutes} min"
    elif minutes % 1440 == 0:
        days = minutes // 1440
        lead = "Tomorrow" if days == 1 else f"In {days} days"
    else:
        lead = f"In {minutes // 60} h" + (f" {minutes % 60} min" if minutes % 60 else "")
    body = f"{lead} · {when}" + (f" · {ev.location}" if ev.location else "")
    # "Snooze 10 min" while there's still something to be reminded of.
    extra = None
    if not ev.all_day and start > datetime.now(timezone.utc) + timedelta(minutes=10):
        extra = actions.buttons(user, ("cal_snooze", f"{ev.id}|{recur.stamp(start)}"))
    await _send(user, ev.title, body, ev.id, _url(ev), None, inbox=False, extra=extra)


async def answered_by_email(db: AsyncSession, ev: CalEvent, who: str, status: str) -> None:
    """Someone invited by email answered from the link in it."""
    if ev.created_by is None or status not in _ANSWER:
        return
    for u in await _users(db, {ev.created_by}):
        await _send(u, f"{who} {_ANSWER[status]}", ev.title, ev.id, _url(ev), None)


def _tz(u: User) -> str:
    return str((u.settings or {}).get("timezone") or "UTC")
