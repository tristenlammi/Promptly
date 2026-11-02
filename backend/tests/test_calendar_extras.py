"""Calendar "Also show": workouts, the meal plan, bills, trips and public
holidays beside the events; the display prefs (holiday country, a second
time zone); and a task planned into a time slot (the event's ``source``)."""
from __future__ import annotations

from datetime import date, timedelta

from tests.test_calendar import H, client, mk_user, people, pushes  # noqa: F401

# A fortnight safely in the future, starting on a Monday (training-day
# placeholders only show from today on).
_Y = date.today().year + 3
START = date(_Y, 3, 1) + timedelta(days=(7 - date(_Y, 3, 1).weekday()) % 7)
END = START + timedelta(days=14)
D = lambda n: (START + timedelta(days=n)).isoformat()  # noqa: E731


async def _extras(client, u, start=START, end=END):  # noqa: F811
    r = await client.get("/api/calendar/extras", headers=H(u), params={"start": start.isoformat(), "end": end.isoformat()})
    assert r.status_code == 200, r.text
    return r.json()


async def _apps(db, u):
    from app.items import service as items

    for kind in ("workout", "mealplan", "budget", "trip"):
        await items.install(db, u, kind)
    await items.create_item(db, u, "workout", data={
        "settings": {"training_days": [0, 3], "day_focus": {"0": "Legs"}},
        "planned": [
            {"id": "p1", "date": D(0), "name": "Lower A", "status": "planned"},
            {"id": "p2", "date": D(3), "name": "Upper", "status": "skipped"},
        ],
    })
    await items.create_item(db, u, "mealplan", data={
        "recipes": [{"id": "r1", "title": "Lasagne"}],
        "plan": [
            {"id": "m1", "date": D(1), "slot": "dinner", "recipe_id": "r1"},
            {"id": "m2", "date": D(1), "slot": "breakfast", "title": "Oats"},
            {"id": "m3", "date": D(30), "slot": "lunch", "title": "Out of range"},
        ],
    })
    await items.create_item(db, u, "budget", data={
        "subscriptions": [
            {"id": "s1", "name": "Netflix", "cadence": "weekly", "amount_cents": 1599, "next_due": (START - timedelta(days=30)).isoformat(), "source": "manual"},
            {"id": "s2", "name": "Gym", "cadence": "monthly", "amount_cents": 2000, "next_due": D(2), "user_status": "cancelled"},
        ],
    })
    await items.create_item(db, u, "trip", data={
        "trips": [
            {"id": "japan", "title": "Japan", "start": D(10), "end": D(20)},
            {"id": "later", "title": "Later", "start": D(40)},
        ],
    })
    await db.commit()


async def test_prefs_defaults_and_validation(client, people):  # noqa: F811
    ann, _bob, _ = people
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    assert boot["prefs"] == {
        "tasks": True, "birthdays": True, "workouts": False, "meals": False, "bills": False, "trips": False,
        "holidays": False, "holiday_country": "", "second_tz": "",
    }
    assert set(boot["apps"]) == {"tasks", "contacts", "workout", "mealplan", "budget", "trip"}
    r = await client.patch("/api/calendar/prefs", headers=H(ann), json={"holidays": True, "holiday_country": "au", "second_tz": "Asia/Tokyo"})
    assert r.status_code == 200, r.text
    assert r.json()["holiday_country"] == "AU" and r.json()["second_tz"] == "Asia/Tokyo" and r.json()["tasks"] is True
    assert (await client.patch("/api/calendar/prefs", headers=H(ann), json={"holiday_country": "XX"})).status_code == 400
    assert (await client.patch("/api/calendar/prefs", headers=H(ann), json={"second_tz": "Mars/Base"})).status_code == 400
    # "" turns the second zone off again.
    assert (await client.patch("/api/calendar/prefs", headers=H(ann), json={"second_tz": ""})).json()["second_tz"] == ""


async def test_holiday_countries_and_guess(client, db):  # noqa: F811
    sydney = await mk_user(db, "syd", tz="Australia/Sydney")
    r = (await client.get("/api/calendar/holiday-countries", headers=H(sydney))).json()
    names = {c["code"]: c["name"] for c in r["countries"]}
    assert names["AU"] == "Australia" and names["US"] == "United States" and r["guess"] == "AU"


