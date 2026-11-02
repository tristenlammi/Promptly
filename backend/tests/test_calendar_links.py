"""Calendar across Promptly: shared-calendar members' own settings, events
planned in / shared to a room, who's free (times only), search, tasks and
birthdays on the calendar, and Photos people linked to contacts."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_calendar import H, add, client, listing, mk_user, people, pushes  # noqa: F401
from tests.test_rooms import make_space

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _quiet_background(monkeypatch):
    """Room cards spawn push fan-out; not needed here."""
    import app.background as bg
    import app.rooms.router as r

    monkeypatch.setattr(bg, "spawn", lambda coro, name=None: coro.close())
    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


async def _shared_calendar(client, owner, *members):
    r = await client.post("/api/calendar/calendars", headers=H(owner), json={"name": "Family", "member_ids": [str(m.id) for m in members]})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_members_get_reminders_and_their_own_settings(client, db, people, pushes):
    from app.calendars.loops import send_due

    ann, bob, cat = people
    cal = await _shared_calendar(client, ann, bob, cat)
    ev = await add(client, ann, title="Footy", calendar_id=cal, start="2026-11-05T10:00:00Z", end="2026-11-05T11:00:00Z", reminders=[30])
    eid = ev["event_id"]
    # bob (a member, not a guest) sets his own reminder; cat takes it off hers.
    r = await client.patch(f"/api/calendar/events/{eid}/me", headers=H(bob), json={"reminders": [60]})
    assert r.status_code == 200 and r.json()["event"]["reminders"] == [60]
    # A settings row isn't an invitation.
    assert r.json()["event"]["my_status"] is None and r.json()["event"]["attendees"] == []
    assert (await client.get("/api/calendar/invites", headers=H(bob))).json()["invites"] == []
    r = await client.patch(f"/api/calendar/events/{eid}/me", headers=H(cat), json={"hidden": True})
    assert r.status_code == 200
    assert [e["title"] for e in await listing(client, cat)] == []
    assert [e["title"] for e in await listing(client, bob)] == ["Footy"]
    pushes.clear()
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 0, 30, tzinfo=UTC)) == 1
    assert [p["user_id"] for p in pushes] == [bob.id]
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 30, 30, tzinfo=UTC)) == 1  # ann only; cat removed it
    assert pushes[-1]["user_id"] == ann.id
    # Saving the guest list keeps bob's own settings row.
    await client.patch(f"/api/calendar/events/{eid}", headers=H(ann), json={"guests": []})
    r = await client.get(f"/api/calendar/events/{eid}", headers=H(bob))
    assert r.json()["event"]["reminders"] == [60]


async def test_plan_in_a_room_invites_everyone_and_posts_a_card(client, db, people, pushes):
    ann, bob, cat = people
    dan = await mk_user(db, "dan")
    _sid, rid = await make_space(client, ann, bob, cat)
    pushes.clear()
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "BBQ", "start": "2026-11-14T03:00:00Z", "end": "2026-11-14T06:00:00Z", "room_id": rid,
    })
    assert r.status_code == 201, r.text
    ev = r.json()["event"]
    assert {a["user_id"] for a in ev["attendees"]} == {str(bob.id), str(cat.id)}
    assert ev["rooms"] and ev["rooms"][0]["room_id"] == rid
    assert pushes == []  # the room's card is the invitation
    assert [e["title"] for e in await listing(client, bob)] == ["BBQ"]
    msgs = (await client.get(f"/api/rooms/rooms/{rid}/messages", headers=H(bob))).json()
    msgs = msgs["messages"] if isinstance(msgs, dict) else msgs
    card = [m for m in msgs if m["meta"].get("event_id") == ev["event_id"]]
    assert card and card[0]["body"].startswith("📅 BBQ")
    # Someone who joins the room later sees the card's event and can answer.
    sid = _sid
    await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(ann), json={"user_ids": [str(dan.id)]})
    assert await listing(client, dan) == []
    r = await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(dan))
    assert r.status_code == 200 and r.json()["event"]["my_status"] is None and not r.json()["event"]["can_edit"]
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(dan), json={"status": "going"})
    assert r.status_code == 200
    assert [e["title"] for e in await listing(client, dan)] == ["BBQ"]
    up = (await client.get(f"/api/calendar/rooms/{rid}/upcoming", headers=H(dan))).json()["events"]
    assert [e["title"] for e in up] == ["BBQ"]
    # Not in the room: still private.
    outsider = await mk_user(db, "eve")
    assert (await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(outsider))).status_code == 404
    assert (await client.get(f"/api/calendar/rooms/{rid}/upcoming", headers=H(outsider))).status_code == 404


async def test_share_existing_event_to_a_room(client, people, pushes):
    ann, bob, cat = people
    _sid, rid = await make_space(client, ann, bob)
    ev = await add(client, ann, title="Movie night")
    # A guest who can't edit can't share it.
    await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"guests": [str(cat.id)]})
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/share", headers=H(cat), json={"room_id": rid})
    assert r.status_code in (403, 404)
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/share", headers=H(ann), json={"room_id": rid})
    assert r.status_code == 200, r.text
    # Shared, not invited: bob sees it from the card and adds himself.
    assert await listing(client, bob) == []
    assert (await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(bob))).status_code == 200
    await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(bob), json={"status": "maybe"})
    assert [e["my_status"] for e in await listing(client, bob)] == ["maybe"]


async def test_busy_shows_times_not_details(client, people, pushes):
    ann, bob, cat = people
    await add(client, bob, title="Secret appointment", start="2026-11-10T09:00:00Z", end="2026-11-10T10:00:00Z")
    await add(client, bob, title="Lunch", start="2026-11-10T09:30:00Z", end="2026-11-10T11:00:00Z")
    await add(client, bob, title="Holiday", all_day=True, start="2026-11-10", end="2026-11-10")
    inv = await add(client, ann, title="Thing", start="2026-11-10T14:00:00Z", end="2026-11-10T15:00:00Z", guests=[str(bob.id)])
    await client.post(f"/api/calendar/events/{inv['event_id']}/rsvp", headers=H(bob), json={"status": "declined"})
    r = await client.get("/api/calendar/busy", headers=H(cat), params={"users": f"{bob.id},{ann.id}", "start": "2026-11-10T00:00:00Z", "end": "2026-11-11T00:00:00Z"})
    assert r.status_code == 200, r.text
    busy = r.json()["busy"]
    assert busy[str(bob.id)] == [["2026-11-10T09:00:00Z", "2026-11-10T11:00:00Z"]]  # merged; all-day + declined don't count
    assert busy[str(ann.id)] == [["2026-11-10T14:00:00Z", "2026-11-10T15:00:00Z"]]
    assert "Secret" not in r.text and "Lunch" not in r.text


async def test_search(client, people, pushes):
    ann, bob, _ = people
    await add(client, ann, title="Dentist", location="Smile Clinic", start="2026-11-20T10:00:00Z", end="2026-11-20T10:30:00Z")
    await add(client, ann, title="Old dentist", start="2020-01-01T10:00:00Z", end="2020-01-01T11:00:00Z")
    await add(client, bob, title="Bob's dentist")
    r = await client.get("/api/calendar/search", headers=H(ann), params={"q": "dentist"})
    titles = [e["title"] for e in r.json()["events"]]
    assert titles[0] == "Dentist" and "Old dentist" in titles and "Bob's dentist" not in titles
    r = await client.get("/api/calendar/search", headers=H(ann), params={"q": "smile"})
    assert [e["title"] for e in r.json()["events"]] == ["Dentist"]


async def test_tasks_and_birthdays_on_the_calendar(client, db, people, pushes):
    from app.items import service as items

    ann, _bob, _ = people
    await items.create_item(db, ann, "tasks", installed_check=False, data={
        "lists": [{"id": "home", "name": "Home", "color": "#3FA66B"}],
        "tasks": [
            {"id": "t1", "title": "Pay rent", "list_id": "home", "due": "2026-11-01"},
            {"id": "t2", "title": "Done already", "due": "2026-11-02", "done": True},
            {"id": "t3", "title": "Later", "due": "2027-01-01"},
        ],
    })
    cfile, _doc = await items.create_item(db, ann, "contacts", installed_check=False, data={
        "contacts": [
            {"id": "c1", "first": "Sam", "last": "Lee", "birthday": "1990-11-12"},
            {"id": "c2", "first": "Jo", "birthday": "--11-30", "dates": [{"id": "d1", "date": "2015-11-03", "kind": "anniversary", "label": "Wedding"}]},
        ],
    })
    await db.commit()
    r = await client.get("/api/calendar/extras", headers=H(ann), params={"start": "2026-11-01", "end": "2026-12-01"})
    assert r.status_code == 200, r.text
    x = r.json()
    assert [(t["title"], t["list"]) for t in x["tasks"]] == [("Pay rent", "Home")]
    assert [(b["name"], b["kind"], b["day"], b["years"]) for b in x["birthdays"]] == [
        ("Jo", "anniversary", "2026-11-03", 11), ("Sam Lee", "birthday", "2026-11-12", 36), ("Jo", "birthday", "2026-11-30", None),
    ]
    # Turned off in the calendar's settings.
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"tasks": False})
    x = (await client.get("/api/calendar/extras", headers=H(ann), params={"start": "2026-11-01", "end": "2026-12-01"})).json()
    assert x["tasks"] == [] and len(x["birthdays"]) == 3
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    assert boot["prefs"] == {"tasks": False, "birthdays": True}

    # Link Sam to a person in Photos: their face shows with the birthday.
    pid = (await db.execute(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sam') RETURNING id"), {"u": ann.id})).scalar_one()
    await db.commit()
    r = await client.patch(f"/api/photos/people/{pid}", headers=H(ann), json={"contact": {"file_id": str(cfile.id), "contact_id": "c1"}})
    assert r.status_code == 200, r.text
    links = (await client.get("/api/photos/people/contacts", headers=H(ann), params={"file_id": str(cfile.id)})).json()["links"]
    assert links["c1"]["person_id"] == str(pid)
    x = (await client.get("/api/calendar/extras", headers=H(ann), params={"start": "2026-11-12", "end": "2026-11-13"})).json()
    assert x["birthdays"][0]["person_id"] == str(pid)
    # A contact that isn't there can't be linked; null unlinks.
    r = await client.patch(f"/api/photos/people/{pid}", headers=H(ann), json={"contact": {"file_id": str(cfile.id), "contact_id": "nope"}})
    assert r.status_code == 404
    await client.patch(f"/api/photos/people/{pid}", headers=H(ann), json={"contact": None})
    assert (await client.get("/api/photos/people/contacts", headers=H(ann), params={"file_id": str(cfile.id)})).json()["links"] == {}


async def test_chat_free_times(client, db, people, pushes):
    import uuid as _uuid

    from app.chat.tools.base import ToolContext
    from app.chat.tools.calendar import CalendarFreeTimesTool

    ann, bob, _ = people  # both Europe/London (UTC in November)
    await add(client, bob, title="Private thing", start="2030-03-12T10:00:00Z", end="2030-03-12T12:00:00Z")
    await add(client, ann, title="Mine", start="2030-03-12T15:00:00Z", end="2030-03-12T16:00:00Z")
    ctx = ToolContext(db=db, user=ann, conversation_id=_uuid.uuid4(), user_message_id=_uuid.uuid4(), turn={})
    out = await CalendarFreeTimesTool().run(ctx, {"people": [bob.username], "start": "2030-03-12", "end": "2030-03-12", "minutes": 90})
    assert "Tue 12 Mar 08:00–10:00" in out.content
    assert "Tue 12 Mar 12:00–15:00" in out.content and "Tue 12 Mar 16:00–21:00" in out.content
    assert "Private" not in out.content


async def test_share_my_own_calendar(client, db, people, pushes):
    from app.calendars.loops import send_due

    ann, bob, cat = people  # bob: ann's partner (sees everything); cat: free/busy only
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    mine = next(c for c in boot["calendars"] if c["personal"])["id"]
    ev = await add(client, ann, title="Dentist", location="Smile Clinic", start="2026-11-05T10:00:00Z", end="2026-11-05T11:00:00Z", reminders=[30])
    pushes.clear()
    r = await client.post(f"/api/calendar/calendars/{mine}/members", headers=H(ann), json={"user_ids": [str(bob.id)], "role": "viewer"})
    assert r.status_code == 200, r.text
    assert pushes[-1]["title"].endswith("shared their calendar")
    await client.post(f"/api/calendar/calendars/{mine}/members", headers=H(ann), json={"user_ids": [str(cat.id)], "role": "busy"})

    bcal = next(c for c in (await client.get("/api/calendar/bootstrap", headers=H(bob))).json()["calendars"] if c["id"] == mine)
    assert bcal["name"] == f"{ann.username}'s calendar" and bcal["role"] == "viewer"
    seen = await listing(client, bob)
    assert [(e["title"], e["location"], e["can_edit"]) for e in seen] == [("Dentist", "Smile Clinic", False)]
    # Free/busy only: when, never what.
    r = await client.get("/api/calendar/events", headers=H(cat), params={"start": "2026-11-01", "end": "2026-12-01"})
    assert [(e["title"], e["location"]) for e in r.json()["events"]] == [("Busy", "")] and "Dentist" not in r.text
    r = await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(cat))
    assert r.json()["event"]["title"] == "Busy" and "Smile" not in r.text
    assert (await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(cat), json={"status": "going"})).status_code == 404
    assert (await client.get("/api/calendar/search", headers=H(cat), params={"q": "dent"})).json()["events"] == []
    # Sharing yours lets them see it — not get your reminders.
    pushes.clear()
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 30, 30, tzinfo=UTC)) == 1
    assert [p["user_id"] for p in pushes] == [ann.id]
    # bob's own availability isn't filled with ann's events.
    r = await client.get("/api/calendar/busy", headers=H(cat), params={"users": f"{bob.id},{ann.id}", "start": "2026-11-05T00:00:00Z", "end": "2026-11-06T00:00:00Z"})
    assert r.json()["busy"][str(bob.id)] == [] and len(r.json()["busy"][str(ann.id)]) == 1
    # Upgrade bob to make changes.
    await client.patch(f"/api/calendar/calendars/{mine}/members/{bob.id}", headers=H(ann), json={"role": "editor"})
    assert (await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"title": "Dentist (moved)"})).status_code == 200


async def test_people_suggestions_from_contacts_and_photos(client, db, people, pushes):
    from app.items import service as items

    ann, bob, cat = people
    cfile, _ = await items.create_item(db, ann, "contacts", installed_check=False, data={
        "contacts": [
            {"id": "w", "first": "Bea", "emails": [{"label": "home", "value": bob.email.upper()}]},
            {"id": "x", "first": cat.username},
            {"id": "y", "first": "Stranger"},
        ],
    })
    pid = (await db.execute(text("INSERT INTO photo_people (user_id, kind, name, contact_file_id, contact_id) VALUES (:u, 'person', 'Bea', :f, 'w') RETURNING id"),
                            {"u": ann.id, "f": cfile.id})).scalar_one()
    await db.execute(text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, 'Wife', 'spouse')"), {"u": ann.id, "p": pid})
    await db.commit()
    r = await client.get("/api/calendar/people-suggestions", headers=H(ann))
    assert r.status_code == 200, r.text
    got = [(p["user"]["id"], p["contact_name"], p["label"]) for p in r.json()["people"]]
    assert got[0] == (str(bob.id), "Bea", "Wife")
    assert (str(cat.id), cat.username, None) in got and len(got) == 2
