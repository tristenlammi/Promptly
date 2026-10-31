"""Habit nudges: each habit at its reminder times on the days it's still
open (recomputed on every save — logging a habit removes the day's pending
reminder), an optional evening "still to do" summary, and a weekly review
reminder."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from app.items.spec import REMINDER_HORIZON, ItemContext, Reminder

from . import engine as E


def _moment(ctx: ItemContext, day: date, clock: str, day_ends_at: int) -> datetime:
    hh, mm = (int(x) for x in clock.split(":"))
    dt = datetime.combine(day, time(hh, mm), tzinfo=ctx.tz)
    if hh < day_ends_at:  # 1 am with a 3 am boundary is still this logical day
        dt += timedelta(days=1)
    return dt


def behind(required: int, done: int, p_start: date, p_end: date, day: date) -> bool:
    """Behind the pace for an X-per-period target by the end of ``day``: an
    even spread would have ``floor(required × elapsed / length)`` done by
    then (3× a week: 0 by Mon, 1 by Wed, 2 by Fri, 3 by Sun)."""
    length = (p_end - p_start).days + 1
    elapsed = (day - p_start).days + 1
    return done < (required * elapsed) // length


def open_on(h: dict, day: date, today: date, week_start: int, logs: dict) -> bool:
    """Is the habit still to do on ``day`` (as far as we know now)?"""
    start = E.start_of(h)
    if start is None or day < start:
        return False
    log = logs.get(day)
    if E.is_skipped(log):
        return False
    if day <= today and log is not None and E.is_met(h, log, day, today):
        return False
    if E.is_flexible(h):
        # The period's target already reached → no more nudges this period.
        ps = E.periods(h, today, week_start, logs)
        p_start, p_end = E.period_of(day, h["schedule"]["kind"], week_start)
        cur = next((p for p in ps if p["start"] == p_start), None)
        if cur is not None and cur["status"] in (E.DONE, E.NEUTRAL):
            return False
        days_ok = h.get("reminder_days") or []
        if days_ok and day.weekday() not in days_ok:
            return False
        if h.get("remind_when_behind"):
            required = cur["required"] if cur else int(h["schedule"].get("times") or 1)
            done = cur["done"] if cur else 0
            if not behind(required, done, p_start, p_end, day):
                return False
        return True
    return E.is_due(h, day, start)


def _short_list(names: list[str]) -> str:
    if len(names) <= 3:
        return ", ".join(names)
    return f"{', '.join(names[:3])} and {len(names) - 3} more"


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    s = data.get("settings") or {}
    if not s.get("reminders_on", True):
        return []
    boundary = int(s.get("day_ends_at") or 0)
    ws = int(s.get("week_start") or 0)
    today = E.logical_today(ctx.now, boundary)
    horizon = ctx.now + REMINDER_HORIZON
    out: list[Reminder] = []
    habits = E.active(data)
    logs_of = {h["id"]: E.logs_by_day(h) for h in habits}
    n_days = REMINDER_HORIZON.days + 1
    for offset in range(n_days):
        day = today + timedelta(days=offset)
        still: list[str] = []
        for h in habits:
            logs = logs_of[h["id"]]
            if not open_on(h, day, today, ws, logs):
                continue
            label = f"{h.get('emoji') + ' ' if h.get('emoji') else ''}{h['name']}"
            if not E.is_flexible(h):
                still.append(h["name"])
            for clock in h.get("reminders") or []:
                due = _moment(ctx, day, clock, boundary)
                if due <= ctx.now or due > horizon:
                    continue
                body = h.get("intention") or ""
                if not body:
                    goal = E.describe_goal(h)
                    body = {
                        "avoid": "Stay on track today — you've got this.",
                        "yes_no": "Time for your habit.",
                    }.get(h.get("type", "yes_no"), f"Today's goal: {goal}.")
                out.append(Reminder(key=f"habit:{h['id']}:{day.isoformat()}:{clock}", due_at=due, title=label, body=body))
        if s.get("evening_summary") and still:
            due = _moment(ctx, day, s.get("evening_time") or "21:00", boundary)
            if ctx.now < due <= horizon:
                n = len(still)
                out.append(
                    Reminder(
                        key=f"summary:{day.isoformat()}",
                        due_at=due,
                        title=f"{n} habit{'s' if n != 1 else ''} still to do",
                        body=f"{_short_list(still)} — a tiny version still counts.",
                    )
                )
        if s.get("review_reminder", True) and habits and day.weekday() == int(s.get("review_weekday", 6)):
            wk = E.week_start_of(day, ws).isoformat()
            done = next((r for r in data.get("reviews", []) if r.get("week") == wk and (r.get("wins") or r.get("notes") or r.get("insights"))), None)
            due = _moment(ctx, day, s.get("review_time") or "18:00", boundary)
            if done is None and ctx.now < due <= horizon:
                out.append(
                    Reminder(
                        key=f"review:{wk}",
                        due_at=due,
                        title="Your weekly habit review",
                        body="Two minutes: what went well, what got in the way, one tweak for next week.",
                    )
                )
    out.sort(key=lambda r: r.due_at)
    return out
