"""Today as the glue of the suite: every card is right for the person's own
clock and links to the exact thing.

On the page a failing section is dropped quietly (one app's trouble mustn't
cost the page), so these call the sections with seeded data and a fixed
"now", and the last test fails if any section logged an error on the way.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from tests.test_calendar import H, client, mk_user, pushes  # noqa: F401

UTC = timezone.utc
BNE = "Australia/Brisbane"  # UTC+10, no daylight saving
LA = "America/Los_Angeles"  # UTC-8/-7
D = date(2026, 11, 14)  # a Saturday


def _at(day: date, hh: int, mm: int, zone: str) -> str:
    return datetime.combine(day, time(hh, mm), tzinfo=ZoneInfo(zone)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def _now(day: date, hh: int, mm: int, zone: str) -> datetime:
    return datetime.combine(day, time(hh, mm), tzinfo=ZoneInfo(zone)).astimezone(UTC)


async def _event(client, u, title: str, **body) -> dict:  # noqa: F811
    r = await client.post("/api/calendar/events", headers=H(u), json={"title": title, **body})
    assert r.status_code == 201, r.text
    return r.json()["event"]


async def _day(db, u, now: datetime) -> dict:
    """What GET /api/today builds, at a fixed moment."""
    from app.today import core, hub

    await db.refresh(u)
    out = await core.build(db, u, now, photos=False)
    return await hub.extend(db, u, out)


def _titles(day: dict) -> list[str]:
    return [e["title"] for e in (day["sections"].get("events") or {}).get("events", [])]


async def _item(client, u, kind: str) -> str:  # noqa: F811
    assert (await client.post(f"/api/items/store/{kind}", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": kind})
    assert r.status_code in (200, 201), r.text
    return r.json()["file_id"]


async def _act(client, u, fid: str, name: str, args: dict) -> dict:  # noqa: F811
    r = await client.post(f"/api/items/{fid}/actions/{name}", headers=H(u), json={"args": args})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------ whose day it is


@pytest.mark.parametrize("zone", [BNE, LA, "Pacific/Kiritimati", "Europe/London"])
async def test_an_all_day_event_is_on_its_own_day_only_wherever_you_live(client, db, pushes, zone):  # noqa: F811
    """All-day events are whole dates. Far from UTC they used to show on two
    days (in Brisbane, the day itself and the morning after)."""
    u = await mk_user(db, "ann", tz=zone)
    await _event(client, u, "Mum's birthday", all_day=True, start=D.isoformat(), end=D.isoformat())

    assert _titles(await _day(db, u, _now(D - timedelta(days=1), 23, 30, zone))) == []
    assert _titles(await _day(db, u, _now(D, 0, 30, zone))) == ["Mum's birthday"]
    assert _titles(await _day(db, u, _now(D, 23, 30, zone))) == ["Mum's birthday"]
    assert _titles(await _day(db, u, _now(D + timedelta(days=1), 0, 30, zone))) == []


async def test_an_evening_event_is_today_by_your_clock_not_utc(client, db, pushes):  # noqa: F811
    """22:00 in Brisbane is noon UTC; 08:00 tomorrow is 22:00 UTC *today*."""
    u = await mk_user(db, "ann", tz=BNE)
    await _event(client, u, "Late dinner", start=_at(D, 22, 0, BNE), end=_at(D, 23, 0, BNE))
    await _event(client, u, "Tomorrow's breakfast", start=_at(D + timedelta(days=1), 8, 0, BNE), end=_at(D + timedelta(days=1), 9, 0, BNE))

    day = await _day(db, u, _now(D, 21, 0, BNE))
    assert day["date"] == D.isoformat() and _titles(day) == ["Late dinner"]
    assert [(i["time"], i["title"]) for i in day["schedule"]["items"]] == [("22:00", "Late dinner")]
    assert [(c["date"], c["title"], c["time"]) for c in day["coming"]] == [((D + timedelta(days=1)).isoformat(), "Tomorrow's breakfast", "08:00")]

    # Half an hour past midnight it's tomorrow's page.
    day = await _day(db, u, _now(D + timedelta(days=1), 0, 30, BNE))
    assert day["date"] == (D + timedelta(days=1)).isoformat() and _titles(day) == ["Tomorrow's breakfast"]


async def test_no_saved_time_zone_still_gives_a_day(client, db, pushes):  # noqa: F811
    u = await mk_user(db, "ann", tz="")
    await _event(client, u, "Call", start="2026-11-14T10:00:00Z", end="2026-11-14T11:00:00Z")
    day = await _day(db, u, datetime(2026, 11, 14, 9, 0, tzinfo=UTC))
    assert day["tz"] == "UTC" and _titles(day) == ["Call"]


# ------------------------------------------------------------ trips and stays


async def test_a_stay_on_the_calendar_shows_once_and_is_called_out_before_it_starts(client, db, pushes):  # noqa: F811
    u = await mk_user(db, "ann", tz=BNE)
    fri, sun = D - timedelta(days=1), D + timedelta(days=1)
    await _event(client, u, "Nelly", location="342 Palmwoods-Montville Road", start=_at(fri, 15, 0, BNE), end=_at(sun, 10, 0, BNE))

    # Thursday: one line in Coming up (not one a day), and a heads-up.
    thu = await _day(db, u, _now(fri - timedelta(days=1), 9, 0, BNE))
    rows = [c for c in thu["coming"] if c["kind"] == "event"]
    assert [(c["date"], c["title"], c["nights"], c["until"]) for c in rows] == [(fri.isoformat(), "Nelly", 2, sun.isoformat())]
    assert rows[0]["directions"].startswith("/maps?q=342%20Palmwoods")
    stay = next(a for a in thu["attention"] if a["kind"] == "trip")
    assert stay["title"] == "Nelly starts tomorrow" and stay["detail"].startswith("2 nights")
    assert stay["url"].startswith("/calendar?event=")

    # Friday: it's on the schedule at 3 pm, with directions, and no end time (it ends Sunday).
    f = await _day(db, u, _now(fri, 9, 0, BNE))
    [item] = f["schedule"]["items"]
    assert (item["time"], item["end"], item["title"]) == ("15:00", None, "Nelly") and item["directions"]
    assert not [c for c in f["coming"] if c["title"] == "Nelly"]

    # Saturday: you're there. A chip saying until when, not "3:00 pm" again.
    sat = await _day(db, u, _now(D, 9, 0, BNE))
    assert sat["schedule"]["items"] == []
    assert [a["title"] for a in sat["schedule"]["all_day"]] == ["Nelly · until tomorrow"]
    assert not [c for c in sat["coming"] if c["title"] == "Nelly"]
    assert not [a for a in sat["attention"] if a["kind"] == "trip"]


async def test_a_week_long_all_day_event_is_one_line_in_coming_up(client, db, pushes):  # noqa: F811
    u = await mk_user(db, "ann", tz=BNE)
    await _event(client, u, "School holidays", all_day=True, start=(D + timedelta(days=2)).isoformat(), end=(D + timedelta(days=6)).isoformat())
    day = await _day(db, u, _now(D, 9, 0, BNE))
    assert [(c["date"], c["nights"], c["until"]) for c in day["coming"]] == [((D + timedelta(days=2)).isoformat(), 4, (D + timedelta(days=6)).isoformat())]


# ------------------------------------------------------------ links go to the thing


async def test_each_row_links_to_the_exact_thing(client, db, pushes):  # noqa: F811
    u = await mk_user(db, "ann", tz=BNE)
    ev = await _event(client, u, "Dentist", location="12 Main St, Nambour", start=_at(D, 14, 0, BNE), end=_at(D, 15, 0, BNE))
    fid = await _item(client, u, "tasks")
    await _act(client, u, fid, "add_tasks", {"tasks": [
        {"title": "Pay rent", "due": D.isoformat(), "time": "17:00"},
        {"title": "Old one", "due": (D - timedelta(days=3)).isoformat()},
        {"title": "Later", "due": (D + timedelta(days=2)).isoformat()},
    ]})

    day = await _day(db, u, _now(D, 9, 0, BNE))
    tasks = day["sections"]["tasks"]
    rent, old = tasks["today"][0], tasks["overdue"][0]
    assert rent["url"] == f"/apps/tasks/{fid}?task={rent['id']}" and old["url"] == f"/apps/tasks/{fid}?task={old['id']}"
    by_title = {i["title"]: i for i in day["schedule"]["items"]}
    assert by_title["Pay rent"]["url"] == rent["url"]
    assert by_title["Dentist"]["url"] == f"/calendar?event={ev['event_id']}"
    assert by_title["Dentist"]["directions"] == "/maps?q=12%20Main%20St%2C%20Nambour"
    later = next(c for c in day["coming"] if c["kind"] == "task")
    assert later["url"].startswith(f"/apps/tasks/{fid}?task=")


# ------------------------------------------------------------ what needs you


def test_a_bill_says_which_day_not_soon():
    from app.today.hub import build_attention

    sec = {"budget": {"url": "/apps/budget/x", "overspent": [], "bills": [
        {"name": "Power", "date": "2026-11-14", "amount": "$120.00"},
        {"name": "Internet", "date": "2026-11-15", "amount": "$79.00"},
        {"name": "Rego", "date": "2026-11-16", "amount": "$410.00"},
        {"name": "Insurance", "date": "2026-11-20", "amount": "$90.00"},
    ]}}
    assert [a["title"] for a in build_attention(sec, D)] == ["Power due today", "Internet due tomorrow", "Rego due Monday"]


def test_messages_and_mail_say_who():
    from app.today.hub import build_attention

    sec = {
        "rooms": {"url": "/rooms", "rooms": [
            {"name": "sam", "dm": True, "url": "/rooms/r/1"}, {"name": "kim", "dm": True, "url": "/rooms/r/2"}, {"name": "general", "dm": False, "url": "/rooms/r/3"},
        ]},
        "mail": {"url": "/mail", "unread": 4, "needs_reply": 1, "items": [{"from": "Esther Kieft", "subject": "Arrival time?", "url": "/mail?open=a/b"}]},
    }
    got = {a["kind"]: a for a in build_attention(sec, D)}
    assert got["message"]["title"] == "Messages from 2 people" and got["message"]["detail"] == "sam, kim" and got["message"]["url"] == "/rooms"
    assert got["mail"]["title"] == "Esther Kieft is waiting for a reply" and got["mail"]["url"] == "/mail?open=a/b"
    one = build_attention({"rooms": {"url": "/rooms", "rooms": sec["rooms"]["rooms"][:1]}}, D)
    assert one[0]["title"] == "Message from sam" and one[0]["url"] == "/rooms/r/1"


async def test_someone_on_their_way_is_on_today(client, db, pushes):  # noqa: F811
    from app.maps.models import MapLiveLocation, MapShare

    ann, sam, kim = [await mk_user(db, n, tz=BNE) for n in ("ann", "sam", "kim")]
    now = _now(D, 17, 0, BNE)
    db.add(MapShare(owner_id=sam.id, viewer_id=ann.id, trip=True, expires_at=now + timedelta(hours=1)))
    db.add(MapLiveLocation(user_id=sam.id, lat=-26.7, lon=153.0, destination="Home", eta=now + timedelta(minutes=12), at=now))
    await db.commit()

    day = await _day(db, ann, now)
    [who] = day["sections"]["maps"]["arriving"]
    assert who["name"] == sam.username and who["minutes"] == 12
    assert "lat" not in who and "lon" not in who  # when, never where
    arriving = next(a for a in day["attention"] if a["kind"] == "arriving")
    assert arriving["title"] == f"{sam.username} arrives in 12 min" and arriving["detail"] == "Home"
    # Nobody else is told, and Sam isn't told about himself.
    assert "maps" not in (await _day(db, kim, now))["sections"]
    assert "maps" not in (await _day(db, sam, now))["sections"]


# ------------------------------------------------------------ the week ahead


async def test_the_next_workout_is_in_coming_up(client, db, pushes):  # noqa: F811
    from app.items import service

    u = await mk_user(db, "ann", tz=BNE)
    fid = await _item(client, u, "workout")
    row, doc = await service.primary_file(db, u, "workout")
    data = dict(doc.data or {})
    data["planned"] = [
        {"id": "p1", "date": (D + timedelta(days=2)).isoformat(), "time": "06:30", "name": "Legs", "status": "planned", "exercises": []},
        {"id": "p2", "date": (D + timedelta(days=3)).isoformat(), "name": "Skipped one", "status": "skipped", "exercises": []},
        {"id": "p3", "date": (D + timedelta(days=20)).isoformat(), "name": "Far off", "status": "planned", "exercises": []},
    ]
    doc.data = data
    await db.commit()

    day = await _day(db, u, _now(D, 9, 0, BNE))
    assert [(c["title"], c["time"], c["url"]) for c in day["coming"] if c["kind"] == "workout"] == [("Legs", "06:30", f"/apps/workout/{fid}")]


# ------------------------------------------------------------ nothing fails quietly


async def test_a_full_day_builds_without_one_section_failing(client, db, pushes, caplog):  # noqa: F811
    """The page hides a failing section and logs it. With every app in use,
    nothing may be logged: a quiet failure here is a card silently missing."""
    from app.maps.models import MapLiveLocation, MapShare

    ann, sam = await mk_user(db, "ann", tz=BNE), await mk_user(db, "sam", tz=BNE)
    real_today = datetime.now(ZoneInfo(BNE)).date()
    now = datetime.now(UTC)
    await _event(client, ann, "Standup", location="Office", start=_at(real_today, 23, 0, BNE), end=_at(real_today, 23, 30, BNE))
    await _event(client, ann, "Holiday", all_day=True, start=(real_today + timedelta(days=1)).isoformat(), end=(real_today + timedelta(days=3)).isoformat())
    for kind, name, args in [
        ("tasks", "add_tasks", {"tasks": [{"title": "Pay rent", "due": real_today.isoformat()}]}),
        ("health", "log_metrics", {"readings": [{"metric": "weight", "value": 80.5, "unit": "kg"}]}),
        ("health", "add_medication", {"name": "Vitamin D", "schedule_type": "daily", "times": ["00:00"]}),
        ("meals", "set_targets", {"kcal": 2200, "protein": 160, "carbs": 220, "fat": 70, "water_ml": 2500}),
        ("budget", "add_subscription", {"name": "Netflix", "amount": 17.99, "next_due": (real_today + timedelta(days=1)).isoformat(), "kind": "bill"}),
        ("trip", "create_trip", {"title": "Japan", "start": (real_today + timedelta(days=3)).isoformat(), "end": (real_today + timedelta(days=10)).isoformat()}),
        ("flashcards", "add_cards", {"deck": "Spanish", "cards": [{"front": "hola", "back": "hello"}]}),
        ("journal", "add_entry", {"person_asked": True, "date": real_today.isoformat(), "body": "A good day"}),
        ("contacts", "add_contacts", {"contacts": [{"full_name": "Sam Lee", "birthday": f"1990-{real_today:%m-%d}"}]}),
        ("habits", None, None), ("workout", None, None), ("mealplan", None, None),
    ]:
        from app.items import service

        found = await service.primary_file(db, ann, kind)
        fid = str(found[0].id) if found else await _item(client, ann, kind)
        if name:
            await _act(client, ann, fid, name, args)
    db.add(MapShare(owner_id=sam.id, viewer_id=ann.id, trip=True, expires_at=now + timedelta(hours=1)))
    db.add(MapLiveLocation(user_id=sam.id, lat=-26.7, lon=153.0, destination="Home", eta=now + timedelta(minutes=5), at=now))
    await db.commit()

    with caplog.at_level(logging.ERROR):
        r = await client.get("/api/today", headers=H(ann))
        b = await client.get("/api/today/briefing", headers=H(ann))
    assert r.status_code == 200 and b.status_code == 200, r.text
    failed = [rec.getMessage() for rec in caplog.records if rec.name.startswith("promptly.today") or "today" in rec.getMessage().lower()]
    assert failed == [], failed

    day = r.json()
    for key in ("events", "tasks", "health", "nutrition", "budget", "trip", "study", "journal", "people", "maps"):
        assert key in day["sections"], f"{key} card is missing"
    kinds = {a["kind"] for a in day["attention"]}
    assert {"med", "bill", "person", "arriving", "trip"} <= kinds, kinds
    assert day["progress"]["total"] >= 2
    # What's read out is what's on the page.
    said = b.json()["script"]
    assert "Standup" in said and "Pay rent" in said and "Netflix" in said and "Sam Lee" in said


async def test_a_new_account_has_a_clean_page(client, db, pushes, caplog):  # noqa: F811
    u = await mk_user(db, "newbie", tz=BNE)
    with caplog.at_level(logging.ERROR):
        r = await client.get("/api/today", headers=H(u))
    assert r.status_code == 200, r.text
    day = r.json()
    assert [rec.getMessage() for rec in caplog.records if rec.name.startswith("promptly.today")] == []
    assert day["attention"] == [] and day["coming"] == [] and day["progress"] is None
    assert day["schedule"] == {"items": [], "all_day": []}
    assert len(day["discover"]) == 4 and day["greeting"].startswith("Good ")
    assert uuid.UUID(str(u.id))  # the page is theirs alone
