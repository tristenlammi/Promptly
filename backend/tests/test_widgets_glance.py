"""The at-a-glance widgets' API (``/api/widgets/glance``, ``/people``, ``/briefing``).

* one call answers the sections asked for, from the phone's ``widgets``
  password; an unknown section is 422, a password without ``widgets`` 403;
* the app panel's counts are the sidebar's badges;
* who's on their way: people sharing a trip with you, with minutes to go;
  not someone you blocked, not trips shared with somebody else, not a share
  that isn't a trip;
* the shaping of Today, Meals & Macros, Rooms/Porch and Health from Today's
  own sections;
* the people picker leaves out you and people you've blocked;
* "Read me my day" gives the same script Today reads.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

from tests.test_notes_core import mk_user


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


async def _device(db, u, scopes: list[str]) -> tuple[str, str]:
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    db.add(AppPassword(user_id=u.id, name="Pixel", token_hash=token_hash(token), hint=hint(token), scopes=scopes))
    await db.commit()
    return (u.username, token)


async def _share_trip(db, owner, viewer, *, trip: bool = True, minutes: int = 12, destination: str = "Home") -> None:
    from sqlalchemy.dialects.postgresql import insert

    from app.maps.models import MapLiveLocation, MapShare

    now = datetime.now(timezone.utc)
    db.add(MapShare(owner_id=owner.id, viewer_id=viewer.id, trip=trip, expires_at=now + timedelta(hours=3)))
    await db.execute(
        insert(MapLiveLocation)
        .values(user_id=owner.id, lat=-27.47, lon=153.02, destination=destination, eta=now + timedelta(minutes=minutes), at=now)
        .on_conflict_do_nothing()
    )
    await db.commit()


async def test_one_call_answers_the_sections_asked_for(client, db):
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    r = await client.get("/api/widgets/glance", params={"want": "counts,today,trips,mail,nonsense"}, auth=auth)
    assert r.status_code == 200, r.text
    got = r.json()
    assert isinstance(got["counts"], dict)
    assert got["today"]["url"] == "/today" and "greeting" in got["today"]
    assert got["trips"] == []
    assert "mail" not in got  # no mailbox: nothing to show
    assert "macros" not in got  # not asked for

    bad = await client.get("/api/widgets/glance", params={"want": "nonsense"}, auth=auth)
    assert bad.status_code == 422


async def test_a_password_without_widgets_is_refused(client, db):
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["maps"])
    for path in ("/api/widgets/glance", "/api/widgets/people", "/api/widgets/briefing"):
        r = await client.get(path, auth=auth)
        assert r.status_code == 403, (path, r.text)


async def test_counts_are_the_sidebar_badges(client, db, monkeypatch):
    import app.badges as badges

    async def fake(db, user, only=None):  # noqa: ANN001
        return {"rooms": 3, "tasks": 2}

    monkeypatch.setattr(badges, "collect", fake)
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    got = (await client.get("/api/widgets/glance", params={"want": "counts"}, auth=auth)).json()
    assert got["counts"]["rooms"] == 3 and got["counts"]["tasks"] == 2


async def test_whos_on_their_way(client, db):
    from app.people import blocks

    ann, bob, cat, dan, eve = [await mk_user(db, n) for n in ("ann", "bob", "cat", "dan", "eve")]
    await _share_trip(db, bob, ann, minutes=12, destination="Ann's place")
    await _share_trip(db, cat, ann, minutes=40)
    await _share_trip(db, dan, eve, minutes=5)  # someone else's
    await _share_trip(db, eve, ann, trip=False)  # live location, not a trip
    await blocks.block(db, ann.id, cat.id)
    await db.commit()

    auth = await _device(db, ann, ["widgets"])
    got = (await client.get("/api/widgets/glance", params={"want": "trips"}, auth=auth)).json()["trips"]
    assert [t["name"] for t in got] == [bob.username]
    assert got[0]["destination"] == "Ann's place" and got[0]["minutes"] in (11, 12)
    assert "lat" not in got[0] and "lon" not in got[0]


def test_today_and_the_apps_are_shaped_from_todays_sections():
    from zoneinfo import ZoneInfo

    from app.widgets import glance

    tz = ZoneInfo("Australia/Brisbane")
    now = datetime(2026, 11, 12, 9, 0, tzinfo=tz)
    later = (now + timedelta(hours=2)).astimezone(timezone.utc)
    sec = {
        "events": {"events": [
            {"title": "Dentist", "start": later.isoformat(), "end": (later + timedelta(hours=1)).isoformat()},
            {"title": "Breakfast", "start": (now - timedelta(hours=2)).isoformat(), "end": (now - timedelta(hours=1)).isoformat()},
        ]},
        "maps": {"next": {"title": "Dentist", "minutes": 18, "leave_by_label": "10:37 am"}},
        "tasks": {"today_count": 3, "overdue_count": 1},
        "people": {"dates": [{"name": "Sam", "kind": "birthday", "in_days": 0}, {"name": "Jo", "kind": "birthday", "in_days": 3}]},
        "nutrition": {"kcal": 1523, "kcal_target": 3110, "entries": 4, "url": "/apps/meals/abc",
                      "macros": [{"key": "protein", "value": 66, "target": 184}, {"key": "fat", "value": 58, "target": 99}]},
        "rooms": {"total": 5, "rooms": [{"name": "Family", "where": "Home", "unread": 5, "url": "/rooms/r/1"}]},
        "porch": {"new_posts": {"count": 2, "from": ["Mum"], "thumbs": [{"post_id": "p1", "thumb": "/m/x", "url": "/porch/p/p1"}]}},
    }
    t = glance.today(sec, {"greeting": "Good morning, Ann", "date": "2026-11-12"}, now, tz, "Sunny, 31 degrees.")
    assert t["next"]["title"] == "Dentist" and t["next"]["time"] == "11:00 am" and t["next"]["leave_by"] == "10:37 am"
    assert t["events_left"] == 1 and t["tasks_due"] == 3 and t["tasks_overdue"] == 1
    assert t["birthdays"] == ["Sam"] and t["weather"] == "Sunny, 31 degrees."

    m = glance.macros(sec)
    assert m["kcal"] == 1523 and m["kcal_target"] == 3110 and m["protein"] == 66 and m["protein_target"] == 184
    assert m["ask_url"] == "/apps/meals/abc?tab=ask"
    assert glance.macros({}) is None

    s = glance.social(sec)
    assert s["rooms"]["unread"] == 5 and s["rooms"]["items"][0]["name"] == "Family"
    assert s["porch"]["new"] == 2 and s["porch"]["thumb"] == "/m/x" and s["porch"]["url"] == "/porch/p/p1"
    assert glance.social({})["porch"]["url"] == "/porch"


async def test_health_has_the_weight_trend_and_next_workout(db):
    from app.widgets import glance

    ann = await mk_user(db, "ann")
    sec = {"health": {"weight": "84.2 kg", "weight_unit": "kg", "weight_series": [85.0, 84.6, 84.2], "weight_change": "−0.8 kg", "url": "/apps/health/h"}}
    h = await glance.health(db, ann, sec, date(2026, 11, 12))
    assert h["series"] == [85.0, 84.6, 84.2] and h["change"] == "−0.8 kg" and "workout" not in h
    assert await glance.health(db, ann, {}, date(2026, 11, 12)) is None


async def test_the_people_picker_leaves_out_you_and_people_you_blocked(client, db, monkeypatch):
    import app.people.router as people_router
    from app.people import blocks

    ann, bob, cat = [await mk_user(db, n) for n in ("ann", "bob", "cat")]

    async def fake_search(q, details, db, viewer):  # noqa: ANN001
        return {"people": [
            {"name": "Ann", "user": {"id": str(ann.id), "username": ann.username}},
            {"name": "Bob", "user": {"id": str(bob.id), "username": bob.username}},
            {"name": "Cat", "user": {"id": str(cat.id), "username": cat.username}},
            {"name": "Not on Promptly", "user": None},
        ]}

    monkeypatch.setattr(people_router, "search", fake_search)
    await blocks.block(db, cat.id, ann.id)  # Cat blocked Ann: hidden both ways
    await db.commit()
    auth = await _device(db, ann, ["widgets"])
    got = (await client.get("/api/widgets/people", auth=auth)).json()["people"]
    assert [p["name"] for p in got] == ["Bob"]


async def test_read_me_my_day(client, db):
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    r = await client.get("/api/widgets/briefing", auth=auth)
    assert r.status_code == 200, r.text
    assert r.json()["script"]


@pytest.mark.parametrize("kind", ["home", "work"])
async def test_maps_says_youre_here_when_you_are(db, kind):
    from app.maps.models import MapPlace, MapTrackPoint
    from app.widgets import glance

    ann = await mk_user(db, "ann")
    db.add(MapPlace(user_id=ann.id, kind=kind, name=kind.title(), lat=-27.47, lon=153.02))
    db.add(MapTrackPoint(user_id=ann.id, lat=-27.4701, lon=153.0201, at=datetime.now(timezone.utc)))
    await db.commit()
    got = await glance.maps(db, ann, {}, datetime.now(timezone.utc))
    assert got["places"][0]["kind"] == kind and got["places"][0]["here"] is True
