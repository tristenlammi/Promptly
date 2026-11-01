"""Task pushes: each open task's alerts (minutes before its due moment),
and an optional morning digest of the day's list. Recomputed on every save
— ticking a task off removes its pending alert."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from app.items.spec import REMINDER_HORIZON, ItemContext, Reminder

from . import logic as L


def _clock(day: date, clock: str, ctx: ItemContext) -> datetime:
    hh, mm = (int(x) for x in clock.split(":"))
    return datetime.combine(day, time(hh, mm), tzinfo=ctx.tz)


def _short(names: list[str]) -> str:
    if len(names) <= 3:
        return ", ".join(names)
    return f"{', '.join(names[:3])} and {len(names) - 3} more"


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    s = data.get("settings") or {}
    horizon = ctx.now + REMINDER_HORIZON
    out: list[Reminder] = []
    for t in data.get("tasks", []):
        if t["done"] or not t.get("due") or not t.get("alerts"):
            continue
        m = L.moment(t, s, ctx.tz)
        if m is None:
            continue
        for mins in t["alerts"]:
            at = m - timedelta(minutes=mins)
            if at <= ctx.now or at > horizon:
                continue
            if mins == 0:
                body = "Due now" if t.get("time") else "Due today"
            elif mins < 60:
                body = f"Due in {mins} min"
            elif mins % 1440 == 0:
                n = mins // 1440
                body = f"Due {'tomorrow' if n == 1 else f'in {n} days'}" + (f" at {t['time']}" if t.get("time") else "")
            elif mins % 60 == 0:
                body = f"Due in {mins // 60} h"
            else:
                body = f"Due at {t['time'] or s.get('default_time', '09:00')}"
            if t.get("notes"):
                body += f" · {t['notes'][:140]}"
            out.append(Reminder(key=f"task:{t['id']}:{t['due']}:{mins}", due_at=at, title=t["title"], body=body))
    if s.get("digest", True):
        today = ctx.now.date()
        open_tasks = [t for t in data.get("tasks", []) if not t["done"] and t.get("due")]
        for offset in range(REMINDER_HORIZON.days + 1):
            day = today + timedelta(days=offset)
            at = _clock(day, s.get("digest_time") or "08:00", ctx)
            if at <= ctx.now or at > horizon:
                continue
            d = day.isoformat()
            due = sorted([t for t in open_tasks if t["due"] == d], key=L.sort_key)
            # Overdue as of that morning (only knowable for today; later days
            # assume today's list gets done).
            late = [t for t in open_tasks if t["due"] < d] if offset == 0 else []
            if not due and not late:
                continue
            title = f"{len(due)} task{'s' if len(due) != 1 else ''} today" if due else "Nothing due today"
            if late:
                title += f" · {len(late)} overdue"
            names = [(f"{t['time']} " if t.get("time") else "") + t["title"] for t in due] or [t["title"] for t in late]
            out.append(Reminder(key=f"digest:{d}", due_at=at, title=title, body=_short(names)))
    out.sort(key=lambda r: r.due_at)
    return out[:200]