async def test_workouts_meals_bills_trips(client, db, people):  # noqa: F811
    ann, bob, _ = people
    await _apps(db, ann)
    # All off by default.
    x = await _extras(client, ann)
    assert x["workouts"] == x["meals"] == x["bills"] == x["trips"] == x["holidays"] == []
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"workouts": True, "meals": True, "bills": True, "trips": True})
    x = await _extras(client, ann)

    # Workouts: the planned session (skipped ones left out), plus the usual
    # training days with nothing planned (Thursday's skipped one included).
    w = [(i["kind"], i["day"], i["name"]) for i in x["workouts"]]
    assert w == [("session", D(0), "Lower A"), ("day", D(3), "Training day"), ("day", D(7), "Legs"), ("day", D(10), "Training day")]

    # Meals: in slot order, recipe titles filled in.
    assert [(m["day"], m["slot"], m["title"]) for m in x["meals"]] == [(D(1), "breakfast", "Oats"), (D(1), "dinner", "Lasagne")]

    # Bills: a weekly one rolled on into the range; a cancelled one left out.
    days = [b["day"] for b in x["bills"]]
    assert len(days) == 2 and all(b["name"] == "Netflix" for b in x["bills"])
    assert date.fromisoformat(days[1]) - date.fromisoformat(days[0]) == timedelta(days=7)
    assert x["bills"][0]["amount"] == "$15.99"

    # Trips overlapping the range, with their whole dates.
    assert [(t["trip_id"], t["start"], t["end"]) for t in x["trips"]] == [("japan", D(10), D(20))]

    # Someone else sees none of it.
    other = await _extras(client, bob)
    assert other["tasks"] == [] and other["workouts"] == [] and other["trips"] == []

    # Uninstalled apps don't show, even when switched on.
    from app.items import service as items

    await items.uninstall(db, ann, "trip")
    await db.commit()
    assert (await _extras(client, ann))["trips"] == []


async def test_holidays(client, people):  # noqa: F811
    ann, _bob, _ = people
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"holidays": True})
    # No country yet: nothing.
    assert (await _extras(client, ann, date(2026, 12, 1), date(2027, 1, 2)))["holidays"] == []
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"holiday_country": "AU"})
    x = await _extras(client, ann, date(2026, 12, 1), date(2027, 1, 2))
    got = [(h["day"], h["name"]) for h in x["holidays"]]
    assert ("2026-12-25", "Christmas Day") in got and ("2027-01-01", "New Year's Day") in got
    assert all(h["country"] == "AU" for h in x["holidays"])
    # Switched off: none, the country kept.
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"holidays": False})
    assert (await _extras(client, ann, date(2026, 12, 1), date(2027, 1, 2)))["holidays"] == []


async def test_task_planned_into_a_time_slot(client, db, people):  # noqa: F811
    from app.items import service as items

    ann, bob, _ = people
    tfile, _ = await items.create_item(db, ann, "tasks", installed_check=False, data={
        "tasks": [{"id": "t1", "title": "Write report", "due": D(2)}],
    })
    await db.commit()
    x = await _extras(client, ann)
    assert x["tasks"][0]["planned"] is None

    body = {
        "title": "Write report", "start": f"{D(2)}T09:00:00Z", "end": f"{D(2)}T10:00:00Z",
        "source": {"kind": "task", "file_id": str(tfile.id), "task_id": "t1"},
    }
    r = await client.post("/api/calendar/events", headers=H(ann), json=body)
    assert r.status_code == 201, r.text
    ev = r.json()["event"]
    assert ev["source"] == {"kind": "task", "file_id": str(tfile.id), "task_id": "t1"}
    listed = (await client.get("/api/calendar/events", headers=H(ann), params={"start": D(0), "end": D(7)})).json()["events"]
    assert listed[0]["source"]["task_id"] == "t1"

    planned = (await _extras(client, ann))["tasks"][0]["planned"]
    assert planned["event_id"] == ev["event_id"] and planned["start"] == f"{D(2)}T09:00:00Z"

    # The event's "Done" box reads (and the Tasks action ticks) the task.
    st = (await client.get("/api/calendar/extras/task", headers=H(ann), params={"file_id": str(tfile.id), "task_id": "t1"})).json()
    assert st == {"exists": True, "done": False, "title": "Write report", "repeats": False}
    r = await client.post(f"/api/items/{tfile.id}/actions/complete_tasks", headers=H(ann), json={"args": {"tasks": ["t1"]}})
    assert r.status_code == 200, r.text
    st = (await client.get("/api/calendar/extras/task", headers=H(ann), params={"file_id": str(tfile.id), "task_id": "t1"})).json()
    assert st["done"] is True
    # Not someone else's task.
    st = (await client.get("/api/calendar/extras/task", headers=H(bob), params={"file_id": str(tfile.id), "task_id": "t1"})).json()
    assert st["exists"] is False

    # Only tasks can be a source.
    bad = {**body, "source": {"kind": "note", "file_id": str(tfile.id), "task_id": "t1"}}
    assert (await client.post("/api/calendar/events", headers=H(ann), json=bad)).status_code == 422
