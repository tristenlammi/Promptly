"""Today (#U2): the day across apps, privacy (other people's events and
rooms never show, free/busy-only and declined events don't count, rooms
show counts not text), the one morning push (#5: once a day, never as well
as the old Tasks digest), the journal's day strip (#U7) and the everyday
search (#U11: events, contacts, tasks — never room messages)."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from tests.test_calendar import H, client, mk_user, pushes  # noqa: F401

UTC = timezone.utc
LON = ZoneInfo("Europe/London")


def _local_today() -> date:
    return datetime.now(LON).date()


def _at(day: date, hh: int, mm: int = 0) -> str:
    return datetime.combine(day, time(hh, mm), tzinfo=LON).astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _event(client, u, title: str, day: date, hh: int = 12) -> dict:  # noqa: F811
    r = await client.post("/api/calendar/events", headers=H(u), json={"title": title, "start": _at(day, hh), "end": _at(day, hh + 1)})
    assert r.status_code == 201, r.text
    return r.json()["event"]


async def _item(client, u, kind: str) -> str:  # noqa: F811
    assert (await client.post(f"/api/items/store/{kind}", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": kind})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    return body["file_id"]


async def _act(client, u, fid: str, name: str, args: dict) -> dict:  # noqa: F811
    r = await client.post(f"/api/items/{fid}/actions/{name}", headers=H(u), json={"args": args})
    assert r.status_code == 200, r.text
    return r.json()


async def _dm(db, a, b, *, last_seq: int, a_read: int, body: str):
    from app.rooms.models import Room, RoomMember, RoomMessage

    room = Room(kind="dm", name="", last_seq=last_seq, last_message_at=datetime.now(UTC))
    db.add(room)
    await db.flush()
    db.add_all([RoomMember(room_id=room.id, user_id=a.id, last_read_seq=a_read), RoomMember(room_id=room.id, user_id=b.id, last_read_seq=last_seq)])
    db.add(RoomMessage(room_id=room.id, seq=last_seq, author_id=b.id, body=body))
    await db.commit()
    return room


async def test_today_sections_and_privacy(client, db, pushes):  # noqa: F811
    from app.calendars.models import CalAttendee, CalCalendar, CalMember

    ann, bob, cat = [await mk_user(db, n) for n in ("ann", "bob", "cat")]
    today = _local_today()
    await _event(client, ann, "Standup", today, 9)
    await _event(client, ann, "Tomorrow thing", today + timedelta(days=1), 9)
    bobs = await _event(client, bob, "Bob's dentist", today, 10)
    # Bob shares his calendar with Ann as free/busy only, and invites her
    # to something she declined: neither is on her day.
    bob_cal = (await db.execute(select(CalCalendar).where(CalCalendar.owner_id == bob.id))).scalar_one()
    db.add(CalMember(calendar_id=bob_cal.id, user_id=ann.id, role="busy"))
    declined = await _event(client, bob, "Party", today, 15)
    db.add(CalAttendee(event_id=uuid.UUID(declined["event_id"]), user_id=ann.id, status="declined", invited_by=bob.id))
    await db.commit()

    fid = await _item(client, ann, "tasks")
    await _act(client, ann, fid, "add_tasks", {"tasks": [
        {"title": "Pay rent", "due": today.isoformat()},
        {"title": "Old one", "due": (today - timedelta(days=3)).isoformat()},
        {"title": "Later", "due": (today + timedelta(days=5)).isoformat()},
    ]})
    await _dm(db, ann, bob, last_seq=3, a_read=1, body="the secret plan")

    r = await client.get("/api/today", headers=H(ann))
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["date"] == today.isoformat() and got["greeting"].startswith("Good ")
    sec = got["sections"]
    assert [e["title"] for e in sec["events"]["events"]] == ["Standup"]
    assert sec["events"]["events"][0]["url"].startswith("/calendar?event=")
    assert [t["title"] for t in sec["tasks"]["today"]] == ["Pay rent"]
    assert [t["title"] for t in sec["tasks"]["overdue"]] == ["Old one"]
    assert sec["tasks"]["url"] == f"/apps/tasks/{fid}"
    rooms = sec["rooms"]
    assert rooms["total"] == 2 and rooms["rooms"][0]["name"] == bob.username and rooms["rooms"][0]["unread"] == 2
    text = r.text
    assert "the secret plan" not in text and "Bob's dentist" not in text and "Party" not in text
    assert "habits" not in sec and "workout" not in sec and "meals" not in sec and "work" not in sec
    assert got["morning"] == {"on": True, "time": "08:00", "source": "tasks", "file_id": fid}

    # Bob sees his own, nothing of Ann's; Cat (no apps, nothing shared) a bare day.
    bsec = (await client.get("/api/today", headers=H(bob))).json()["sections"]
    assert {e["title"] for e in bsec["events"]["events"]} == {"Bob's dentist", "Party"}
    assert "rooms" not in bsec and "tasks" not in bsec
    assert bobs["event_id"] in json.dumps(bsec)
    csec = (await client.get("/api/today", headers=H(cat))).json()["sections"]
    assert "rooms" not in csec and "tasks" not in csec
    assert (csec.get("events") or {}).get("events", []) == []

    # Ticking a task off from Today uses the app's own action.
    rent = sec["tasks"]["today"][0]["id"]
    await _act(client, ann, fid, "complete_tasks", {"tasks": [rent]})
    sec = (await client.get("/api/today", headers=H(ann))).json()["sections"]
    assert sec["tasks"]["today"] == []


async def test_sections_from_item_data():
    from app.today import core

    day = date(2026, 11, 2)
    w = core.workout_section(uuid.uuid4(), {"planned": [
        {"id": "a", "date": "2026-11-02", "name": "Leg day", "status": "planned", "exercises": [{}, {}]},
        {"id": "b", "date": "2026-11-03", "name": "Push", "status": "planned"},
        {"id": "c", "date": "2026-11-02", "name": "Skipped", "status": "skipped"},
    ]}, day)
    assert [s["name"] for s in w["sessions"]] == ["Leg day"] and w["sessions"][0]["exercises"] == 2
    assert core.workout_section(uuid.uuid4(), {"planned": []}, day) is None
    m = core.meals_section(uuid.uuid4(), {"recipes": [{"id": "r1", "title": "Tacos"}], "plan": [
        {"id": "p1", "date": "2026-11-02", "slot": "dinner", "recipe_id": "r1", "title": ""},
        {"id": "p2", "date": "2026-11-02", "slot": "breakfast", "title": "Oats"},
    ]}, day)
    assert [(x["slot"], x["title"]) for x in m["meals"]] == [("breakfast", "Oats"), ("dinner", "Tacos")]


async def test_morning_push_once_and_never_doubled(client, db, pushes):  # noqa: F811
    from app.files.models import UserFile
    from app.items import loops as item_loops
    from app.items.models import ItemReminder
    from app.today import push

    ann = await mk_user(db, "ann")
    day = date(2026, 11, 2)
    fid = await _item(client, ann, "tasks")
    await _act(client, ann, fid, "add_tasks", {"tasks": [{"title": "Pay rent", "due": day.isoformat()}, {"title": "Call mum", "due": day.isoformat()}]})
    await _event(client, ann, "Standup", day, 9)
    # Tasks no longer schedules its own morning digest.
    rows = (await db.execute(select(ItemReminder).where(ItemReminder.user_id == ann.id))).scalars().all()
    assert not [r for r in rows if r.key.startswith("digest:")]

    def mine():
        return [p for p in pushes if p["user_id"] == ann.id]

    await push.send_due(db, datetime.combine(day, time(7, 55), tzinfo=LON))
    assert not mine()
    await push.send_due(db, datetime.combine(day, time(8, 5), tzinfo=LON))
    assert len(mine()) == 1
    p = mine()[0]
    assert p["url"] == "/today" and p["category"] == "item_reminder"
    assert p["title"] == "1 event · 2 tasks due" and p["body"] == "First up: 09:00 Standup"
    # Another pass (a restart, the next minute): not again.
    await push.send_due(db, datetime.combine(day, time(8, 6), tzinfo=LON))
    await push.send_due(db, datetime.combine(day, time(9, 0), tzinfo=LON))
    assert len(mine()) == 1

    # A digest the old Tasks code had already queued is dropped, not sent.
    f = await db.get(UserFile, uuid.UUID(fid))
    db.add(ItemReminder(file_id=f.id, user_id=ann.id, key=f"digest:{day.isoformat()}", due_at=datetime.now(UTC) - timedelta(minutes=1), title="2 tasks today"))
    await db.commit()
    await item_loops.send_due(db)
    assert len(mine()) == 1

    # Turned off in Tasks ("Morning summary"): nothing the next day.
    r = await client.put("/api/today/morning", headers=H(ann), json={"on": False, "time": "07:30"})
    assert r.json() == {"on": False, "time": "07:30", "source": "tasks", "file_id": fid}
    await push.send_due(db, datetime.combine(day + timedelta(days=1), time(8, 5), tzinfo=LON))
    assert len(mine()) == 1


async def test_morning_push_without_tasks(client, db, pushes):  # noqa: F811
    from app.today import push

    cat = await mk_user(db, "cat")
    day = date(2026, 11, 2)
    await _event(client, cat, "Yoga", day, 18)
    await push.send_due(db, datetime.combine(day, time(8, 5), tzinfo=LON))
    assert not [p for p in pushes if p["user_id"] == cat.id]  # off unless turned on
    r = await client.put("/api/today/morning", headers=H(cat), json={"on": True, "time": "08:00"})
    assert r.json()["source"] == "account" and r.json()["on"] is True
    await push.send_due(db, datetime.combine(day, time(8, 5), tzinfo=LON))
    got = [p for p in pushes if p["user_id"] == cat.id]
    assert len(got) == 1 and got[0]["title"] == "1 event" and "18:00 Yoga" in got[0]["body"]
    # Late (server down all morning): skipped rather than sent at noon.
    await push.send_due(db, datetime.combine(day + timedelta(days=1), time(12, 30), tzinfo=LON))
    assert len([p for p in pushes if p["user_id"] == cat.id]) == 1


async def test_search_events_contacts_tasks_not_rooms(client, db, pushes):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    today = _local_today()
    await _event(client, ann, "Dentist check-up", today + timedelta(days=2), 9)
    await _event(client, bob, "Bob dentist", today + timedelta(days=2), 9)
    cfid = await _item(client, ann, "contacts")
    await _act(client, ann, cfid, "add_contacts", {"contacts": [{"first": "Dana", "last": "Dentista", "company": "Smile Co"}]})
    tfid = await _item(client, ann, "tasks")
    await _act(client, ann, tfid, "add_tasks", {"tasks": [{"title": "Book dentist"}]})
    await _dm(db, ann, bob, last_seq=1, a_read=0, body="dentist gossip")

    r = await client.get("/api/today/search", headers=H(ann), params={"q": "dentist"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert set(got) == {"events", "contacts", "tasks", "tags", "mail", "notes", "porch"}
    assert got["mail"] == [] and got["notes"] == [] and got["porch"] == []
    assert [e["title"] for e in got["events"]] == ["Dentist check-up"]
    assert got["events"][0]["url"].startswith("/calendar?event=")
    assert [c["name"] for c in got["contacts"]] == ["Dana Dentista"]
    assert got["contacts"][0]["url"].startswith(f"/apps/contacts/{cfid}?c=")
    assert [t["title"] for t in got["tasks"]] == ["Book dentist"] and got["tasks"][0]["url"] == f"/apps/tasks/{tfid}"
    assert "gossip" not in r.text and "Bob dentist" not in r.text
    # Bob finds only his own.
    b = (await client.get("/api/today/search", headers=H(bob), params={"q": "dentist"})).json()
    assert [e["title"] for e in b["events"]] == ["Bob dentist"] and b["contacts"] == [] and b["tasks"] == []


async def test_journal_day_strip(client, db, pushes):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    day = date(2026, 10, 20)
    await _event(client, ann, "Lunch with Sam", day, 13)
    await _event(client, bob, "Bob's thing", day, 13)
    jfid = await _item(client, ann, "journal")
    r = await client.get(f"/api/items/k/journal/{jfid}/day", headers=H(ann), params={"date": day.isoformat()})
    assert r.status_code == 200, r.text
    got = r.json()
    assert [(e["title"], e["time"]) for e in got["events"]] == [("Lunch with Sam", "13:00")]
    assert got["photos"] == [] and got["photo_count"] == 0
    # Someone else's journal: not theirs to read from.
    assert (await client.get(f"/api/items/k/journal/{jfid}/day", headers=H(bob), params={"date": day.isoformat()})).status_code == 404
