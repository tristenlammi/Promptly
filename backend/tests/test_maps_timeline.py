"""The timeline (a day's stays and journeys, paused means paused, deleted means
gone) and live location (only the people you chose, only while you share)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

T0 = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)  # 10 am in Brisbane


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


def _hdr(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _other(db):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    return other


def _p(minutes, lat, lon):
    return {"at": (T0 + timedelta(minutes=minutes)).isoformat(), "lat": lat, "lon": lon}


def _morning():
    """Home for half an hour, a 15-minute drive, the shops for 20 minutes."""
    home = (-27.50, 153.00)
    shops = (-27.40, 153.10)
    points = [_p(m, *home) for m in range(0, 30, 3)]
    for i in range(1, 15):
        points.append(_p(30 + i, home[0] + (shops[0] - home[0]) * i / 15, home[1] + (shops[1] - home[1]) * i / 15))
    points += [_p(45 + m, *shops) for m in range(0, 21, 3)]
    return points


@pytest.fixture
def no_photon(monkeypatch):
    from app.maps import engine

    async def fake(path, params):
        return [{"geometry": {"coordinates": [params["lon"], params["lat"]]}, "properties": {"name": "The shops", "city": "Brisbane"}}]

    monkeypatch.setattr(engine, "photon", fake)


async def _turn_on(client, user):
    r = await client.put("/api/maps/timeline/settings", headers=_hdr(user), json={"timeline_on": True})
    assert r.status_code == 200 and r.json()["timeline_on"]


async def test_a_day_reads_as_stays_and_journeys(db, user, client, no_photon):
    user.settings = {**(user.settings or {}), "timezone": "Australia/Brisbane"}
    await db.commit()
    await _turn_on(client, user)
    await client.post("/api/maps/places", headers=_hdr(user), json={"kind": "home", "name": "Home", "lat": -27.50, "lon": 153.00})
    r = await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning()})
    assert r.json()["saved"] == len(_morning())
    # Sending the same points again adds nothing (a phone retrying after no signal).
    assert (await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning()})).json()["saved"] == 0

    day = (await client.get("/api/maps/timeline/day", headers=_hdr(user), params={"date": "2026-03-10"})).json()
    kinds = [s["type"] for s in day["segments"]]
    assert kinds == ["stay", "move", "stay"], kinds
    assert day["segments"][0]["name"] == "Home" and day["segments"][0]["saved"]
    assert day["segments"][2]["name"] == "The shops"
    move = day["segments"][1]
    assert move["mode"] == "drive" and 10 < move["km"] < 20
    assert day["segments"][0]["start"].startswith("2026-03-10T10:00")
    days = (await client.get("/api/maps/timeline/days", headers=_hdr(user), params={"month": "2026-03"})).json()["days"]
    assert days == ["2026-03-10"]


async def test_a_paused_timeline_keeps_nothing(user, client):
    r = await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning()})
    assert r.json() == {"saved": 0, "timeline_on": False}


async def test_an_import_works_even_with_recording_off(user, client, no_photon):
    r = await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning(), "source": "google"})
    assert r.json()["saved"] == len(_morning())


async def test_a_timeline_is_only_its_owners(db, user, client, no_photon):
    other = await _other(db)
    await _turn_on(client, user)
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning()})
    day = (await client.get("/api/maps/timeline/day", headers=_hdr(other), params={"date": "2026-03-10"})).json()
    assert day["segments"] == [] and day["points"] == 0
    # Nor can they delete it.
    await client.delete("/api/maps/timeline", headers=_hdr(other), params={"everything": True})
    assert (await client.get("/api/maps/timeline/day", headers=_hdr(user), params={"date": "2026-03-10"})).json()["points"] > 0


async def test_deleting_really_deletes(user, client, no_photon):
    await _turn_on(client, user)
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _morning()})
    r = await client.delete("/api/maps/timeline", headers=_hdr(user), params={"start": T0.isoformat(), "end": (T0 + timedelta(minutes=30)).isoformat()})
    assert r.json()["deleted"] == 10
    r = await client.delete("/api/maps/timeline", headers=_hdr(user), params={"everything": True})
    assert r.json()["deleted"] == len(_morning()) - 10
    assert (await client.delete("/api/maps/timeline", headers=_hdr(user))).status_code == 422


async def test_old_points_go_when_a_retention_is_set(user, client):
    await client.put("/api/maps/timeline/settings", headers=_hdr(user), json={"timeline_on": True, "retention_days": 30})
    old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": [{"at": old, "lat": -27.0, "lon": 153.0}], "source": "google"})
    now = datetime.now(timezone.utc).isoformat()
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": [{"at": now, "lat": -27.0, "lon": 153.0}]})
    gone = await client.delete("/api/maps/timeline", headers=_hdr(user), params={"everything": True})
    assert gone.json()["deleted"] == 1


async def test_live_location_only_reaches_who_you_chose(db, user, client):
    friend = await _other(db)
    stranger = await _other(db)
    here = {"lat": -27.5, "lon": 153.0, "destination": "Home"}
    # Sharing with nobody: not kept, and the phone can stop.
    assert (await client.post("/api/maps/live", headers=_hdr(user), json=here)).json() == {"sharing": False, "trip": False}

    r = await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username})
    assert r.status_code == 200
    assert (await client.post("/api/maps/live", headers=_hdr(user), json=here)).json() == {"sharing": True, "trip": False}
    seen = (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"]
    assert seen[0]["live"]["lat"] == -27.5 and seen[0]["live"]["destination"] == "Home"
    assert (await client.get("/api/maps/share", headers=_hdr(stranger))).json()["shared_with_me"] == []

    # Stopping removes the position too.
    await client.delete(f"/api/maps/share/{friend.id}", headers=_hdr(user))
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []
    from app.maps.models import MapLiveLocation

    assert await db.get(MapLiveLocation, user.id, populate_existing=True) is None


async def test_a_timed_share_ends_by_itself(db, user, client):
    from app.maps.models import MapShare
    from sqlalchemy import update

    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username, "hours": 1})
    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    await db.execute(update(MapShare).where(MapShare.owner_id == user.id).values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
    await db.commit()
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []
    assert (await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})).json() == {"sharing": False, "trip": False}


async def test_you_cant_share_with_nobody_or_yourself(user, client):
    for name in ("no-such-person", user.username):
        assert (await client.put("/api/maps/share", headers=_hdr(user), json={"username": name})).status_code == 404


async def test_today_says_when_to_leave_for_your_next_event(db, user, client, monkeypatch):
    from app.maps import engine

    user.settings = {**(user.settings or {}), "timezone": "Australia/Brisbane"}
    await db.commit()

    async def photon(path, params):
        return [{"geometry": {"coordinates": [153.1, -27.4]}, "properties": {"name": "Dentist"}}]

    async def valhalla(path, body):
        return {"trip": {"summary": {"length": 12.0, "time": 1200}, "legs": []}}

    monkeypatch.setattr(engine, "photon", photon)
    monkeypatch.setattr(engine, "valhalla", valhalla)
    await client.post("/api/maps/places", headers=_hdr(user), json={"kind": "home", "name": "Home", "lat": -27.5, "lon": 153.0})
    await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})

    # An event later today, a test-unique place so nothing's cached from another run.
    from zoneinfo import ZoneInfo

    now = datetime.now(ZoneInfo("Australia/Brisbane"))
    if now.hour >= 23:
        pytest.skip("Too near midnight for an event later today")
    start = now + timedelta(minutes=30)
    r = await client.post(
        "/api/calendar/events", headers=_hdr(user),
        json={"title": "Dentist", "start": start.isoformat(), "end": (start + timedelta(minutes=30)).isoformat(), "location": f"Test Clinic {uuid.uuid4().hex[:6]}"},
    )
    assert r.status_code in (200, 201), r.text
    t = (await client.get("/api/today", headers=_hdr(user))).json()
    maps = t["sections"]["maps"]
    assert maps["parked"] and maps["next"]["title"] == "Dentist" and maps["next"]["minutes"] == 20
    # 20 minutes' drive and a little spare, 30 minutes away: time to go.
    assert maps["next"]["soon"]
    assert any(a["kind"] == "leave" for a in t["attention"])


async def test_chat_can_ask_how_far(db, user, monkeypatch):
    from app.chat.tools.base import ToolContext
    from app.chat.tools.maps import MapsDirectionsTool, MapsSearchTool
    from app.maps import engine, models

    db.add(models.MapPlace(id=uuid.uuid4(), user_id=user.id, kind="home", name="Home", lat=-27.5, lon=153.0))
    await db.commit()

    async def photon(path, params):
        return [{"geometry": {"coordinates": [153.1, -27.4]}, "properties": {"name": params["q"].title()}}]

    async def valhalla(path, body):
        assert [loc["lat"] for loc in body["locations"]] == [-27.5, -27.4]
        return {"trip": {"summary": {"length": 12.0, "time": 1200}, "legs": []}}

    monkeypatch.setattr(engine, "photon", photon)
    monkeypatch.setattr(engine, "valhalla", valhalla)
    ctx = ToolContext.__new__(ToolContext)
    ctx.db, ctx.user = db, user
    found = await MapsSearchTool().run(ctx, {"query": "the beach"})
    assert "The Beach" in found.content and found.meta["map_card"]["places"][0]["name"] == "The Beach"
    answer = await MapsDirectionsTool().run(ctx, {"to": "the beach"})
    assert "12.0 km" in answer.content and "20 min" in answer.content
    assert answer.meta["map_card"]["kind"] == "route" and answer.meta["map_card"]["seconds"] == 1200


# ---- Share this trip ---------------------------------------------------------


@pytest.fixture
def told(monkeypatch):
    from app.maps import timeline

    sent = []

    async def fake(**kwargs):
        sent.append(kwargs)

    monkeypatch.setattr(timeline, "notify_user", fake)
    return sent


async def test_a_shared_trip_reaches_only_who_you_picked_and_ends_with_the_trip(db, user, client, told):
    from app.auth.models import User
    from app.maps.models import MapLiveLocation

    friend = await _other(db)
    stranger = await _other(db)
    admin = User(email=f"a-{uuid.uuid4().hex[:8]}@example.com", username=f"a{uuid.uuid4().hex[:6]}", password_hash="x", role="admin", settings={})
    db.add(admin)
    await db.commit()
    eta = (datetime.now(timezone.utc) + timedelta(minutes=40)).isoformat()

    r = await client.put(
        "/api/maps/trip/share", headers=_hdr(user),
        json={"user_ids": [str(friend.id), str(user.id)], "destination": "The zoo", "eta": eta, "lat": -32.25, "lon": 148.6},
    )
    assert r.status_code == 200, r.text
    assert [p["user_id"] for p in r.json()["sharing_with"]] == [str(friend.id)]
    # They're told, once, and it's from you.
    assert len(told) == 1
    assert told[0]["user_id"] == friend.id and told[0]["category"] == "maps" and told[0]["actor_user_id"] == user.id
    assert "The zoo" in told[0]["body"]

    # There's something to see straight away, and the phone is told to keep reporting.
    seen = (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"]
    assert seen[0]["trip"] is True and seen[0]["live"]["lat"] == -32.25 and seen[0]["live"]["destination"] == "The zoo"
    live = await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -32.26, "lon": 148.59, "destination": "The zoo", "eta": eta})
    assert live.json() == {"sharing": True, "trip": True}
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"][0]["live"]["lat"] == -32.26

    # Nobody else, and being an admin gets you nothing.
    for other in (stranger, admin):
        assert (await client.get("/api/maps/share", headers=_hdr(other))).json()["shared_with_me"] == []
        assert (await client.get("/api/maps/trip/share", headers=_hdr(other))).json()["sharing_with"] == []

    # Sending the list again doesn't tell them again.
    await client.put("/api/maps/trip/share", headers=_hdr(user), json={"user_ids": [str(friend.id)], "eta": eta})
    assert len(told) == 1

    # Arrived (or ended): it's over, and the position goes too.
    assert (await client.delete("/api/maps/trip/share", headers=_hdr(user))).status_code == 204
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []
    assert await db.get(MapLiveLocation, user.id, populate_existing=True) is None
    assert (await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -32.26, "lon": 148.59})).json() == {"sharing": False, "trip": False}


async def test_a_shared_trip_lapses_if_the_phone_never_says_its_over(db, user, client, told):
    from app.maps.models import MapShare
    from sqlalchemy import select, update

    friend = await _other(db)
    now = datetime.now(timezone.utc)
    eta = now + timedelta(minutes=30)
    await client.put("/api/maps/trip/share", headers=_hdr(user), json={"user_ids": [str(friend.id)], "eta": eta.isoformat(), "lat": -32.25, "lon": 148.6})
    row = (await db.execute(select(MapShare).where(MapShare.owner_id == user.id))).scalar_one()
    # A couple of hours after you were due, not for ever.
    assert timedelta(hours=2) < row.expires_at - now < timedelta(hours=3)

    await db.execute(update(MapShare).where(MapShare.owner_id == user.id).values(expires_at=now - timedelta(minutes=1)))
    await db.commit()
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []


async def test_ending_a_trip_leaves_ordinary_sharing_alone(db, user, client, told):
    partner = await _other(db)
    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": partner.username})
    r = await client.put("/api/maps/trip/share", headers=_hdr(user), json={"user_ids": [str(partner.id), str(friend.id)], "lat": -32.25, "lon": 148.6})
    # The partner already sees you; only the friend is on the trip.
    assert [p["user_id"] for p in r.json()["sharing_with"]] == [str(friend.id)]

    await client.delete("/api/maps/trip/share", headers=_hdr(user))
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []
    still = (await client.get("/api/maps/share", headers=_hdr(partner))).json()["shared_with_me"]
    assert len(still) == 1 and still[0]["trip"] is False and still[0]["live"]["lat"] == -32.25


async def test_a_trip_cant_be_shared_with_someone_blocked_or_nobody(db, user, client, told):
    from app.people.blocks import UserBlock

    blocked = await _other(db)
    db.add(UserBlock(blocker_id=blocked.id, blocked_id=user.id))
    await db.commit()
    r = await client.put("/api/maps/trip/share", headers=_hdr(user), json={"user_ids": [str(blocked.id), str(uuid.uuid4())]})
    assert r.status_code == 404
    assert told == []
    assert (await client.put("/api/maps/trip/share", headers=_hdr(user), json={"user_ids": []})).status_code == 422


async def test_the_trip_picker_lists_people_here_by_name_only(db, user, client):
    from app.people.blocks import UserBlock

    friend = await _other(db)
    blocked = await _other(db)
    db.add(UserBlock(blocker_id=user.id, blocked_id=blocked.id))
    await db.commit()
    people = (await client.get("/api/maps/trip/people", headers=_hdr(user))).json()["people"]
    ids = [p["user_id"] for p in people]
    assert str(friend.id) in ids and str(blocked.id) not in ids and str(user.id) not in ids
    assert all(set(p) == {"user_id", "name"} for p in people)
    typed = (await client.get("/api/maps/trip/people", headers=_hdr(user), params={"q": friend.username[:4]})).json()["people"]
    assert str(friend.id) in [p["user_id"] for p in typed]
