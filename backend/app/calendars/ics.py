"""The subscribe feed: a person's events as an iCalendar file, for a phone's
calendar app to poll. Read-only. Series go out as RRULEs (with EXDATEs), so
the phone repeats them itself."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import core, recur
from .models import CalAttendee, CalCalendar, CalEvent, CalMember

UTC = timezone.utc
_PAST = timedelta(days=90)


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _fold(line: str) -> str:
    """Lines over 75 octets continue on the next line after a space (RFC 5545)."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    parts, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > (75 if not parts else 74):
            parts.append(cur.decode("utf-8"))
            cur = b""
        cur += b
    parts.append(cur.decode("utf-8"))
    return "\r\n ".join(parts)


def _utc(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _date(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y%m%d")


async def build(db: AsyncSession, user: User) -> str:
    now = datetime.now(UTC)
    my_cals = select(CalMember.calendar_id).where(CalMember.user_id == user.id, CalMember.hidden.is_(False))
    invited = select(CalAttendee.event_id).where(
        CalAttendee.user_id == user.id, CalAttendee.hidden.is_(False), CalAttendee.status != "declined"
    )
    # Taken off your calendar (a shared calendar's event you removed, or declined).
    removed = select(CalAttendee.event_id).where(
        CalAttendee.user_id == user.id, (CalAttendee.hidden.is_(True)) | (CalAttendee.status == "declined")
    )
    events = list(
        (
            await db.execute(
                select(CalEvent).where(
                    or_(CalEvent.calendar_id.in_(my_cals), CalEvent.id.in_(invited)),
                    ~CalEvent.id.in_(removed),
                    or_(CalEvent.last_end.is_(None), CalEvent.last_end > now - _PAST),
                )
            )
        ).scalars()
    )
    cals = {c.id: c for c in (await db.execute(select(CalCalendar).where(CalCalendar.id.in_({e.calendar_id for e in events})))).scalars()} if events else {}
    atts = await core.attendees_of(db, [e.id for e in events])
    people = await core.users_map(db, {a.user_id for al in atts.values() for a in al} | {e.created_by for e in events if e.created_by})

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Promptly//Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_esc('Promptly')}",
        "X-PUBLISHED-TTL:PT15M",
        "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    ]
    busy_cals = set(
        (await db.execute(select(CalMember.calendar_id).where(CalMember.user_id == user.id, CalMember.role == "busy"))).scalars()
    )
    for ev in events:
        mine = next((a for a in atts.get(ev.id, []) if a.user_id == user.id and a.invited_by is not None), None)
        if ev.calendar_id in busy_cals and mine is None:
            lines += _vevent(ev, None, [], people, now, busy=True)
            continue
        lines += _vevent(ev, cals.get(ev.calendar_id), atts.get(ev.id, []), people, now)
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def _vevent(ev: CalEvent, cal: CalCalendar | None, atts: list[CalAttendee], people: dict, now: datetime, busy: bool = False) -> list[str]:  # noqa: ANN001
    out = ["BEGIN:VEVENT", f"UID:{ev.id}@promptly", f"DTSTAMP:{_utc(ev.updated_at or now)}"]
    if ev.all_day:
        out += [f"DTSTART;VALUE=DATE:{_date(ev.start_at)}", f"DTEND;VALUE=DATE:{_date(ev.end_at)}"]
    else:
        out += [f"DTSTART:{_utc(ev.start_at)}", f"DTEND:{_utc(ev.end_at)}"]
    if ev.repeat:
        # Timed series repeat in their own zone; we send UTC instants, so pin
        # the rule's wall-clock with TZID when the zone is known.
        if not ev.all_day and ev.tz and ev.tz != "UTC":
            local = ev.start_at.astimezone(recur.zone(ev.tz))
            out[-2] = f"DTSTART;TZID={ev.tz}:{local.strftime('%Y%m%dT%H%M%S')}"
            out[-1] = f"DTEND;TZID={ev.tz}:{ev.end_at.astimezone(recur.zone(ev.tz)).strftime('%Y%m%dT%H%M%S')}"
        out.append(f"RRULE:{recur.rrule_text(ev.repeat, ev.start_at, ev.all_day, ev.tz)}")
        for x in ev.exdates or []:
            d = datetime.fromisoformat(x.replace("Z", "+00:00"))
            if ev.all_day:
                out.append(f"EXDATE;VALUE=DATE:{_date(d)}")
            elif ev.tz and ev.tz != "UTC":
                out.append(f"EXDATE;TZID={ev.tz}:{d.astimezone(recur.zone(ev.tz)).strftime('%Y%m%dT%H%M%S')}")
            else:
                out.append(f"EXDATE:{_utc(d)}")
    if busy:
        # Free/busy only: when, nothing else.
        return [*out, "SUMMARY:Busy", "TRANSP:OPAQUE", "END:VEVENT"]
    out.append(f"SUMMARY:{_esc(ev.title)}")
    desc = ev.description or ""
    if atts:
        names = [f"{people.get(str(a.user_id), {}).get('username', '?')} ({a.status})" for a in atts]
        desc = (desc + "\n\n" if desc else "") + "Guests: " + ", ".join(names)
    if desc:
        out.append(f"DESCRIPTION:{_esc(desc)}")
    if ev.location:
        out.append(f"LOCATION:{_esc(ev.location)}")
    if cal is not None and not cal.personal:
        out.append(f"CATEGORIES:{_esc(cal.name)}")
    out.append("END:VEVENT")
    return out


def new_token() -> str:
    import secrets

    return secrets.token_urlsafe(32)


def invite(
    ev: CalEvent,
    *,
    method: str,
    guest_email: str,
    guest_name: str = "",
    organiser_name: str,
    organiser_email: str,
    status: str = "invited",
    url: str | None = None,
    occurrence: datetime | None = None,
) -> str:
    """One event for one person invited by email (``method`` REQUEST or
    CANCEL; ``occurrence`` cancels just that one of a series). Only that
    guest is named in it — never the others."""
    now = datetime.now(UTC)
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Promptly//Calendar//EN", "CALSCALE:GREGORIAN", f"METHOD:{method}"]
    body = _vevent(ev, None, [], {}, now)
    if occurrence is not None:
        # Just that one: its own times, no rule.
        body = [x for x in body if not x.startswith(("RRULE", "EXDATE"))]
        occ_end = occurrence + (ev.end_at - ev.start_at)
        body[3], body[4] = (
            (f"DTSTART;VALUE=DATE:{_date(occurrence)}", f"DTEND;VALUE=DATE:{_date(occ_end)}")
            if ev.all_day else (f"DTSTART:{_utc(occurrence)}", f"DTEND:{_utc(occ_end)}")
        )
    # A change goes out with a higher SEQUENCE so their calendar replaces it.
    seq = int((ev.updated_at or ev.created_at or now).timestamp()) - 1_700_000_000
    extra = [f"SEQUENCE:{max(0, seq)}"]
    if occurrence is not None:
        extra.append(f"RECURRENCE-ID;VALUE=DATE:{_date(occurrence)}" if ev.all_day else f"RECURRENCE-ID:{_utc(occurrence)}")
    cn = (organiser_name or "Promptly").replace('"', "")
    extra.append(f'ORGANIZER;CN="{cn}":mailto:{organiser_email}')
    part = {"going": "ACCEPTED", "maybe": "TENTATIVE", "declined": "DECLINED"}.get(status, "NEEDS-ACTION")
    gname = (guest_name or guest_email).replace('"', "")
    extra.append(f'ATTENDEE;CN="{gname}";ROLE=REQ-PARTICIPANT;PARTSTAT={part};RSVP=FALSE:mailto:{guest_email}')
    if url:
        extra.append(f"URL:{url}")
    if method == "CANCEL":
        extra.append("STATUS:CANCELLED")
    body[3:3] = extra
    lines += body
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
