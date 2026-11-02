"""Task pushes: each open task's alerts (minutes before its due moment).
Recomputed on every save — ticking a task off removes its pending alert.

The morning list is no longer sent from here: it's part of the one Today
summary push (:mod:`app.today.push`), which still reads this app's
``digest`` / ``digest_time`` settings."""
from __future__ import annotations

from datetime import timedelta

from app.items.spec import REMINDER_HORIZON, ItemContext, Reminder

from . import logic as L


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
    out.sort(key=lambda r: r.due_at)
    return out[:200]
