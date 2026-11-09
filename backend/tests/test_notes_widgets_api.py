"""Notes W1.1: the phone widgets' API (``/api/widgets``).

* the ``widgets`` scope: a phone password without it is 403, a revoked one
  401, and phones that could use the assistant were given it (0262);
* the snapshot: calendar (free/busy, hidden and declined left out; a
  calendar unticked on the web is marked, not dropped), tasks, notes; per
  section etags, ``unchanged`` when nothing changed;
* writes are safe to send twice (``client_id``), and another person's file,
  task or note is 404 / ``gone``.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from tests.test_calendar import H, client, mk_user  # noqa: F401 — fixtures

UTC = timezone.utc
LON = ZoneInfo("Europe/London")


def _today() -> date:
    return datetime.now(LON).date()


def _at(day: date, hh: int) -> str:
    return datetime.combine(day, time(hh, 0), tzinfo=LON).astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _event(client, u, title: str, day: date, hh: int = 12) -> dict:  # noqa: F811
    r = await client.post("/api/calendar/events", headers=H(u), json={"title": title, "start": _at(day, hh), "end": _at(day, hh + 1)})
    assert r.status_code == 201, r.text
    return r.json()["event"]


async def _tasks_file(client, u) -> str:  # noqa: F811
    assert (await client.post("/api/items/store/tasks", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": "tasks"})
    assert r.status_code in (200, 201), r.text
    return r.json()["file_id"]


async def _act(client, u, fid: str, name: str, args: dict) -> dict:  # noqa: F811
    r = await client.post(f"/api/items/{fid}/actions/{name}", headers=H(u), json={"args": args})
    assert r.status_code == 200, r.text
    return r.json()


async def _device(db, u, scopes: list[str]) -> tuple[str, str]:
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    db.add(AppPassword(user_id=u.id, name="Pixel", token_hash=token_hash(token), hint=hint(token), scopes=scopes))
    await db.commit()
    return (u.username, token)


async def _snap(client, auth, **params):  # noqa: F811
    r = await client.get("/api/widgets/snapshot", auth=auth, params=params)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ the scope


def test_widgets_is_a_scope_and_new_phones_get_it():
    from app.auth.app_passwords import SCOPES
    from app.auth.pairing_router import SCOPES as PAIRED

    assert "widgets" in SCOPES and "widgets" in PAIRED


async def test_migration_gives_linked_phones_the_scope(db):
    """0262 adds ``widgets`` to every password with ``assistant`` (run here as
    its own UPDATE, the migration's statement), and to nothing else."""
    from sqlalchemy import text

    from app.auth.app_passwords import AppPassword

    u = await mk_user(db, "mig")
    phone = await _device(db, u, ["upload", "dav:read", "maps", "assistant"])
    drive = await _device(db, u, ["dav:read", "dav:write"])
    await db.execute(text(
        "UPDATE app_passwords SET scopes = array_append(scopes, 'widgets') "
        "WHERE 'assistant' = ANY(scopes) AND NOT ('widgets' = ANY(scopes))"
    ))
    await db.commit()
    rows = {r.hint: r.scopes for r in (await db.execute(select(AppPassword).where(AppPassword.user_id == u.id))).scalars()}
    from app.auth.app_passwords import hint

    assert "widgets" in rows[hint(phone[1])]
    assert "widgets" not in rows[hint(drive[1])]


async def test_scope_matrix(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    good = await _device(db, ann, ["maps", "assistant", "widgets"])
    no_widgets = await _device(db, ann, ["maps", "assistant"])
    assert (await client.get("/api/widgets/snapshot")).status_code == 401
    assert (await client.get("/api/widgets/snapshot", auth=no_widgets)).status_code == 403
    assert (await client.post("/api/widgets/tasks", auth=no_widgets, json={"client_id": str(uuid.uuid4()), "title": "x"})).status_code == 403
    assert (await client.get("/api/widgets/snapshot", auth=(ann.username, "pmt_wrong"))).status_code == 401
    assert (await client.get("/api/widgets/snapshot", auth=good)).status_code == 200
    # The web session works too (testing from a browser).
    assert (await client.get("/api/widgets/snapshot", headers=H(ann))).status_code == 200

    # Revoked in Account → Devices: 401 from the next request (the phone wipes its widgets).
    from app.auth.app_passwords import AppPassword, hint

    row = (await db.execute(select(AppPassword).where(AppPassword.hint == hint(good[1])))).scalar_one()
    assert (await client.delete(f"/api/auth/app-passwords/{row.id}", headers=H(ann))).status_code in (200, 204)
    assert (await client.get("/api/widgets/snapshot", auth=good)).status_code == 401


# ------------------------------------------------------------------ the snapshot


async def test_calendar_section_and_its_exclusions(client, db):  # noqa: F811
    from app.calendars.models import CalAttendee, CalCalendar, CalMember

    ann, bob, cat = [await mk_user(db, n) for n in ("ann", "bob", "cat")]
    auth = await _device(db, ann, ["widgets"])
    today = _today()
    await _event(client, ann, "Standup", today, 9)
    await _event(client, ann, "Dentist", today + timedelta(days=2), 14)
    await _event(client, ann, "Far away", today + timedelta(days=20), 9)
    # Bob's calendar, free/busy only to Ann; an invitation she declined; one she hid.
    await _event(client, bob, "Bob's private thing", today, 10)
    bob_cal = (await db.execute(select(CalCalendar).where(CalCalendar.owner_id == bob.id))).scalar_one()
    db.add(CalMember(calendar_id=bob_cal.id, user_id=ann.id, role="busy"))
    declined = await _event(client, bob, "Party", today, 15)
    db.add(CalAttendee(event_id=uuid.UUID(declined["event_id"]), user_id=ann.id, status="declined", invited_by=bob.id))
    hidden = await _event(client, bob, "Hidden invite", today, 16)
    db.add(CalAttendee(event_id=uuid.UUID(hidden["event_id"]), user_id=ann.id, status="invited", invited_by=bob.id, hidden=True))
    going = await _event(client, bob, "Bob's BBQ", today + timedelta(days=1), 17)
    db.add(CalAttendee(event_id=uuid.UUID(going["event_id"]), user_id=ann.id, status="going", invited_by=bob.id))
    # Cat's "Family" calendar, shared with Ann, unticked on her web calendar.
    fam = CalCalendar(name="Family", color="#22AA55", personal=False, owner_id=cat.id)
    db.add(fam)
    await db.flush()
    db.add_all([CalMember(calendar_id=fam.id, user_id=cat.id, role="owner"), CalMember(calendar_id=fam.id, user_id=ann.id, role="editor", hidden=True)])
    await db.commit()

    got = await _snap(client, auth, want="calendar", days=7)
    cal = got["calendar"]
    assert got["tz"] == "Europe/London" and got["today"] == today.isoformat()
    assert cal["from"] == today.isoformat() and cal["days"] == 7
    titles = [e["title"] for e in cal["events"]]
    assert titles == ["Standup", "Bob's BBQ", "Dentist"]
    assert not {"Bob's private thing", "Busy", "Party", "Hidden invite", "Far away"} & set(titles)
    bbq = next(e for e in cal["events"] if e["title"] == "Bob's BBQ")
    assert bbq["calendar_id"] is None and bbq["color"]  # an invitation: no calendar of Ann's
    standup = cal["events"][0]
    assert standup["calendar_id"] and standup["start"].endswith("Z") and standup["all_day"] is False
    assert standup["event_id"] in standup["id"]
    names = {c["name"]: c for c in cal["calendars"]}
    assert names["Family"]["hidden"] is True and names["Family"]["color"] == "#22AA55"
    assert all(c["id"] != str(bob_cal.id) for c in cal["calendars"])  # free/busy: never listed


async def test_tasks_section_and_etags(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    empty = await _snap(client, auth, want="tasks")
    assert empty["tasks"]["file_id"] is None and empty["tasks"]["tasks"] == []

    fid = await _tasks_file(client, ann)
    today = _today()
    await _act(client, ann, fid, "add_tasks", {"tasks": [
        {"title": "Pay rent", "due": today.isoformat(), "list": "Home"},
        {"title": "Old one", "due": (today - timedelta(days=3)).isoformat()},
        {"title": "Tomorrow", "due": (today + timedelta(days=1)).isoformat()},
        {"title": "Next month", "due": (today + timedelta(days=40)).isoformat()},
        {"title": "Someday", "notes": "no date"},
    ]})
    got = await _snap(client, auth, want="tasks,calendar", days=7)
    t = got["tasks"]
    assert t["file_id"] == fid
    assert [x["title"] for x in t["tasks"]] == ["Old one", "Pay rent", "Tomorrow"]
    home = next(lst for lst in t["lists"] if lst["name"] == "Home")
    assert next(x for x in t["tasks"] if x["title"] == "Pay rent")["list_id"] == home["id"]
    assert t["lists"][0] == {"id": "inbox", "name": "Inbox", "color": None}
    with_someday = await _snap(client, auth, want="tasks", someday="true")
    assert "Someday" in [x["title"] for x in with_someday["tasks"]["tasks"]]

    # Nothing changed: each section comes back as just its etag.
    tags = {"tasks_etag": t["etag"], "calendar_etag": got["calendar"]["etag"]}
    again = await _snap(client, auth, want="tasks,calendar", days=7, **tags)
    assert again["tasks"] == {"etag": t["etag"], "unchanged": True}
    assert again["calendar"] == {"etag": got["calendar"]["etag"], "unchanged": True}
    # A change on the web: a new etag and the whole section.
    await _act(client, ann, fid, "add_tasks", {"tasks": [{"title": "New", "due": today.isoformat()}]})
    third = await _snap(client, auth, want="tasks,calendar", days=7, **tags)
    assert third["tasks"]["etag"] != t["etag"] and "New" in [x["title"] for x in third["tasks"]["tasks"]]
    assert third["calendar"].get("unchanged") is True
    # Unknown sections are refused; days is bounded.
    assert (await client.get("/api/widgets/snapshot", auth=auth, params={"want": "mail"})).status_code == 422
    assert (await client.get("/api/widgets/snapshot", auth=auth, params={"days": 99})).status_code == 422


async def test_notes_section_reads_only_openable_notes(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    auth = await _device(db, ann, ["widgets"])

    async def note(u, **kw):
        body = {"client_id": str(uuid.uuid4()), "title": "Gate", "text": "Gate code 4471", **kw}
        r = await client.post("/api/notes", headers=H(u), json=body)
        assert r.status_code == 201, r.text
        return r.json()["note"]

    mine = await note(ann, title="Shopping", kind="list", text=None, items=[{"id": str(uuid.uuid4()), "text": t} for t in ("Eggs", "Milk")])
    text_note = await note(ann, title="Gate")
    bobs = await note(bob, title="Bob's secret")
    got = await _snap(client, auth, want="notes", note=[mine["id"], bobs["id"]])
    cards = {c["title"]: c for c in got["notes"]["cards"]}
    assert set(cards) == {"Shopping", "Gate"}
    assert cards["Shopping"]["left"] == 2 and [i["text"] for i in cards["Shopping"]["items"]] == ["Eggs", "Milk"]
    assert cards["Gate"]["text"].startswith("Gate code") and cards["Gate"]["id"] == text_note["id"]
    full = got["notes"]["notes"]
    assert full[0]["id"] == mine["id"] and full[0]["total"] == 2
    assert full[1] == {"id": bobs["id"], "gone": True}
    assert "Bob's secret" not in str(got)


# ------------------------------------------------------------------ writes


async def test_complete_is_idempotent_and_others_are_404(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    auth, bob_auth = await _device(db, ann, ["widgets"]), await _device(db, bob, ["widgets"])
    fid = await _tasks_file(client, ann)
    today = _today()
    made = await _act(client, ann, fid, "add_tasks", {"tasks": [
        {"title": "Pay rent", "due": today.isoformat()},
        {"title": "Water plants", "due": today.isoformat(), "repeat": {"freq": "daily"}},
    ]})
    rent, plants = (x["id"] for x in made["result"])

    cid = str(uuid.uuid4())
    body = {"client_id": cid, "file_id": fid, "task_id": rent, "due": today.isoformat()}
    r1 = await client.post("/api/widgets/tasks/complete", auth=auth, json=body)
    assert r1.status_code == 200, r1.text
    assert r1.json()["task"]["done"] is True and r1.json()["result"].startswith("Completed")
    r2 = await client.post("/api/widgets/tasks/complete", auth=auth, json=body)
    assert r2.status_code == 200 and r2.json()["replayed"] is True
    data = (await client.get(f"/api/items/{fid}", headers=H(ann))).json()
    doc = data.get("data") or data.get("document", {}).get("data")
    assert sum(1 for x in doc["log"] if x["task_id"] == rent) == 1  # ticked once

    # A repeating task ticked (from the widget) moves on; the same day's tick
    # sent again with a new client_id (ticked elsewhere too) isn't a second tick.
    p1 = await client.post("/api/widgets/tasks/complete", auth=auth, json={"client_id": str(uuid.uuid4()), "file_id": fid, "task_id": plants, "due": today.isoformat()})
    assert p1.json()["task"]["due"] == (today + timedelta(days=1)).isoformat()
    p2 = await client.post("/api/widgets/tasks/complete", auth=auth, json={"client_id": str(uuid.uuid4()), "file_id": fid, "task_id": plants, "due": today.isoformat()})
    assert p2.json()["result"] == "already" and p2.json()["task"]["due"] == (today + timedelta(days=1)).isoformat()

    # Untick (the widget's undo).
    u = await client.post("/api/widgets/tasks/complete", auth=auth, json={"client_id": str(uuid.uuid4()), "file_id": fid, "task_id": rent, "done": False})
    assert u.status_code == 200 and u.json()["task"]["done"] is False

    # Bob: Ann's file and task are 404; a made-up task in Ann's file is 404 for Ann.
    other = await client.post("/api/widgets/tasks/complete", auth=bob_auth, json={**body, "client_id": str(uuid.uuid4())})
    assert other.status_code == 404
    ghost_body = {**body, "client_id": str(uuid.uuid4()), "task_id": "nope"}
    assert (await client.post("/api/widgets/tasks/complete", auth=auth, json=ghost_body)).status_code == 404
    # A refused change isn't remembered: sent again, it's refused again.
    assert (await client.post("/api/widgets/tasks/complete", auth=auth, json=ghost_body)).status_code == 404
    rnd = await client.post("/api/widgets/tasks/complete", auth=auth, json={**body, "client_id": str(uuid.uuid4()), "file_id": str(uuid.uuid4())})
    assert rnd.status_code == 404
    # Answers are kept per person: Bob sending Ann's client_id gets none of hers.
    again = await client.post("/api/widgets/tasks/complete", auth=bob_auth, json={**body, "client_id": cid})
    assert again.status_code == 404 and "Pay rent" not in again.text


async def test_add_task_is_idempotent(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    today = _today()
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "title": "  Buy   milk ", "due": "today"}
    r1 = await client.post("/api/widgets/tasks", auth=auth, json=body)
    assert r1.status_code == 201, r1.text
    got = r1.json()
    assert got["task"]["title"] == "Buy milk" and got["task"]["due"] == today.isoformat()
    r2 = await client.post("/api/widgets/tasks", auth=auth, json=body)
    assert r2.json()["replayed"] is True and r2.json()["task"]["id"] == got["task"]["id"]
    snap = await _snap(client, auth, want="tasks")
    assert [t["title"] for t in snap["tasks"]["tasks"]].count("Buy milk") == 1  # made once (and the Tasks app was set up)

    # The day the phone meant, a list, and no date.
    await _act(client, ann, got["file_id"], "add_tasks", {"tasks": [{"title": "seed", "list": "Errands"}]})
    lists = (await _snap(client, auth, want="tasks"))["tasks"]["lists"]
    errands = next(x for x in lists if x["name"] == "Errands")["id"]
    day = (today + timedelta(days=3)).isoformat()
    r3 = await client.post("/api/widgets/tasks", auth=auth, json={"client_id": str(uuid.uuid4()), "title": "Post parcel", "due": day, "list_id": errands})
    assert r3.json()["task"]["due"] == day and r3.json()["task"]["list_id"] == errands
    r4 = await client.post("/api/widgets/tasks", auth=auth, json={"client_id": str(uuid.uuid4()), "title": "Undated", "due": None, "list_id": "not-a-list"})
    assert r4.json()["task"]["due"] is None and r4.json()["task"]["list_id"] == "inbox"
    tomorrow = await client.post("/api/widgets/tasks", auth=auth, json={"client_id": str(uuid.uuid4()), "title": "T", "due": "tomorrow"})
    assert tomorrow.json()["task"]["due"] == (today + timedelta(days=1)).isoformat()
    for bad in ({"title": "   "}, {"title": "x", "due": "someday"}, {"title": "x" * 501}):
        r = await client.post("/api/widgets/tasks", auth=auth, json={"client_id": str(uuid.uuid4()), **bad})
        assert r.status_code == 422, bad
