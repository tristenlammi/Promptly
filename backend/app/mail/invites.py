"""Calendar invites in email: reading what someone sent, and answering them.

Standard iCalendar, so invites from Google, Outlook and Apple all work. Nothing in
an invite is acted on until you press a button. A repeating invite adds its first
date only, and the card says so.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.calendars.ics import _esc, _fold

MAX_BYTES = 256 * 1024
_ANSWERS = {"going": "ACCEPTED", "maybe": "TENTATIVE", "declined": "DECLINED"}
_SAID = {"ACCEPTED": "going", "TENTATIVE": "maybe", "DECLINED": "declined"}
# Outlook names its time zones its own way.
_WINDOWS_ZONES = {
    "AUS Eastern Standard Time": "Australia/Sydney", "E. Australia Standard Time": "Australia/Brisbane", "Cen. Australia Standard Time": "Australia/Adelaide",
    "AUS Central Standard Time": "Australia/Darwin", "W. Australia Standard Time": "Australia/Perth", "Tasmania Standard Time": "Australia/Hobart",
    "New Zealand Standard Time": "Pacific/Auckland", "UTC": "UTC", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris", "Central Europe Standard Time": "Europe/Budapest", "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles",
    "Singapore Standard Time": "Asia/Singapore", "Tokyo Standard Time": "Asia/Tokyo", "India Standard Time": "Asia/Kolkata", "China Standard Time": "Asia/Shanghai",
}


def _unescape(value: str) -> str:
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _lines(text: str) -> list[tuple[str, dict[str, str], str]]:
    """Unfolded lines as (NAME, params, value)."""
    out = []
    for line in re.sub(r"\r?\n[ \t]", "", text).splitlines():
        head, sep, value = line.partition(":")
        if not sep:
            continue
        # A quoted parameter can itself hold a colon (a CN, say).
        while head.count('"') % 2:
            more, sep, value = value.partition(":")
            head = f"{head}:{more}"
        name, *params = head.split(";")
        found: dict[str, str] = {}
        for p in params:
            key, _, val = p.partition("=")
            found[key.upper()] = val.strip('"')
        out.append((name.upper(), found, value))
    return out


def _zone(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(_WINDOWS_ZONES.get(name, name))
    except Exception:  # noqa: BLE001 — made-up zone names are common
        return None


def _when(params: dict[str, str], value: str) -> tuple[str, bool, bool]:
    """(ISO value, all day?, sure of the zone?)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return date(int(value[:4]), int(value[4:6]), int(value[6:8])).isoformat(), True, True
    at = datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return at.replace(tzinfo=timezone.utc).isoformat(), False, True
    tzid = params.get("TZID")
    if tzid:
        zone = _zone(tzid)
        if zone:
            return at.replace(tzinfo=zone).isoformat(), False, True
    # No zone we can read: the person's own zone is the best guess, and we say so.
    return at.isoformat(), False, not tzid


def _person(params: dict[str, str], value: str) -> dict[str, str]:
    addr = re.sub(r"^mailto:", "", value.strip(), flags=re.IGNORECASE)
    return {"name": params.get("CN", "")[:200], "addr": addr[:320]}


def parse_ics(raw: bytes) -> dict[str, Any] | None:
    """The first event in an invite, or None if it isn't one we can read."""
    if len(raw) > MAX_BYTES:
        return None
    try:
        rows = _lines(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    method = next((v.strip().upper() for n, _, v in rows if n == "METHOD"), "PUBLISH")
    try:
        start = rows.index(next(r for r in rows if r[0] == "BEGIN" and r[2].strip().upper() == "VEVENT"))
        end = rows.index(next(r for r in rows[start:] if r[0] == "END" and r[2].strip().upper() == "VEVENT"))
    except StopIteration:
        return None
    event = rows[start + 1 : end]
    get = lambda name: next(((p, v) for n, p, v in event if n == name), None)  # noqa: E731
    uid, begins = get("UID"), get("DTSTART")
    if uid is None or begins is None:
        return None
    try:
        first, all_day, sure = _when(*begins)
        ends = get("DTEND")
        last = _when(*ends)[0] if ends else None
    except ValueError:
        return None
    if all_day and last:
        # iCalendar's end date is the day after. Ours is the last day.
        last = (date.fromisoformat(last) - timedelta(days=1)).isoformat()
        if last < first:
            last = first
    text = lambda name: _unescape(get(name)[1]).strip() if get(name) else ""  # noqa: E731
    organiser = get("ORGANIZER")
    try:
        sequence = int(text("SEQUENCE") or 0)
    except ValueError:
        sequence = 0
    attendees = [{**_person(p, v), "said": _SAID.get(p.get("PARTSTAT", "").upper(), "")} for n, p, v in event if n == "ATTENDEE"]
    return {
        "method": method[:12], "uid": text("UID")[:300], "sequence": sequence, "title": text("SUMMARY")[:300] or "(No title)",
        "start": first, "end": last, "all_day": all_day, "zone_sure": sure, "location": text("LOCATION")[:500], "description": text("DESCRIPTION")[:2000],
        "organizer": _person(*organiser) if organiser else None, "attendees": attendees[:50], "repeats": get("RRULE") is not None,
        "cancelled": method == "CANCEL" or text("STATUS").upper() == "CANCELLED",
    }


def reply_ics(invite: dict[str, Any], *, email: str, name: str, status: str) -> str:
    """Your answer, in the form the organiser's calendar understands."""
    organiser = invite.get("organizer") or {}
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if invite["all_day"]:
        start = f"DTSTART;VALUE=DATE:{invite['start'].replace('-', '')}"
    else:
        at = datetime.fromisoformat(invite["start"])
        at = at.astimezone(timezone.utc) if at.tzinfo else at
        start = f"DTSTART:{at.strftime('%Y%m%dT%H%M%S')}" + ("Z" if at.tzinfo else "")
    lines = [
        "BEGIN:VCALENDAR", "PRODID:-//Promptly//Mail//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:REPLY", "BEGIN:VEVENT",
        f"UID:{_esc(invite['uid'])}", f"SEQUENCE:{int(invite.get('sequence') or 0)}", f"DTSTAMP:{now}", start,
        f"SUMMARY:{_esc(invite.get('title') or '')}",
        f'ORGANIZER;CN="{_quoted(organiser.get("name", ""))}":mailto:{_address(organiser.get("addr", ""))}',
        f'ATTENDEE;CN="{_quoted(name)}";PARTSTAT={_ANSWERS[status]}:mailto:{_address(email)}',
        "END:VEVENT", "END:VCALENDAR",
    ]
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def _quoted(value: str) -> str:
    return re.sub(r'["\r\n]', "", value)


def _address(value: str) -> str:
    return re.sub(r"[\s;:,\"]", "", value)
