"""Repeating tasks: the next due day after a completion. Mirrored exactly
by ``frontend/src/items/kinds/tasks/recur.ts`` (the app completes tasks
offline) — change both together.

Rules:
* From the schedule (default): the next occurrence after the current due
  day — but never on or before the day it was done, so a daily task done
  three days late comes back tomorrow, not on three past days.
* ``from_completion``: counted from the day it was done.
* Weekly with weekdays: the next listed weekday, in weeks that are a
  multiple of ``interval`` from the due day's week.
* Monthly keeps ``month_day`` (the 31st → 30 Apr → 31 May), yearly keeps
  the day (29 Feb → 28 Feb in other years).
* Past ``until`` → no next (the task is finished for good).
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta


def _add_months(d: date, n: int, dom: int) -> date:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(dom, calendar.monthrange(y, m)[1]))


def _step(rep: dict, d: date, anchor_dom: int, anchor: date) -> date:
    n = int(rep.get("interval") or 1)
    freq = rep.get("freq") or "weekly"
    if freq == "daily":
        return d + timedelta(days=n)
    if freq == "weekly":
        days = rep.get("weekdays") or []
        if not days:
            return d + timedelta(weeks=n)
        week0 = anchor - timedelta(days=anchor.weekday())
        c = d + timedelta(days=1)
        for _ in range(7 * n + 7):
            wk = ((c - week0).days // 7) % n
            if c.weekday() in days and wk == 0:
                return c
            c += timedelta(days=1)
        return d + timedelta(weeks=n)
    if freq == "monthly":
        return _add_months(d, n, int(rep.get("month_day") or anchor_dom))
    # yearly
    y = d.year + n
    return date(y, anchor.month, min(anchor.day, calendar.monthrange(y, anchor.month)[1]))


def next_due(rep: dict, due: str | None, done_day: str) -> str | None:
    """The day after ``due`` (or ``done_day``) the task is next due, or None."""
    done = date.fromisoformat(done_day)
    base = date.fromisoformat(due) if due else done
    if rep.get("from_completion"):
        base = done
    anchor_dom = rep.get("month_day") or base.day
    nxt = _step(rep, base, anchor_dom, base)
    guard = 0
    while nxt <= done and guard < 1000:
        nxt = _step(rep, nxt, anchor_dom, base)
        guard += 1
    until = rep.get("until")
    if until and nxt > date.fromisoformat(until):
        return None
    return nxt.isoformat()


_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def describe(rep: dict | None) -> str:
    """'every day', 'every 2 weeks on Mon, Thu', 'every month on the 15th'."""
    if not rep:
        return ""
    n = int(rep.get("interval") or 1)
    unit = {"daily": "day", "weekly": "week", "monthly": "month", "yearly": "year"}[rep.get("freq") or "weekly"]
    s = f"every {unit}" if n == 1 else f"every {n} {unit}s"
    wd = rep.get("weekdays") or []
    if rep.get("freq") == "weekly" and wd:
        s = "every weekday" if wd == [0, 1, 2, 3, 4] and n == 1 else f"{s} on {', '.join(_DAYS[d] for d in wd)}"
    if rep.get("freq") == "monthly" and rep.get("month_day"):
        d = int(rep["month_day"])
        suf = "th" if 11 <= d % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(d % 10, "th")
        s += f" on the {d}{suf}"
    if rep.get("from_completion"):
        s += " after done"
    if rep.get("until"):
        s += f" until {rep['until']}"
    return s
