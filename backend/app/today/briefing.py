""""Read me my day" (Talk phase 2, WP-T12).

A short spoken briefing, written here from the Today page's own sections
(``core.build`` + ``hub.extend``), with **no model call**: it's quick, it can't
invent anything, and what it says is what Today shows. In order:

* ``weather``: one line (``weather.py``, if the admin left it on and you've
  saved a Home place);
* ``events``: how many today, the first three with their times, and when to
  leave for the first one that has a place (the maps "Getting there" card);
* ``tasks``: how many due today and overdue, and the top two;
* ``bills``: bills due today and the next few days (Budget);
* ``birthdays``: today and tomorrow (Contacts);
* ``mail``: how many unread emails (left out in the car);
* then "That's it."

At most :data:`MAX_WORDS` words (about 45 seconds): later sections give way
first. A section that fails is left out silently, as on Today. Which sections
it reads is yours to choose (Account -> Voice, ``users.settings
.briefing_sections``).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.today")

SECTIONS = ("weather", "events", "tasks", "bills", "birthdays", "mail")
MAX_WORDS = 120
END = "That's it."
# Asked for in any Talk conversation (the fast path, no model).
PHRASES = (
    "read me my day", "read my day", "brief me", "morning briefing", "my morning briefing", "give me my briefing",
    "read me my briefing", "whats my day", "what's my day",
)


def asked(words: str) -> bool:
    plain = " ".join("".join(ch for ch in words.lower() if ch.isalnum() or ch in " '").split())
    plain = plain.removeprefix("hey promptly ").removeprefix("promptly ").removeprefix("please ").removesuffix(" please")
    return plain in PHRASES or plain.replace("'", "") in PHRASES


def chosen(user: User) -> tuple[str, ...]:
    raw = (user.settings or {}).get("briefing_sections")
    if not isinstance(raw, list):
        return SECTIONS
    return tuple(s for s in SECTIONS if s in raw)


def _clock(iso: str, tz: Any) -> str:
    try:
        at = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if at.tzinfo is not None:
        at = at.astimezone(tz)
    return f"{at.hour % 12 or 12}" + (f":{at.minute:02d}" if at.minute else "") + (" AM" if at.hour < 12 else " PM")


def _and(parts: list[str]) -> str:
    parts = [p for p in parts if p]
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + f" and {parts[-1]}"


def _n(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def events_line(sec: dict[str, Any], tz: Any) -> str | None:
    if "events" not in sec:
        return None
    events = [e for e in (sec["events"].get("events") or []) if not e.get("declined")]
    if not events:
        return "Nothing on your calendar today."
    said = []
    for e in events[:3]:
        title = " ".join(str(e.get("title") or "Something").split())[:60]
        said.append(title if e.get("all_day") else f"{title} at {_clock(e.get('start') or '', tz)}")
    more = len(events) - 3
    line = f"{'One thing' if len(events) == 1 else str(len(events)) + ' things'} today: {_and(said)}"
    line += f", and {_n(more, 'more')}." if more > 0 else "."
    nxt = ((sec.get("maps") or {}).get("next")) or None
    if nxt and nxt.get("leave_by_label"):
        line += f" Leave by {nxt['leave_by_label'].upper().replace('AM', 'AM').replace('PM', 'PM')} for {str(nxt.get('title') or 'it')[:60]}."
    return line


def tasks_line(sec: dict[str, Any]) -> str | None:
    t = sec.get("tasks")
    if not t:
        return None
    today, overdue = int(t.get("today_count") or 0), int(t.get("overdue_count") or 0)
    if not today and not overdue:
        return "No tasks due today."
    bits = []
    if today:
        bits.append(_n(today, "task") + " due today")
    if overdue:
        bits.append(f"{overdue} overdue")
    top = [str(x.get("title") or "")[:60] for x in (t.get("overdue") or []) + (t.get("today") or [])][:2]
    return f"{_and(bits).capitalize()}" + (f": {_and(top)}." if top else ".")


def bills_line(sec: dict[str, Any], today: date) -> str | None:
    b = sec.get("budget")
    bills = [x for x in (b or {}).get("bills") or [] if x.get("date")]
    if not bills:
        return None
    said = []
    for x in bills[:2]:
        try:
            d = date.fromisoformat(str(x["date"])[:10])
        except ValueError:
            continue
        when = "today" if d == today else "tomorrow" if d == today + timedelta(days=1) else f"on {d:%A}"
        said.append(f"{str(x.get('name') or 'a bill')[:40]}, {x.get('amount')}, {when}")
    return f"Bills due: {_and(said)}." if said else None


def birthdays_line(sec: dict[str, Any]) -> str | None:
    dates = [x for x in (sec.get("people") or {}).get("dates") or [] if x.get("kind") == "birthday" and x.get("in_days") in (0, 1)]
    if not dates:
        return None
    today = [str(x["name"])[:40] for x in dates if x["in_days"] == 0]
    tomorrow = [str(x["name"])[:40] for x in dates if x["in_days"] == 1]
    parts = []
    if today:
        parts.append(f"It's {_and(today)}'s birthday today.")
    if tomorrow:
        parts.append(f"{_and(tomorrow)}'s birthday is tomorrow.")
    return " ".join(parts)


def mail_line(sec: dict[str, Any]) -> str | None:
    m = sec.get("mail")
    if not m:
        return None
    n = int(m.get("unread") or 0)
    return f"{_n(n, 'unread email')}." if n else "No unread email."


def _cap(parts: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Keep it under MAX_WORDS: later sections give way first."""
    out = list(parts)
    while out and sum(len(t.split()) for _, t in out) + len(END.split()) > MAX_WORDS:
        out.pop()
    return out


async def build(db: AsyncSession, user: User, *, car: bool = False, now: datetime | None = None) -> dict[str, Any]:
    """``{"script", "sections": [{key, text}]}`` for this person, now."""
    from . import core, hub, weather

    tz = core.zone_of(user)
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    want = set(chosen(user))
    if car:
        want.discard("mail")
    day = await core.build(db, user, now, photos=False)
    try:
        await hub.extend(db, user, day)
    except Exception:  # noqa: BLE001 - what core made still makes a briefing
        logger.exception("briefing: the hub's sections failed")
    sec = day.get("sections") or {}
    makers = {
        "events": lambda: events_line(sec, tz),
        "tasks": lambda: tasks_line(sec),
        "bills": lambda: bills_line(sec, now.date()),
        "birthdays": lambda: birthdays_line(sec),
        "mail": lambda: mail_line(sec),
    }
    parts: list[tuple[str, str]] = []
    for key in SECTIONS:
        if key not in want:
            continue
        try:
            text = await weather.line(db, user, now) if key == "weather" else makers[key]()
        except Exception:  # noqa: BLE001 - one section's trouble costs only that section
            logger.exception("briefing: %s failed", key)
            text = None
        if text:
            parts.append((key, text))
    parts = _cap(parts)
    greeting = core.greeting(now, user)
    script = " ".join([f"{greeting}.", *(t for _, t in parts), END]) if parts else f"{greeting}. There's nothing on today. {END}"
    return {"script": script, "sections": [{"key": k, "text": t} for k, t in parts], "greeting": greeting}
