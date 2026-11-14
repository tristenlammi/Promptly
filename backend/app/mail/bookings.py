"""A stay or a booked day found in an email, for Today, before it's on your
calendar.

No model: only dates written out plainly next to a label ("Check-in: Fri 21
Nov 2026") are trusted, because a wrong guess on Today is worse than none.
Nothing is added to the calendar until you tap; a dismissal is remembered in
your settings; and once the calendar holds the event it isn't shown again.
The email is read as text, never followed as instructions.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.auth.models import User

from . import hints
from .models import MailMessage

LOOK_BACK = timedelta(days=120)
LOOK_AHEAD_DAYS = 365
MAX_NIGHTS = 60
MAX_SCANNED = 60
MAX_SHOWN = 4
MAX_DISMISSED = 200
SETTING = "mail_bookings_dismissed"

_MONTHS = {m: i + 1 for i, names in enumerate([
    ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",), ("jun", "june"),
    ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"), ("dec", "december"),
]) for m in names}
_DAYS = {d: i for i, names in enumerate([
    ("mon", "monday"), ("tue", "tues", "tuesday"), ("wed", "wednesday"), ("thu", "thur", "thurs", "thursday"),
    ("fri", "friday"), ("sat", "saturday"), ("sun", "sunday"),
]) for d in names}
_MONTH = "|".join(sorted(_MONTHS, key=len, reverse=True))
_DAY = "|".join(sorted(_DAYS, key=len, reverse=True))
# "Fri 21 Nov 2026", "21st November", "November 21, 2026", "2026-11-21".
_DATE = re.compile(
    rf"(?:(?P<dow>{_DAY})\.?,?\s+)?"
    rf"(?:(?P<d1>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<m1>{_MONTH})\.?(?:,?\s+(?P<y1>20\d{{2}}))?(?!\d)"
    rf"|(?P<m2>{_MONTH})\.?\s+(?P<d2>\d{{1,2}})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(?P<y2>20\d{{2}}))?"
    rf"|(?P<iso>20\d{{2}}-\d{{2}}-\d{{2}}))",
    re.IGNORECASE,
)
# The date has to follow its label closely: same line, or the start of the next.
_GAP = r"[^\n\dA-Za-z]{0,6}(?:\n[ \t]*)?(?:(?:date|on|from|is|after|by)\b[ \t:]*)?"
_CHECK_IN = re.compile(r"\b(?:check[\s-]?in|arrival|arriving|arrive)\b" + _GAP, re.IGNORECASE)
_CHECK_OUT = re.compile(r"\b(?:check[\s-]?out|departure|departing|depart)\b" + _GAP, re.IGNORECASE)
_ONE_DAY = re.compile(
    r"(?:(?:^|\n)[ \t>*]*(?:date|when|appointment(?: date)?|event date)[ \t]*[:\-–][ \t]*|\b(?:is|are) confirmed for[ \t]+|\bsee you on[ \t]+)",
    re.IGNORECASE,
)
_WHERE = re.compile(r"(?:^|\n)[ \t>*]*(?:address|location|where|venue|property address)[ \t]*[:\-–][ \t]*([^\n]{6,140})", re.IGNORECASE)
_STREET = re.compile(
    r"\b\d{1,5}[A-Za-z]?(?:[-/]\d{1,5})?\s+(?:[A-Z][A-Za-z']+[ -]){1,4}"
    r"(?:Street|Road|Rd|Avenue|Ave|Drive|Court|Place|Lane|Ln|Terrace|Tce|Parade|Pde|Boulevard|Blvd|Crescent|Cres|Highway|Hwy|Circuit|Cct|Close|St|Dr|Ct|Pl|Cl|Way)\b"
    r"(?:,\s*[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?)?"
)
_SUBJECT_NOISE = re.compile(
    r"^(?:(?:re|fwd?|fw)\s*:\s*)+|\b(?:your\s+)?(?:booking|reservation)\s+(?:confirmation|confirmed|reference)\b(?:[\s:#\-–]*[A-Z0-9]*\d[A-Z0-9]*)?|"
    r"\b(?:is\s+)?confirm(?:ed|ation)\b|\bwelcome guide\b.*$|\s*[\-–|:]\s*$|^\s*[\-–|:]\s*",
    re.IGNORECASE,
)
_WORD = re.compile(r"[a-z0-9]{4,}")
_PLAIN = {"booking", "reservation", "confirmation", "confirmed", "your", "stay", "from", "with", "email", "trip", "guide", "welcome"}


def _resolve(m: re.Match[str], sent: date) -> date | None:
    """The day a written date means, or None unless it's certain: a weekday
    must agree, and a date with no year is the next one after the email."""
    try:
        if m.group("iso"):
            return date.fromisoformat(m.group("iso"))
        day = int(m.group("d1") or m.group("d2"))
        month = _MONTHS[(m.group("m1") or m.group("m2")).lower()]
        year = m.group("y1") or m.group("y2")
        dow = _DAYS.get((m.group("dow") or "").lower())
        if year:
            found = date(int(year), month, day)
            return found if dow is None or found.weekday() == dow else None
        for y in (sent.year, sent.year + 1):
            try:
                found = date(y, month, day)
            except ValueError:
                continue
            if found < sent - timedelta(days=1):
                continue
            if dow is None or found.weekday() == dow:
                return found
    except (ValueError, KeyError):
        return None
    return None


def _date_after(label: re.Pattern[str], words: str, sent: date) -> date | None:
    """The date right after the first use of this label that has one. Two
    different dates for one label means we don't know which, so neither."""
    found: set[date] = set()
    for hit in label.finditer(words):
        m = _DATE.match(words, hit.end())
        if m:
            day = _resolve(m, sent)
            if day is None:
                return None
            found.add(day)
    return next(iter(found)) if len(found) == 1 else None


