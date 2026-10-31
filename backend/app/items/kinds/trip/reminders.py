"""Reminders: online check-in (24 h before each flight), departures (3 h
before a flight, 1 h before other bookings), check-out mornings, document
warnings and to-dos, and "your trip starts tomorrow". Times come from each
booking's own zone, so a 07:00 Tokyo departure reminds at the right moment
wherever the person's phone is."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from app.items.spec import ItemContext, Reminder

from . import logic, trips
from .timeutil import instant, zone_abbr

CHECKIN_BEFORE = timedelta(hours=24)
FLIGHT_BEFORE = timedelta(hours=3)
OTHER_BEFORE = timedelta(hours=1)


def _at_local(day: date, hh: int, mm: int, tz) -> datetime:  # noqa: ANN001
    return datetime.combine(day, time(hh, mm), tzinfo=tz)


def _flight_body(b: dict) -> str:
    bits = []
    if b.get("start"):
        abbr = zone_abbr(b["start"], b.get("start_tz"))
        bits.append(f"Departs {b['start'][11:16]}{(' ' + abbr) if abbr else ''} on {b['start'][:10]}")
    where = b.get("from_place") or b.get("from_code")
    if where:
        bits.append(f"from {where}{(' T' + b['terminal_from']) if b.get('terminal_from') else ''}")
    if b.get("confirmation"):
        bits.append(f"booking ref {b['confirmation']}")
    if b.get("seat"):
        bits.append(f"seat {b['seat']}")
    return " · ".join(bits)


def trip_reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    """Every trip's reminders. Keys carry the trip id (booking ids are only
    unique within a trip); with several trips the body names the trip."""
    out: list[Reminder] = []
    many = len(data.get("trips", [])) > 1
    for t in data.get("trips", []):
        for r in one_trip_reminders(trips.view(data, t), ctx):
            r.key = f"{t['id']}/{r.key}"
            if many:
                r.body = f"{trips.title_of(t)} · {r.body}" if r.body else trips.title_of(t)
            out.append(r)
    return out


def one_trip_reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    """One trip's reminders (``data`` is the trip's view)."""
    if data.get("status") == "done":
        return []
    now = ctx.now
    out: list[Reminder] = []
    for b in data.get("bookings", []):
        if b.get("status") == "cancelled":
            continue
        label = logic.booking_label(b)
        dep = instant(b.get("start"), b.get("start_tz"), ctx.tz)
        if dep is not None and dep > now:
            if b["type"] == "flight":
                checkin = dep - CHECKIN_BEFORE
                due = checkin if checkin > now else (now if dep - now > FLIGHT_BEFORE else None)
                if due is not None:
                    out.append(Reminder(key=f"checkin:{b['id']}:{b['start']}", due_at=due,
                                        title=f"Online check-in is open: {label}", body=_flight_body(b)))
                if dep - FLIGHT_BEFORE > now:
                    out.append(Reminder(key=f"depart:{b['id']}:{b['start']}", due_at=dep - FLIGHT_BEFORE,
                                        title=f"Flight in 3 hours: {label}", body=_flight_body(b)))
            elif b["type"] in ("car", "train", "bus", "ferry", "tour", "ticket", "other"):
                if dep - OTHER_BEFORE > now:
                    word = {"car": "Car pick-up", "tour": "Tour", "ticket": "Starts"}.get(b["type"], "Departs")
                    where = b.get("from_place") or b.get("address")
                    body = f"{b['start'][11:16]}{' at ' + where if where else ''}"
                    if b.get("confirmation"):
                        body += f" · ref {b['confirmation']}"
                    out.append(Reminder(key=f"soon:{b['id']}:{b['start']}", due_at=dep - OTHER_BEFORE,
                                        title=f"{word} in 1 hour: {label}", body=body))
        if b["type"] == "stay" and b.get("end"):
            co = instant(b["end"], b.get("end_tz") or b.get("start_tz"), ctx.tz)
            if co is not None:
                due = co.replace(hour=8, minute=0) if co.hour >= 9 else co - timedelta(hours=1)
                if due > now:
                    out.append(Reminder(key=f"checkout:{b['id']}:{b['end']}", due_at=due,
                                        title=f"Check out today: {label}", body=f"Check-out by {b['end'][11:16]}."))

    start = data.get("start")
    if start:
        s = date.fromisoformat(start)
        due = _at_local(s - timedelta(days=1), 18, 0, ctx.tz)
        if due > now:
            first = next((e for e in logic.booking_events(data, ctx.tz) if e["date"] >= start), None)
            body = f"First up: {first['word'].lower()} {first['title']} at {first['time']}." if first and first["time"] else "Check the packing list and documents."
            out.append(Reminder(key=f"tripstart:{start}", due_at=due, title="Your trip starts tomorrow", body=body))

        # Documents: problems surface well ahead; to-dos on their date.
        if s > ctx.today:
            warn_from = _at_local(s - timedelta(days=90), 9, 0, ctx.tz)
            for issue in logic.document_issues(data, ctx.today):
                if issue["kind"] not in ("passport_validity", "document_expires"):
                    continue
                doc = next((d for d in data.get("documents", []) if d["id"] == issue.get("document_id")), None)
                if doc is None:
                    continue
                out.append(Reminder(key=f"doc:{issue['kind']}:{doc['id']}:{doc.get('expires')}:{start}",
                                    due_at=max(now, warn_from), title="Check your travel documents", body=issue["message"]))
    for doc in data.get("documents", []):
        if doc.get("status") == "done":
            continue
        label = doc.get("title") or doc["type"].replace("_", " ").title()
        when: datetime | None = None
        if doc.get("remind_on"):
            when = _at_local(date.fromisoformat(doc["remind_on"]), 9, 0, ctx.tz)
        elif start and doc["type"] in ("visa", "eta", "insurance", "driving_permit", "vaccination"):
            s = date.fromisoformat(start)
            if s > ctx.today:
                when = max(now, _at_local(s - timedelta(days=21), 9, 0, ctx.tz))
        if when is not None and when >= now - timedelta(minutes=1):
            out.append(Reminder(key=f"doctodo:{doc['id']}:{doc.get('remind_on') or start}", due_at=when,
                                title=f"Travel document to sort: {label}",
                                body=(doc.get("notes") or "Still to do — check the official requirements.")[:300]))
    return out
