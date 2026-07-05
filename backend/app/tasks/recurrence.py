"""Compute a task's next fire time from its structured recurrence.

All arithmetic happens in the task's local timezone (so "daily at 7:00"
means 7am *there*, surviving DST) and the result is returned in UTC for
storage/comparison against ``now()``.

Kept dependency-free (stdlib ``zoneinfo`` only — Python 3.11) and pure so
it's trivially unit-testable: given a task-shaped object and an "after"
instant, it returns the next instant strictly after it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VALID_FREQUENCIES = {"minutes", "hourly", "daily", "weekly", "monthly"}
# "minutes" interval bounds — floor keeps a runaway config from hammering
# the model budget; ceiling of 12h because beyond that "hourly/daily" fits.
MIN_INTERVAL_MINUTES = 5
MAX_INTERVAL_MINUTES = 720
DEFAULT_TZ = "Australia/Sydney"


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo(DEFAULT_TZ)


def _advance_month(d: datetime, dom: int) -> datetime:
    """Return ``d`` moved to the next month, clamped to a valid day."""
    year = d.year + (1 if d.month == 12 else 0)
    month = 1 if d.month == 12 else d.month + 1
    # Clamp day_of_month into the target month (e.g. 31 → 28/30).
    day = min(dom, _days_in_month(year, month))
    return d.replace(year=year, month=month, day=day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        nxt = datetime(year + 1, 1, 1)
    else:
        nxt = datetime(year, month + 1, 1)
    return (nxt - timedelta(days=1)).day


def compute_next_run(
    *,
    frequency: str,
    after: datetime,
    hour: int | None = None,
    minute: int = 0,
    weekday: int | None = None,
    day_of_month: int | None = None,
    tz_name: str | None = None,
    interval_minutes: int | None = None,
    weekdays: list[int] | None = None,
) -> datetime:
    """Next fire time strictly after ``after`` (a tz-aware UTC instant).

    ``interval_minutes`` drives the ``minutes`` frequency (every N minutes,
    aligned to boundaries from local midnight so :00/:15/:30/:45 for 15).
    ``weekdays`` (E-batch) is the weekly multi-day set — when non-empty it
    supersedes the single ``weekday``.

    Returns a tz-aware UTC ``datetime``.
    """
    if after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    tz = _zone(tz_name)
    now = after.astimezone(tz)
    minute = max(0, min(59, int(minute or 0)))
    hh = 0 if hour is None else max(0, min(23, int(hour)))

    if frequency == "minutes":
        step = max(
            MIN_INTERVAL_MINUTES,
            min(MAX_INTERVAL_MINUTES, int(interval_minutes or 15)),
        )
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        elapsed = (now - midnight).total_seconds() / 60
        # Next boundary strictly after "now".
        ticks = int(elapsed // step) + 1
        cand = midnight + timedelta(minutes=ticks * step)

    elif frequency == "hourly":
        cand = now.replace(minute=minute, second=0, microsecond=0)
        if cand <= now:
            cand += timedelta(hours=1)

    elif frequency == "daily":
        cand = now.replace(hour=hh, minute=minute, second=0, microsecond=0)
        if cand <= now:
            cand += timedelta(days=1)

    elif frequency == "weekly":
        # Multi-day set (E-batch) supersedes the single weekday when set.
        day_set = sorted(
            {max(0, min(6, int(d))) for d in (weekdays or [])}
        ) or [0 if weekday is None else max(0, min(6, int(weekday)))]
        base = now.replace(hour=hh, minute=minute, second=0, microsecond=0)
        best: datetime | None = None
        for target in day_set:
            days_ahead = (target - now.weekday()) % 7
            cand_d = base + timedelta(days=days_ahead)
            if cand_d <= now:
                cand_d += timedelta(days=7)
            if best is None or cand_d < best:
                best = cand_d
        cand = best

    elif frequency == "monthly":
        dom = 1 if day_of_month is None else max(1, min(28, int(day_of_month)))
        day = min(dom, _days_in_month(now.year, now.month))
        cand = now.replace(
            day=day, hour=hh, minute=minute, second=0, microsecond=0
        )
        if cand <= now:
            cand = _advance_month(cand, dom)

    else:
        raise ValueError(f"Unknown frequency: {frequency!r}")

    return cand.astimezone(timezone.utc)


def describe_schedule(
    *,
    frequency: str,
    hour: int | None = None,
    minute: int = 0,
    weekday: int | None = None,
    day_of_month: int | None = None,
    tz_name: str | None = None,
    interval_minutes: int | None = None,
    weekdays: list[int] | None = None,
) -> str:
    """Human-readable one-liner, e.g. 'Daily · 07:00 (Australia/Sydney)'."""
    hhmm = f"{(hour or 0):02d}:{(minute or 0):02d}"
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    tz = tz_name or DEFAULT_TZ
    if frequency == "minutes":
        return f"Every {int(interval_minutes or 15)} min ({tz})"
    if frequency == "hourly":
        return f"Hourly · at :{(minute or 0):02d} ({tz})"
    if frequency == "daily":
        return f"Daily · {hhmm} ({tz})"
    if frequency == "weekly":
        day_set = sorted({d for d in (weekdays or []) if 0 <= int(d) <= 6})
        if day_set:
            names = "/".join(days[int(d)] for d in day_set)
            return f"Weekly · {names} {hhmm} ({tz})"
        d = days[weekday] if weekday is not None and 0 <= weekday <= 6 else "Mon"
        return f"Weekly · {d} {hhmm} ({tz})"
    if frequency == "monthly":
        return f"Monthly · day {day_of_month or 1} {hhmm} ({tz})"
    return frequency