def _title(subject: str, sender: str) -> str:
    cleaned = re.sub(r"\s{2,}", " ", _SUBJECT_NOISE.sub(" ", subject or "")).strip(" -–|:,")
    return (cleaned if 3 <= len(cleaned) <= 80 else "") or sender or "Booking"


def _place(words: str) -> str:
    m = _WHERE.search(words)
    if m and re.search(r"\d", m.group(1)):
        return m.group(1).strip(" .")[:140]
    m = _STREET.search(words)
    return m.group(0).strip() if m else ""


def read(subject: str, body: str, sender: str, sent: date, today: date) -> dict[str, Any] | None:
    """``{title, start, end, nights, location}`` (ISO days; ``end`` is the
    last day) or None. Only future, and only when the dates are certain."""
    words = (body or "")[: hints.LOOK_AT]
    if hints.suggest(subject, words) != "event":
        return None
    start = _date_after(_CHECK_IN, words, sent)
    end = _date_after(_CHECK_OUT, words, sent) if start else None
    if start and end:
        if not (0 < (end - start).days <= MAX_NIGHTS):
            return None
    else:
        start = _date_after(_ONE_DAY, words, sent)
        end = start
    if start is None or start < today or (start - today).days > LOOK_AHEAD_DAYS:
        return None
    return {"title": _title(subject, sender), "start": start.isoformat(), "end": end.isoformat(), "nights": (end - start).days, "location": _place(words)}


def _alike(a: str, b: str) -> bool:
    wa = set(_WORD.findall(a.lower())) - _PLAIN
    wb = set(_WORD.findall(b.lower())) - _PLAIN
    return bool(wa & wb)


def _dismissed(user: User) -> list[str]:
    return [str(x) for x in (user.settings or {}).get(SETTING) or []]


async def find(db: AsyncSession, user: User, today: date, tz: Any) -> list[dict[str, Any]]:
    """Bookings in your own mail that aren't on your calendar yet, soonest first."""
    from app.today.core import occurrences_between

    from .router import _my_account_ids

    accounts = await _my_account_ids(db, user)
    if not accounts:
        return []
    rows = (await db.execute(text(
        "SELECT m.id, m.account_id, m.thread_key, m.subject, m.body_text, m.from_name, m.from_addr, m.sent_at "
        "FROM mail_messages m JOIN mail_folders f ON f.id = m.folder_id "
        "WHERE m.account_id = ANY(:accounts) AND f.role NOT IN ('sent', 'drafts', 'junk', 'trash') AND m.invite IS NULL AND m.sent_at >= :since "
        "AND (m.subject || ' ' || left(m.body_text, 6000)) ~* '(check[ -]?in|booking|reservation|itinerary|appointment|is confirmed for)' "
        "ORDER BY m.sent_at DESC LIMIT :n"
    ), {"accounts": accounts, "since": datetime.now(timezone.utc) - LOOK_BACK, "n": MAX_SCANNED})).all()
    gone = set(_dismissed(user))
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for r in rows:
        key = f"{r.account_id}/{r.thread_key}"
        if key in gone:
            continue
        got = read(r.subject, r.body_text, r.from_name or "", r.sent_at.date(), today)
        if got is None or (got["start"], got["end"]) in seen:
            continue
        seen.add((got["start"], got["end"]))
        found.append(got | {"id": str(r.id), "url": f"/mail?open={key}", "from": r.from_name or r.from_addr})
    if not found:
        return []
    # Only now the calendar, and only the days these start on.
    days = sorted(date.fromisoformat(b["start"]) for b in found)
    events = await occurrences_between(db, user, days[0], days[-1], tz)

    def on_calendar(b: dict[str, Any]) -> bool:
        start = date.fromisoformat(b["start"])
        return any(
            b["url"] in (o.get("description") or "") or (first == start and _alike(o.get("title") or "", f"{b['title']} {b['from']}"))
            for o, first, _last in events
        )

    out = [b for b in found if not on_calendar(b)]
    out.sort(key=lambda b: b["start"])
    return out[:MAX_SHOWN]


async def _own(db: AsyncSession, user: User, message_id: uuid.UUID) -> MailMessage:
    from .router import _my_account_ids

    message = await db.get(MailMessage, message_id)
    if message is None or message.account_id not in await _my_account_ids(db, user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Message not found.")
    return message


async def dismiss(db: AsyncSession, user: User, message_id: uuid.UUID) -> None:
    """Not shown on Today again, for this conversation."""
    message = await _own(db, user, message_id)
    key = f"{message.account_id}/{message.thread_key}"
    kept = [k for k in _dismissed(user) if k != key] + [key]
    user.settings = {**(user.settings or {}), SETTING: kept[-MAX_DISMISSED:]}
    flag_modified(user, "settings")
    await db.commit()


async def add_to_calendar(db: AsyncSession, user: User, message_id: uuid.UUID, today: date) -> str:
    """The one tap: an all-day event for the days in the email, linked back to it."""
    from app.calendars import service

    message = await _own(db, user, message_id)
    got = read(message.subject, message.body_text, message.from_name or "", message.sent_at.date(), today)
    if got is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Couldn't read the dates in that email. Open it and add it yourself.")
    event = await service.create_event(db, user, service.EventFields(
        title=got["title"], start=got["start"], end=got["end"], all_day=True, location=got["location"],
        description=f"From an email: /mail?open={message.account_id}/{message.thread_key}",
    ), ping_guests=False)
    await db.commit()
    return f"/calendar?event={event.id}"
