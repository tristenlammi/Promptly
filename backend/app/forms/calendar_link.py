"""Forms and Calendar (WP-F1.7, plan §6.3).

* **Add an RSVP form** on an event (people who can edit it): a form from
  the RSVP template, named after the event, with the event's title, time
  and place written into its description, and linked both ways
  (``cal_events.form_file_id`` ↔ ``forms.event_id``). Made in the
  person's Forms folder, taking answers once it has a link like any form.
* The event page shows "RSVP form · 14 answers" to people who can edit
  the event (:func:`event_form`).
* The answer page knows only what was **copied** into the form; "Add to my
  calendar" is a one-event ``.ics`` (:func:`ics_for`) with the title, time
  and place — never the event's notes, guests or calendar.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import UserFile
from app.forms.models import Form

if TYPE_CHECKING:
    from app.auth.models import User
    from app.calendars.models import CalEvent


def _when(ev: CalEvent, tz_name: str) -> str:
    from app.calendars import recur

    tz = recur.zone(tz_name or ev.tz or "UTC")
    if ev.all_day:
        s = ev.start_at.astimezone(timezone.utc).date()
        e = ev.end_at.astimezone(timezone.utc).date()
        days = (e - s).days
        text = f"{s:%A} {s.day} {s:%B %Y}"
        if days > 1:
            last = e.fromordinal(e.toordinal() - 1)
            text += f" to {last:%A} {last.day} {last:%B}"
        return text
    s = ev.start_at.astimezone(tz)
    e = ev.end_at.astimezone(tz)

    def clock(d: datetime) -> str:
        return d.strftime("%I:%M %p").lstrip("0").replace(":00 ", " ").lower()

    text = f"{s:%A} {s.day} {s:%B %Y}, {clock(s)}"
    text += f" to {clock(e)}" if s.date() == e.date() else f" to {e:%A} {e.day} {e:%B}, {clock(e)}"
    return text


def description_for(ev: CalEvent, tz_name: str) -> str:
    """What the form says about the event: title, when and where only."""
    lines = [f"For {ev.title}.", f"When: {_when(ev, tz_name)}"]
    if ev.location:
        lines.append(f"Where: {ev.location}")
    lines.append("Let us know if you can make it.")
    return "\n".join(lines)


async def rsvp_for_event(db: AsyncSession, user: User, event_id: uuid.UUID) -> tuple[UserFile, bool]:
    """The event's RSVP form: the one it has (still there, and you can open
    it), or a new one. Returns (shell, made). Flushed, not committed. 404
    for an event you can't see; 403 if you can't change it."""
    from app.calendars import core
    from app.files.system_folders import ensure_forms_folder
    from app.forms import service
    from app.forms.access import form_access

    ev, m, att = await core.load_event(db, event_id, user, lock=True)
    if not core.can_edit(ev, m, att, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only people who can change this event can add a form to it.")
    if ev.form_file_id is not None:
        shell = await db.get(UserFile, ev.form_file_id)
        if shell is not None and shell.trashed_at is None and await form_access(db, shell, user) != "none":
            return shell, False
    folder = await ensure_forms_folder(db, user)
    made = await service.from_template(db, owner=user, key="rsvp", title=f"{ev.title} RSVP"[:300], folder_id=folder.id)
    assert made is not None
    shell, form = made
    d = dict(form.definition)
    d["description"] = description_for(ev, core.user_tz(user))
    from app.forms.definition import validate_definition

    form.definition = validate_definition(d)
    form.event_id = ev.id
    ev.form_file_id = shell.id
    await service.refresh_shell(db, form, shell)
    await db.flush()
    return shell, True


async def event_form(db: AsyncSession, ev: CalEvent, user: User) -> dict[str, Any] | None:
    """The event's RSVP form for its page, to someone who can edit the event
    and open the form: ``{file_id, title, answers, state}``."""
    from app.forms.access import form_access, form_for_shell
    from app.forms.service import state_of

    if ev.form_file_id is None:
        return None
    shell = await db.get(UserFile, ev.form_file_id)
    if shell is None or shell.trashed_at is not None or await form_access(db, shell, user) == "none":
        return None
    form = await form_for_shell(db, shell)
    if form is None:
        return None
    return {
        "file_id": str(shell.id),
        "title": (form.definition or {}).get("title") or "RSVP",
        "answers": int(form.response_count or 0),
        "state": state_of(shell, form),
    }


async def linked_event(db: AsyncSession, form: Form) -> CalEvent | None:
    from app.calendars.models import CalEvent

    if form.event_id is None:
        return None
    return await db.get(CalEvent, form.event_id)


def ics_for(ev: CalEvent) -> str:
    """One event for "Add to my calendar" on the answer page: when and where
    and what it's called — nothing else (the next one, for a series)."""
    from app.calendars import recur
    from app.calendars.ics import _date, _esc, _fold, _utc

    now = datetime.now(timezone.utc)
    start, end = ev.start_at, ev.end_at
    if ev.repeat:
        nxt = recur.occurrences(start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz,
                                repeat=ev.repeat, exdates=ev.exdates, range_start=now,
                                range_end=now.replace(year=now.year + 2))[:1]
        if nxt:
            start, end = nxt[0]
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Promptly//Forms//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "BEGIN:VEVENT", f"UID:{ev.id}-rsvp@promptly", f"DTSTAMP:{_utc(now)}"]
    if ev.all_day:
        lines += [f"DTSTART;VALUE=DATE:{_date(start)}", f"DTEND;VALUE=DATE:{_date(end)}"]
    else:
        lines += [f"DTSTART:{_utc(start)}", f"DTEND:{_utc(end)}"]
    lines.append(f"SUMMARY:{_esc(ev.title)}")
    if ev.location:
        lines.append(f"LOCATION:{_esc(ev.location)}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


__all__ = ["description_for", "event_form", "ics_for", "linked_event", "rsvp_for_event"]
