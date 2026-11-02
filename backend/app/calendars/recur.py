"""Repeating events: ``repeat`` → occurrences, and → an iCalendar RRULE.

``repeat`` is ``{"freq": "daily"|"weekly"|"monthly"|"yearly", "interval": n,
"weekdays": [0-6] (Mon=0, weekly), "monthly": "day"|"weekday" (the 14th, or
the 2nd Tuesday), "until": "YYYY-MM-DD" | None, "count": n | None}``.

Timed series repeat in the event's own time zone, so a 9:00 meeting stays at
9:00 across a clock change. All-day ones repeat on dates.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import DAILY, MONTHLY, WEEKLY, YEARLY, rrule, weekday

UTC = timezone.utc
FREQS = {"daily": DAILY, "weekly": WEEKLY, "monthly": MONTHLY, "yearly": YEARLY}
_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
_WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MAX_OCCURRENCES = 1500


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def stamp(dt: datetime) -> str:
    """An occurrence's key: its start, in UTC (what ``exdates`` hold)."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    """A ``repeat`` with only known fields and sane values, or None."""
    if not raw or raw.get("freq") not in FREQS:
        return None
    out: dict[str, Any] = {"freq": raw["freq"], "interval": max(1, min(int(raw.get("interval") or 1), 99))}
    if raw["freq"] == "weekly":
        days = sorted({int(d) for d in (raw.get("weekdays") or []) if 0 <= int(d) <= 6})
        if days:
            out["weekdays"] = days
    if raw["freq"] == "monthly" and raw.get("monthly") == "weekday":
        out["monthly"] = "weekday"
    if raw.get("until"):
        out["until"] = date.fromisoformat(str(raw["until"])[:10]).isoformat()
    elif raw.get("count"):
        out["count"] = max(1, min(int(raw["count"]), 999))
    return out


def local_start(start_at: datetime, all_day: bool, tz: ZoneInfo) -> datetime:
    """The start as a wall-clock time (naive): in ``tz``, or the date for all-day."""
    if all_day:
        return start_at.astimezone(UTC).replace(tzinfo=None)
    return start_at.astimezone(tz).replace(tzinfo=None)


def _nth(d: datetime) -> weekday:
    """The "2nd Tuesday" (or "last Friday", for a 5th) a date is in its month."""
    n = (d.day - 1) // 7 + 1
    return weekday(d.weekday(), -1 if n == 5 else n)


def _rule(repeat: dict[str, Any], start_local: datetime) -> rrule:
    kw: dict[str, Any] = {"dtstart": start_local, "interval": repeat.get("interval", 1)}
    if repeat["freq"] == "weekly" and repeat.get("weekdays"):
        kw["byweekday"] = repeat["weekdays"]
    if repeat["freq"] == "monthly":
        if repeat.get("monthly") == "weekday":
            kw["byweekday"] = _nth(start_local)
        elif start_local.day == 31:
            kw["bymonthday"] = -1
        elif start_local.day > 28:
            # "The 30th" shouldn't skip February: the 30th, or the last day
            # when the month is shorter — the first of the two that exists.
            kw["bymonthday"] = (start_local.day, -1)
            kw["bysetpos"] = 1
    if repeat.get("until"):
        kw["until"] = datetime.combine(date.fromisoformat(repeat["until"]), time(23, 59, 59))
    elif repeat.get("count"):
        kw["count"] = repeat["count"]
    return rrule(FREQS[repeat["freq"]], **kw)


def _to_utc(local: datetime, all_day: bool, tz: ZoneInfo) -> datetime:
    return local.replace(tzinfo=UTC) if all_day else local.replace(tzinfo=tz).astimezone(UTC)


