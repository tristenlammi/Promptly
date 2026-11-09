"""Calendar: repeating events, who sees what, invites and answers, shared
calendars, scoped edits of a series, the subscribe feed, reminders, and the
chat tools."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

UTC = timezone.utc


# ------------------------------------------------------------------ recurrence (no DB)


def _occ(**kw):
    from app.calendars import recur

    base = dict(tz_name="Europe/London", exdates=[], all_day=False)
    base.update(kw)
    return recur.occurrences(**base)


def test_weekly_keeps_wall_clock_across_dst():
    s = datetime(2026, 10, 19, 8, 0, tzinfo=UTC)  # 09:00 London (BST)
    occ = _occ(start_at=s, end_at=s + timedelta(hours=1), repeat={"freq": "weekly", "interval": 1},
               range_start=datetime(2026, 10, 18, tzinfo=UTC), range_end=datetime(2026, 11, 3, tzinfo=UTC))
    # After the clocks go back (25 Oct) 09:00 London is 09:00 UTC.
    assert [o[0].hour for o in occ] == [8, 9, 9]


def test_monthly_on_31st_uses_last_day_of_short_months():
    from app.calendars import recur

    s = datetime(2026, 1, 31, 12, tzinfo=UTC)
    occ = _occ(start_at=s, end_at=s + timedelta(hours=1), tz_name="UTC", repeat=recur.clean({"freq": "monthly"}),
               range_start=s, range_end=datetime(2026, 5, 1, tzinfo=UTC))
    assert [o[0].day for o in occ] == [31, 28, 31, 30]


def test_monthly_nth_weekday_exdates_and_count():
    from app.calendars import recur

    s = datetime(2026, 11, 10, 18, tzinfo=UTC)  # 2nd Tuesday of November
    rep = recur.clean({"freq": "monthly", "monthly": "weekday", "count": 3})
    occ = _occ(start_at=s, end_at=s + timedelta(hours=2), tz_name="UTC", repeat=rep,
               exdates=["2026-12-08T18:00:00Z"], range_start=s, range_end=datetime(2027, 6, 1, tzinfo=UTC))
    assert [o[0].date().isoformat() for o in occ] == ["2026-11-10", "2027-01-12"]
    end = recur.last_end(start_at=s, end_at=s + timedelta(hours=2), all_day=False, tz_name="UTC", repeat=rep)
    assert end == datetime(2027, 1, 12, 20, tzinfo=UTC)
    assert recur.rrule_text(rep, s, False, "UTC") == "FREQ=MONTHLY;BYDAY=2TU;COUNT=3"
    assert recur.last_end(start_at=s, end_at=s, all_day=False, tz_name="UTC", repeat={"freq": "daily"}) is None


def test_all_day_yearly():
    from app.calendars import recur

    s = datetime(2020, 2, 29, tzinfo=UTC)
    occ = _occ(start_at=s, end_at=s + timedelta(days=1), all_day=True, repeat=recur.clean({"freq": "yearly"}),
               range_start=datetime(2024, 1, 1, tzinfo=UTC), range_end=datetime(2025, 1, 1, tzinfo=UTC))
    assert [o[0].date().isoformat() for o in occ] == ["2024-02-29"]


# ------------------------------------------------------------------ API


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def pushes(monkeypatch):
    """Every notification, captured instead of sent."""
    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)
    return sent


async def mk_user(db, name: str, tz: str = "Europe/London"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user", settings={"timezone": tz})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


async def add(client, u, **kw):
    body = {"title": "Dinner", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z", **kw}
    r = await client.post("/api/calendar/events", headers=H(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["event"]


async def listing(client, u, start="2026-11-01", end="2026-12-01"):
    r = await client.get("/api/calendar/events", headers=H(u), params={"start": start, "end": end})
    assert r.status_code == 200, r.text
    return r.json()["events"]


async def test_private_by_default(client, people, pushes):
    ann, bob, _ = people
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    assert len(boot["calendars"]) == 1 and boot["calendars"][0]["personal"] and boot["tz"] == "Europe/London"
    ev = await add(client, ann)
    assert [e["title"] for e in await listing(client, ann)] == ["Dinner"]
    assert await listing(client, bob) == []
    assert (await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(bob))).status_code == 404
    assert (await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"title": "x"})).status_code == 404
    assert pushes == []


async def test_invite_answer_and_hide(client, people, pushes):
    ann, bob, cat = people
    ev = await add(client, ann, guests=[str(bob.id)])
    assert [p["user_id"] for p in pushes] == [bob.id] and "invited you" in pushes[0]["title"]
    assert pushes[0]["body"].startswith("Dinner · Sat 7 Nov, 6 pm")
    mine = (await listing(client, bob))[0]
    assert mine["my_status"] == "invited" and not mine["on_my_calendar"] and not mine["can_edit"]
    assert await listing(client, cat) == []
    # Bob can't change it…
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"title": "Mine now"})
    assert r.status_code == 403
    # …but can answer, and Ann hears back.
    pushes.clear()
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(bob), json={"status": "going"})
    assert r.status_code == 200 and r.json()["event"]["my_status"] == "going"
    assert pushes[0]["user_id"] == ann.id and "is going to" in pushes[0]["title"]
    # Ann moves it: Bob is told.
    pushes.clear()
    await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"start": "2026-11-07T19:00:00Z"})
    assert [p["user_id"] for p in pushes] == [bob.id] and "changed" in pushes[0]["title"]
    moved = (await listing(client, bob))[0]
    assert moved["start"] == "2026-11-07T19:00:00Z" and moved["end"] == "2026-11-07T21:00:00Z"  # length kept
    # Bob removes it from his calendar.
    await client.patch(f"/api/calendar/events/{ev['event_id']}/me", headers=H(bob), json={"hidden": True})
    assert await listing(client, bob) == []
    assert len(await listing(client, ann)) == 1


async def test_guests_can_edit_and_uninvite(client, people, pushes):
    ann, bob, cat = people
    ev = await add(client, ann, guests=[str(bob.id), str(cat.id)], guests_can_edit=True)
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"location": "Mum's"})
    assert r.status_code == 200 and r.json()["event"]["location"] == "Mum's"
    pushes.clear()
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"guests": [str(bob.id)]})
    assert [a["user_id"] for a in r.json()["event"]["attendees"]] == [str(bob.id)]
    assert await listing(client, cat) == []
    assert [p["user_id"] for p in pushes] == [cat.id] and "cancelled" in pushes[0]["title"]
    # A guest can't delete.
    assert (await client.delete(f"/api/calendar/events/{ev['event_id']}", headers=H(bob))).status_code == 403


async def test_shared_calendar_roles(client, people, pushes):
    ann, bob, cat = people
    r = await client.post("/api/calendar/calendars", headers=H(ann), json={"name": "Family", "color": "#3FA66B", "member_ids": [str(bob.id)]})
    assert r.status_code == 201, r.text
    fam = r.json()
    assert fam["role"] == "owner" and set(fam["member_roles"]) == {str(ann.id), str(bob.id)}
    assert [p["user_id"] for p in pushes] == [bob.id]
    await client.post(f"/api/calendar/calendars/{fam['id']}/members", headers=H(ann), json={"user_ids": [str(cat.id)], "role": "viewer"})
    # Bob (editor) adds an event; everyone on the calendar sees it, nobody is pinged.
    pushes.clear()
    ev = await add(client, bob, calendar_id=fam["id"], title="Bins")
    assert pushes == []
    for u in (ann, bob, cat):
        assert [e["title"] for e in await listing(client, u)] == ["Bins"]
    # Cat (viewer) can't add or edit, but can answer.
    r = await client.post("/api/calendar/events", headers=H(cat), json={"title": "x", "start": "2026-11-08T10:00:00Z", "calendar_id": fam["id"]})
    assert r.status_code == 403
    assert (await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(cat), json={"title": "y"})).status_code == 403
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(cat), json={"status": "maybe"})
    assert r.status_code == 200 and r.json()["event"]["my_status"] == "maybe"
    assert r.json()["event"]["attendees"] == [{"user_id": str(cat.id), "status": "maybe", "guest": False}]
    # Saving the guest list doesn't wipe a member's own answer.
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"guests": []})
    assert [a["user_id"] for a in r.json()["event"]["attendees"]] == [str(cat.id)]
    # Ann (owner) can edit Bob's event on her calendar.
    assert (await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"title": "Bins out"})).status_code == 200
    # Untick it: still listed (the client hides it), flag saved.
    r = await client.patch(f"/api/calendar/calendars/{fam['id']}/me", headers=H(bob), json={"hidden": True, "color": "#000000"})
    assert r.json()["hidden"] and r.json()["color"] == "#000000" and r.json()["base_color"] == "#3FA66B"
    # Bob leaves: he no longer sees it. Cat removed by the owner.
    assert (await client.delete(f"/api/calendar/calendars/{fam['id']}/members/{bob.id}", headers=H(bob))).status_code == 204
    assert await listing(client, bob) == []
    assert (await client.delete(f"/api/calendar/calendars/{fam['id']}/members/{ann.id}", headers=H(cat))).status_code == 403
    # Personal calendars can't be deleted (sharing them is in test_calendar_links).
    personal = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()["calendars"][0]
    assert personal["personal"]
    assert (await client.delete(f"/api/calendar/calendars/{personal['id']}", headers=H(ann))).status_code == 400
    assert (await client.delete(f"/api/calendar/calendars/{fam['id']}", headers=H(ann))).status_code == 204
    assert await listing(client, cat) == []


async def test_series_scoped_edits_and_deletes(client, people, pushes):
    ann, bob, _ = people
    ev = await add(client, ann, title="Swim", start="2026-11-02T17:00:00Z", end="2026-11-02T18:00:00Z",
                   repeat={"freq": "weekly", "weekdays": [0]}, guests=[str(bob.id)])
    eid = ev["event_id"]
    occ = await listing(client, ann)
    assert [o["start"][:10] for o in occ] == ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]
    # Move only the 9th.
    r = await client.patch(f"/api/calendar/events/{eid}", headers=H(ann), json={
        "scope": "this", "occurrence": "2026-11-09T17:00:00Z", "start": "2026-11-10T17:00:00Z", "end": "2026-11-10T18:00:00Z",
    })
    assert r.status_code == 200, r.text
    one = r.json()["event"]
    assert one["event_id"] != eid and one["repeat"] is None and [a["user_id"] for a in one["attendees"]] == [str(bob.id)]
    starts = [o["start"][:10] for o in await listing(client, ann)]
    assert starts == ["2026-11-02", "2026-11-10", "2026-11-16", "2026-11-23", "2026-11-30"]
    # Delete just the 16th.
    r = await client.delete(f"/api/calendar/events/{eid}", headers=H(ann), params={"scope": "this", "occurrence": "2026-11-16T17:00:00Z"})
    assert r.status_code == 204
    assert [o["start"][:10] for o in await listing(client, ann)] == ["2026-11-02", "2026-11-10", "2026-11-23", "2026-11-30"]
    # From the 23rd on: rename.
    r = await client.patch(f"/api/calendar/events/{eid}", headers=H(ann), json={"scope": "following", "occurrence": "2026-11-23T17:00:00Z", "title": "Swim club"})
    later = r.json()["event"]
    assert later["event_id"] != eid and later["repeat"]["freq"] == "weekly"
    titles = [(o["start"][:10], o["title"]) for o in await listing(client, ann)]
    assert titles == [("2026-11-02", "Swim"), ("2026-11-10", "Swim"), ("2026-11-23", "Swim club"), ("2026-11-30", "Swim club")]
    assert len(await listing(client, bob)) == 4  # the guest follows every piece
    # A bad occurrence is refused.
    r = await client.delete(f"/api/calendar/events/{eid}", headers=H(ann), params={"scope": "this", "occurrence": "2026-11-03T17:00:00Z"})
    assert r.status_code == 400
    # Delete the rest of the new series from the 30th: only the 23rd remains of it.
    await client.delete(f"/api/calendar/events/{later['event_id']}", headers=H(ann), params={"scope": "following", "occurrence": "2026-11-30T17:00:00Z"})
    assert [o["start"][:10] for o in await listing(client, ann, end="2027-02-01")] == ["2026-11-02", "2026-11-10", "2026-11-23"]


async def test_all_day_and_validation(client, people, pushes):
    ann, _, _ = people
    ev = await add(client, ann, title="Trip", all_day=True, start="2026-11-20", end="2026-11-22")
    assert ev["start"] == "2026-11-20" and ev["end"] == "2026-11-22" and ev["reminders"] == []
    assert [e["title"] for e in await listing(client, ann, start="2026-11-22", end="2026-11-23")] == ["Trip"]
    assert await listing(client, ann, start="2026-11-23", end="2026-11-24") == []
    r = await client.post("/api/calendar/events", headers=H(ann), json={"title": "x", "start": "2026-11-08T10:00:00Z", "end": "2026-11-08T09:00:00Z"})
    assert r.status_code == 400
    # A time without an offset is the user's local time (London, GMT in November).
    ev = await add(client, ann, title="Local", start="2026-11-08T10:00", end=None)
    assert ev["start"] == "2026-11-08T10:00:00Z" and ev["end"] == "2026-11-08T11:00:00Z" and ev["reminders"] == [10]
    r = await client.get("/api/calendar/events", headers=H(ann), params={"start": "2026-01-01", "end": "2028-01-01"})
    assert r.status_code == 400


async def test_invites_list(client, people, pushes):
    ann, bob, _ = people
    ev = await add(client, ann, guests=[str(bob.id)], start="2099-01-01T10:00:00Z", end="2099-01-01T11:00:00Z")
    inv = (await client.get("/api/calendar/invites", headers=H(bob))).json()["invites"]
    assert [i["event_id"] for i in inv] == [ev["event_id"]]
    await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(bob), json={"status": "declined"})
    assert (await client.get("/api/calendar/invites", headers=H(bob))).json()["invites"] == []


async def test_subscribe_feed(client, people, pushes):
    ann, bob, _ = people
    await add(client, ann, title="Swim; laps", repeat={"freq": "weekly", "weekdays": [0, 2]}, start="2026-11-02T17:00:00Z", end="2026-11-02T18:00:00Z")
    await add(client, bob, title="Bob only")
    tok = (await client.post("/api/calendar/feed", headers=H(ann))).json()["feed_token"]
    r = await client.get(f"/api/calendar/feed/{tok}.ics")  # no login
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/calendar")
    text = r.text
    assert "BEGIN:VCALENDAR" in text and "SUMMARY:Swim\\; laps" in text and "Bob only" not in text
    assert "RRULE:FREQ=WEEKLY;BYDAY=MO,WE" in text and "DTSTART;TZID=Europe/London:20261102T170000" in text
    # Reset: the old link stops working.
    tok2 = (await client.post("/api/calendar/feed", headers=H(ann))).json()["feed_token"]
    assert tok2 != tok
    assert (await client.get(f"/api/calendar/feed/{tok}.ics")).status_code == 404
    await client.delete("/api/calendar/feed", headers=H(ann))
    assert (await client.get(f"/api/calendar/feed/{tok2}.ics")).status_code == 404


async def test_reminders_send_once(client, db, people, pushes):
    from app.calendars.loops import send_due

    ann, bob, cat = people
    ev = await add(client, ann, title="Dentist", start="2026-11-05T10:00:00Z", end="2026-11-05T10:30:00Z",
                   reminders=[30], guests=[str(bob.id), str(cat.id)])
    await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(cat), json={"status": "declined"})
    await client.patch(f"/api/calendar/events/{ev['event_id']}/me", headers=H(bob), json={"reminders": [60]})
    pushes.clear()
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 0, 30, tzinfo=UTC)) == 1  # bob's 1 h
    assert [p["user_id"] for p in pushes] == [bob.id] and pushes[0]["body"].startswith("In 1 h")
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 1, tzinfo=UTC)) == 0  # not twice
    assert await send_due(db, now=datetime(2026, 11, 5, 9, 30, 5, tzinfo=UTC)) == 1  # ann's 30 min
    assert pushes[-1]["user_id"] == ann.id
    # Long overdue (server down): skipped.
    assert await send_due(db, now=datetime(2026, 11, 5, 11, 0, tzinfo=UTC)) == 0


# ------------------------------------------------------------------ chat tools


async def test_chat_tools(client, db, people, pushes):
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.calendar import CalendarAddEventTool, CalendarChangeEventTool, CalendarEventsTool

    ann, bob, cat = people
    ctx = ToolContext(db=db, user=ann, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await CalendarAddEventTool().run(ctx, {
        "title": "Sunday lunch", "start": "2026-11-08T13:00", "end": "2026-11-08T15:00", "guests": [bob.username],
    })
    assert "Added “Sunday lunch”" in out.content and "Sun 8 Nov, 1 pm" in out.content
    assert [p["user_id"] for p in pushes] == [bob.id]
    with pytest.raises(ToolError):
        await CalendarAddEventTool().run(ctx, {"title": "x", "start": "2026-11-08T13:00", "guests": ["nobody-here"]})

    bctx = ToolContext(db=db, user=bob, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    seen = await CalendarEventsTool().run(bctx, {"start": "2026-11-08", "end": "2026-11-08"})
    assert "Sunday lunch" in seen.content and "your answer: invited" in seen.content
    eid = seen.content.split("event_id ")[1].split()[0]
    await CalendarChangeEventTool().run(bctx, {"event_id": eid, "action": "answer", "answer": "going"})
    # Cat sees nothing of it.
    cctx = ToolContext(db=db, user=cat, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    assert "Sunday lunch" not in (await CalendarEventsTool().run(cctx, {"start": "2026-11-08"})).content
    with pytest.raises(ToolError):
        await CalendarChangeEventTool().run(cctx, {"event_id": eid, "action": "delete"})
    # Ann moves it and adds Cat.
    out = await CalendarChangeEventTool().run(ctx, {"event_id": eid, "action": "update", "start": "2026-11-08T14:00", "add_guests": [cat.username]})
    assert "Sun 8 Nov, 2 pm" in out.content
    assert "Sunday lunch" in (await CalendarEventsTool().run(cctx, {"start": "2026-11-08"})).content
    # A turn that read outside content can't write.
    ctx.turn["untrusted"] = True
    with pytest.raises(ToolError):
        await CalendarAddEventTool().run(ctx, {"title": "y", "start": "2026-11-09T10:00"})


async def test_event_source_kinds(client, people, pushes):
    """An event's ``source``: a task, or a Porch post (WP-P1.6) — which must
    be one you can see; anything else is refused."""
    ann, bob, _cat = people
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "BBQ", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z",
        "source": {"kind": "porch_post", "post_id": str(uuid.uuid4())},
    })
    assert r.status_code == 404, r.text
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "BBQ", "start": "2026-11-07T18:00:00Z", "source": {"kind": "something", "id": "x"},
    })
    assert r.status_code == 422
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "BBQ", "start": "2026-11-07T18:00:00Z", "source": {"kind": "porch_post"},
    })
    assert r.status_code == 422

