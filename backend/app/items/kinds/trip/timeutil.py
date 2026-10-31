"""Time zones and money — the two things a trip planner must get exactly
right.

A booking endpoint is a wall-clock local time plus an IANA zone. Turning it
into an instant uses the zone database (DST, historical offsets, the date
line). A wall time that doesn't exist (inside a spring-forward gap) or
exists twice (a fall-back hour) is resolved the way Python's ``fold=0``
does: the gap time is read with the offset in force *before* the change
(so 02:30 on the US spring-forward night means 03:30 daylight time) and an
ambiguous time is the *first* occurrence. The frontend does the same.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ------------------------------------------------------------------ zones


def zone(name: str | None, fallback: ZoneInfo | None = None) -> ZoneInfo:
    if name:
        try:
            return ZoneInfo(name)
        except Exception:  # noqa: BLE001
            pass
    return fallback or ZoneInfo("UTC")


def parse_local(s: str) -> datetime:
    """``YYYY-MM-DDTHH:MM`` → a naive datetime."""
    return datetime.fromisoformat(s)


def instant(local: str | None, tz: str | None, fallback: ZoneInfo | None = None) -> datetime | None:
    """The aware moment a local wall time in ``tz`` refers to."""
    if not local:
        return None
    try:
        naive = parse_local(local)
    except ValueError:
        return None
    return naive.replace(tzinfo=zone(tz, fallback), fold=0)


def in_gap(local: str, tz: str) -> bool:
    """True when ``local`` doesn't exist in ``tz`` (a spring-forward gap)."""
    at = instant(local, tz)
    if at is None:
        return False
    back = at.astimezone(timezone.utc).astimezone(at.tzinfo).replace(tzinfo=None)
    return back != parse_local(local)


def to_local(at: datetime, tz: str | None, fallback: ZoneInfo | None = None) -> str:
    """An aware moment as a wall time in ``tz`` (``YYYY-MM-DDTHH:MM``)."""
    return at.astimezone(zone(tz, fallback)).strftime("%Y-%m-%dT%H:%M")


def duration(start: str | None, start_tz: str | None, end: str | None, end_tz: str | None,
             fallback: ZoneInfo | None = None) -> timedelta | None:
    a = instant(start, start_tz, fallback)
    b = instant(end, end_tz, fallback)
    if a is None or b is None:
        return None
    return b.astimezone(timezone.utc) - a.astimezone(timezone.utc)


def booking_duration(b: dict, fallback: ZoneInfo | None = None) -> timedelta | None:
    """A booking's length; an end with no zone of its own is read in the
    start's zone (the frontend's ``bookingMinutes`` does the same)."""
    return duration(b.get("start"), b.get("start_tz"), b.get("end"), b.get("end_tz") or b.get("start_tz"), fallback)


def fmt_duration(td: timedelta | None) -> str:
    if td is None:
        return ""
    mins = half_up(td.total_seconds() / 60)
    sign = "-" if mins < 0 else ""
    mins = abs(mins)
    h, m = divmod(mins, 60)
    if h and m:
        return f"{sign}{h}h {m:02d}m"
    if h:
        return f"{sign}{h}h"
    return f"{sign}{m}m"


def zone_abbr(local: str | None, tz: str | None) -> str:
    at = instant(local, tz)
    if at is None or not tz:
        return ""
    return at.strftime("%Z")


def day_of(local: str | None) -> str | None:
    return local[:10] if local else None


def time_of(local: str | None) -> str:
    return local[11:16] if local and len(local) >= 16 else ""


def date_range(start: str | None, end: str | None, cap: int = 400) -> list[str]:
    if not start:
        return []
    a = date.fromisoformat(start)
    b = date.fromisoformat(end) if end else a
    if b < a:
        a, b = b, a
    out = []
    cur = a
    while cur <= b and len(out) < cap:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


# ------------------------------------------------------------------ money

# ISO 4217 minor-unit exponents that aren't 2.
_EXPONENT = {
    "BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0, "PYG": 0,
    "RWF": 0, "UGX": 0, "UYI": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0,
    "BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
}


def half_up(x: float) -> int:
    """Round half up, like JavaScript's ``Math.round`` (Python's ``round``
    rounds half to even, so 0.5 cents would land differently in the UI)."""
    return int(math.floor(x + 0.5))


def exponent(code: str | None) -> int:
    return _EXPONENT.get((code or "").upper(), 2)


def to_minor(amount: float, code: str) -> int:
    return half_up(float(amount) * 10 ** exponent(code))


def to_major(minor: int, code: str) -> float:
    return minor / 10 ** exponent(code)


def fmt_money(minor: int | None, code: str) -> str:
    if minor is None:
        return ""
    e = exponent(code)
    v = minor / 10**e
    return f"{code} {v:,.{e}f}"


def rate_for(data: dict, code: str | None) -> float | None:
    """Units of ``code`` per 1 home unit (1.0 for the home currency)."""
    home = data.get("settings", {}).get("home_currency", "AUD")
    code = (code or home).upper()
    if code == home:
        return 1.0
    for r in data.get("currencies", []):
        if r.get("code") == code:
            return float(r["per_home"])
    return None


def to_home(data: dict, minor: int | None, code: str | None, per_home: float | None = None) -> int | None:
    """``minor`` units of ``code`` in home-currency minor units (None when
    there's no rate for it)."""
    if minor is None:
        return None
    home = data.get("settings", {}).get("home_currency", "AUD")
    code = (code or home).upper()
    rate = per_home if per_home else rate_for(data, code)
    if rate is None:
        return None
    if code == home:
        return int(minor)
    major = minor / 10 ** exponent(code)
    return half_up(major / rate * 10 ** exponent(home))