def occurrences(
    *,
    start_at: datetime,
    end_at: datetime,
    all_day: bool,
    tz_name: str,
    repeat: dict[str, Any] | None,
    exdates: list[str] | None,
    range_start: datetime,
    range_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """(start, end) of each occurrence overlapping [range_start, range_end)."""
    duration = end_at - start_at
    if not repeat:
        return [(start_at, end_at)] if start_at < range_end and end_at > range_start else []
    tz = zone(tz_name)
    rule = _rule(repeat, local_start(start_at, all_day, tz))
    # Search a little wider in wall-clock time, then filter exactly in UTC.
    a = local_start(range_start - duration, all_day, tz) - timedelta(days=1)
    b = local_start(range_end, all_day, tz) + timedelta(days=1)
    skip = set(exdates or [])
    out: list[tuple[datetime, datetime]] = []
    for local in rule.between(a, b, inc=True):
        s = _to_utc(local, all_day, tz)
        e = s + duration
        if s < range_end and e > range_start and stamp(s) not in skip:
            out.append((s, e))
            if len(out) >= MAX_OCCURRENCES:
                break
    return out


def last_end(*, start_at: datetime, end_at: datetime, all_day: bool, tz_name: str, repeat: dict[str, Any] | None) -> datetime | None:
    """When the final occurrence ends — None for a series that never ends."""
    if not repeat:
        return end_at
    if not repeat.get("until") and not repeat.get("count"):
        return None
    tz = zone(tz_name)
    last = None
    for i, local in enumerate(_rule(repeat, local_start(start_at, all_day, tz))):
        last = local
        if i > 20000:
            return None
    if last is None:
        return end_at
    return _to_utc(last, all_day, tz) + (end_at - start_at)


def rrule_text(repeat: dict[str, Any], start_at: datetime, all_day: bool, tz_name: str) -> str:
    """The series as an iCalendar RRULE value (for the subscribe feed)."""
    parts = [f"FREQ={repeat['freq'].upper()}"]
    if repeat.get("interval", 1) > 1:
        parts.append(f"INTERVAL={repeat['interval']}")
    start_local = local_start(start_at, all_day, zone(tz_name))
    if repeat["freq"] == "weekly" and repeat.get("weekdays"):
        parts.append("BYDAY=" + ",".join(_DAYS[d] for d in repeat["weekdays"]))
    if repeat["freq"] == "monthly":
        if repeat.get("monthly") == "weekday":
            parts.append(f"BYDAY={_nth(start_local).n}{_DAYS[start_local.weekday()]}")
        elif start_local.day > 28:
            parts.append("BYMONTHDAY=-1" if start_local.day == 31 else f"BYMONTHDAY={start_local.day},-1;BYSETPOS=1")
    if repeat.get("until"):
        u = date.fromisoformat(repeat["until"])
        if all_day:
            parts.append(f"UNTIL={u.strftime('%Y%m%d')}")
        else:
            end_local = datetime.combine(u, time(23, 59, 59)).replace(tzinfo=zone(tz_name))
            parts.append("UNTIL=" + end_local.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ"))
    elif repeat.get("count"):
        parts.append(f"COUNT={repeat['count']}")
    return ";".join(parts)


def describe(repeat: dict[str, Any] | None, start_local: datetime | None = None) -> str:
    """"Every 2 weeks on Mon, Wed" — for the AI and the feed."""
    if not repeat:
        return ""
    n = repeat.get("interval", 1)
    unit = {"daily": "day", "weekly": "week", "monthly": "month", "yearly": "year"}[repeat["freq"]]
    text = f"Every {unit}" if n == 1 else f"Every {n} {unit}s"
    if repeat.get("weekdays"):
        text += " on " + ", ".join(_WD[d] for d in repeat["weekdays"])
    if repeat["freq"] == "monthly" and repeat.get("monthly") == "weekday" and start_local is not None:
        nth = _nth(start_local).n
        text += f" on the {'last' if nth == -1 else ['1st', '2nd', '3rd', '4th'][nth - 1]} {_WD[start_local.weekday()]}"
    if repeat.get("until"):
        text += f", until {repeat['until']}"
    elif repeat.get("count"):
        text += f", {repeat['count']} times"
    return text
