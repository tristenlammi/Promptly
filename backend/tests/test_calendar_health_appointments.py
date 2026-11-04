"""Calendar "Also show" → Health appointments: the person's own Health
file only (private health info), read in their time zone, range-limited."""
from __future__ import annotations

from datetime import date, timedelta

from tests.test_calendar import H, client, mk_user, people, pushes  # noqa: F401

_Y = date.today().year + 3
START = date(_Y, 5, 4)
END = START + timedelta(days=14)
D = lambda n: (START + timedelta(days=n)).isoformat()  # noqa: E731


async def _extras(client, u):  # noqa: F811
    r = await client.get("/api/calendar/extras", headers=H(u), params={"start": START.isoformat(), "end": END.isoformat()})
    assert r.status_code == 200, r.text
    return r.json()


async def _health(db, u, appointments):
    from app.items import service as items

    await items.install(db, u, "health")
    row, _ = await items.create_item(db, u, "health", data={"appointments": appointments})
    await db.commit()
    return str(row.id)


async def test_own_appointments_in_range_only(client, db, people):  # noqa: F811
    ann, bob, cat = people  # Europe/London
    ann_file = await _health(db, ann, [
        {"id": "a1", "at": f"{D(2)}T09:30:00+01:00", "title": "GP check-up", "who": "Dr Lee", "location": "Main St Clinic"},
        {"id": "a2", "at": f"{D(5)}T14:00:00+01:00", "title": "Dentist", "done": True},
        # 23:30 in New York is 04:30 next day in London: the day after.
        {"id": "a3", "at": f"{D(6)}T23:30:00-04:00", "title": "Late call"},
        # Out of range: before, after, and pushed past the end by the zone.
        {"id": "x1", "at": f"{(START - timedelta(days=1)).isoformat()}T10:00:00+01:00", "title": "Too early"},
        {"id": "x2", "at": f"{D(20)}T10:00:00+01:00", "title": "Too late"},
        {"id": "x3", "at": f"{D(13)}T23:30:00-04:00", "title": "Over the edge"},
    ])
    await _health(db, bob, [{"id": "b1", "at": f"{D(3)}T10:00:00+01:00", "title": "Bob's cardiology"}])

    # Off by default.
    assert (await _extras(client, ann))["appointments"] == []
    r = await client.patch("/api/calendar/prefs", headers=H(ann), json={"appointments": True})
    assert r.status_code == 200 and r.json()["appointments"] is True
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    assert boot["apps"]["health"] is True

    x = (await _extras(client, ann))["appointments"]
    assert [(a["id"], a["day"], a["time"], a["title"]) for a in x] == [
        ("a1", D(2), "09:30", "GP check-up"),
        ("a2", D(5), "14:00", "Dentist"),
        ("a3", D(7), "04:30", "Late call"),
    ]
    assert x[0]["who"] == "Dr Lee" and x[0]["location"] == "Main St Clinic" and x[0]["file_id"] == ann_file
    assert [a["done"] for a in x] == [False, True, False]

    # Bob's appointments never reach Ann (and vice versa), even switched on.
    await client.patch("/api/calendar/prefs", headers=H(bob), json={"appointments": True})
    assert [a["id"] for a in (await _extras(client, bob))["appointments"]] == ["b1"]
    # Someone with no Health app sees nothing.
    await client.patch("/api/calendar/prefs", headers=H(cat), json={"appointments": True})
    assert (await _extras(client, cat))["appointments"] == []


async def test_uninstalled_health_hides_appointments(client, db, people):  # noqa: F811
    ann, _bob, _ = people
    await _health(db, ann, [{"id": "a1", "at": f"{D(1)}T10:00:00+01:00", "title": "Physio"}])
    await client.patch("/api/calendar/prefs", headers=H(ann), json={"appointments": True})
    assert len((await _extras(client, ann))["appointments"]) == 1
    from app.items import service as items

    await items.uninstall(db, ann, "health")
    await db.commit()
    assert (await _extras(client, ann))["appointments"] == []
