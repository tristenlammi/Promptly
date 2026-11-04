"""Chat and maps: the tools answer from the local services and attach a map card;
a timeline is only its owner's, and isn't read on a turn with outside content.
Saved places keep the icon you chose."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

T0 = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)  # 10 am in Brisbane
SHOPS = (-27.40, 153.10)


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


def _ctx(db, user, untrusted=False):
    from app.chat.tools.base import ToolContext

    ctx = ToolContext.__new__(ToolContext)
    ctx.db, ctx.user, ctx.turn = db, user, {"untrusted": untrusted}
    return ctx


@pytest.fixture
def services(monkeypatch):
    from app.maps import engine

    asked = []

    async def photon(path, params):
        if path == "/reverse":
            return [{"geometry": {"coordinates": [params["lon"], params["lat"]]}, "properties": {"name": "The shops"}}]
        return [{"geometry": {"coordinates": [SHOPS[1], SHOPS[0]]}, "properties": {"name": params["q"].title()}}]

    async def valhalla(path, body):
        asked.append(body)
        return {"trip": {"summary": {"length": 12.0, "time": 1200, "has_toll": True}, "legs": []}}

    monkeypatch.setattr(engine, "photon", photon)
    monkeypatch.setattr(engine, "valhalla", valhalla)
    return asked


async def _home(db, user):
    from app.maps.models import MapPlace

    db.add(MapPlace(id=uuid.uuid4(), user_id=user.id, kind="home", name="Home", lat=-27.5, lon=153.0))
    await db.commit()


async def _points(db, user, day_offset=0):
    """Half an hour at the shops."""
    from app.maps.models import MapTrackPoint

    for m in range(0, 30, 3):
        db.add(MapTrackPoint(user_id=user.id, at=T0 + timedelta(days=day_offset, minutes=m), lat=SHOPS[0], lon=SHOPS[1], source="phone"))
    await db.commit()


async def test_directions_start_from_home_and_attach_a_trip_card(db, user, services):
    from app.chat.tools.maps import MapsDirectionsTool

    await _home(db, user)
    result = await MapsDirectionsTool().run(_ctx(db, user), {"to": "the beach", "via": ["the bakery"]})
    assert "12.0 km" in result.content and "20 min" in result.content and "tolls" in result.content
    assert "road speeds" in result.content and "/maps" not in result.content
    card = result.meta["map_card"]
    assert card["kind"] == "route" and card["seconds"] == 1200
    assert [s["name"] for s in card["stops"]] == ["Home", "The Bakery", "The Beach"]
    assert len(services[0]["locations"]) == 3


def _crash(closed=False):
    return {
        "id": "x", "category": 1, "label": "Crash", "text": "Crash", "from": "Main Street", "to": None, "delay_seconds": 540,
        "ends": None, "closed": closed, "lat": -27.45, "lon": 153.05, "along_km": 4.0, "points": [[-27.45, 153.05]],
    }


async def test_is_my_way_home_clear(db, user, services, monkeypatch):
    from unittest.mock import AsyncMock

    from app.chat.tools.maps import MapsDirectionsTool
    from app.maps import incidents

    await _home(db, user)
    monkeypatch.setattr(incidents, "fetch", AsyncMock(return_value=[{}]))
    monkeypatch.setattr(incidents, "on_route", lambda rows, line: [_crash()])
    result = await MapsDirectionsTool().run(_ctx(db, user), {"to": "the beach"})
    assert "Crash on Main Street, 4 km ahead, adds about 9 min" in result.content
    assert result.meta["map_card"]["warnings"] == 1


async def test_today_warns_only_when_it_is_nearly_time_to_go(db, user, services, monkeypatch):
    from unittest.mock import AsyncMock

    from app.maps import incidents
    from app.maps.today import _trip

    fetch = AsyncMock(return_value=[{}])
    monkeypatch.setattr(incidents, "fetch", fetch)
    monkeypatch.setattr(incidents, "on_route", lambda rows, line: [_crash()])
    start = {"lat": -27.5, "lon": 153.0}
    later = await _trip(db, user, start, "The beach", False)
    assert later["warning"] is None
    fetch.assert_not_called()
    soon = await _trip(db, user, start, "The beach", True)
    assert soon["warning"].startswith("Crash on Main Street")
    fetch.assert_called_once()


async def test_directions_without_a_start_say_so(db, user, services):
    from app.chat.tools.maps import MapsDirectionsTool

    result = await MapsDirectionsTool().run(_ctx(db, user), {"to": "the beach"})
    assert "Ask where" in result.content and not result.meta and not services


async def test_my_car_is_where_you_parked(db, user, services):
    from app.chat.tools.maps import MapsSearchTool
    from app.maps.models import MapParked

    db.add(MapParked(user_id=user.id, lat=-27.1, lon=153.2, source="manual"))
    await db.commit()
    result = await MapsSearchTool().run(_ctx(db, user), {"query": "my car"})
    assert result.meta["map_card"]["places"][0] == {"lat": -27.1, "lon": 153.2, "name": "Your car", "address": None}


async def test_chargers_nearest_first_by_plug(db, user, tmp_path, monkeypatch):
    from app.chat.tools.maps import MapsChargersTool
    from app.maps import data

    rows = [
        {"lat": -27.6, "lon": 153.0, "name": "Further", "sockets": [{"type": "CCS2", "count": 1, "kw": 50}], "max_kw": 50},
        {"lat": -27.51, "lon": 153.0, "name": "Close", "sockets": [{"type": "CCS2", "count": 1, "kw": 150}], "max_kw": 150},
        {"lat": -27.5, "lon": 153.01, "name": "Wrong plug", "sockets": [{"type": "Type 2", "count": 1, "kw": 7}], "max_kw": 7},
    ]
    monkeypatch.setattr(data, "chargers", lambda: rows)
    await _home(db, user)
    result = await MapsChargersTool().run(_ctx(db, user), {"plug": "CCS2"})
    assert [p["name"] for p in result.meta["map_card"]["places"]] == ["Close", "Further"]


async def test_when_was_i_at_a_place(db, user, services):
    from app.chat.tools.maps import TimelineVisitsTool

    user.settings = {**(user.settings or {}), "timezone": "Australia/Brisbane"}
    await db.commit()
    await _points(db, user)
    await _points(db, user, day_offset=3)
    result = await TimelineVisitsTool().run(_ctx(db, user), {"place": "bunnings"})
    assert result.content.startswith("2 visits.")
    # Newest first, in the person's own time.
    first, second = result.content.split("\n")[1:3]
    assert first.startswith("- Fri 13 Mar 2026, 10:00 am to 10:27 am") and second.startswith("- Tue 10 Mar 2026")
    # A date range narrows it.
    only = await TimelineVisitsTool().run(_ctx(db, user), {"place": "bunnings", "end": "2026-03-11"})
    assert only.content.startswith("1 visit.")


async def test_where_was_i_on_a_day(db, user, services):
    from app.chat.tools.maps import TimelineDayTool

    user.settings = {**(user.settings or {}), "timezone": "Australia/Brisbane"}
    await db.commit()
    await _points(db, user)
    result = await TimelineDayTool().run(_ctx(db, user), {"date": "2026-03-10"})
    assert "at The shops" in result.content
    card = result.meta["map_card"]
    assert card["kind"] == "timeline" and card["stays"][0]["name"] == "The shops"
    empty = await TimelineDayTool().run(_ctx(db, user), {"date": "2026-03-11"})
    assert "timeline is off" in empty.content


async def test_a_timeline_is_never_someone_elses(db, user, services):
    from app.auth.models import User
    from app.chat.tools.maps import TimelineDayTool, TimelineVisitsTool

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    await _points(db, user)
    assert "No visits" in (await TimelineVisitsTool().run(_ctx(db, other), {"place": "bunnings"})).content
    assert "Nothing recorded" in (await TimelineDayTool().run(_ctx(db, other), {"date": "2026-03-10"})).content


async def test_outside_content_cant_ask_for_your_timeline(db, user, services):
    from app.chat.tools.base import ToolError
    from app.chat.tools.maps import TimelineDayTool, TimelineVisitsTool

    await _points(db, user)
    with pytest.raises(ToolError):
        await TimelineDayTool().run(_ctx(db, user, untrusted=True), {"date": "2026-03-10"})
    with pytest.raises(ToolError):
        await TimelineVisitsTool().run(_ctx(db, user, untrusted=True), {"place": "bunnings"})


async def test_tools_are_offered_with_the_apps(db):
    from app.chat.tools import registry

    names = {t.name: t.category for t in registry.REGISTRY}
    for name in ("maps_search", "maps_directions", "maps_chargers", "timeline_day", "timeline_visits"):
        assert names[name] == "apps"


async def test_a_saved_place_keeps_the_icon_you_chose(user, client):
    body = {"kind": "favourite", "name": "Gym", "lat": -27.5, "lon": 153.0, "icon": "dumbbell", "colour": "#2F9E6E"}
    r = await client.post("/api/maps/places", headers=_hdr(user), json=body)
    assert r.status_code == 201 and r.json()["icon"] == "dumbbell" and r.json()["colour"] == "#2F9E6E"
    pid = r.json()["id"]
    r = await client.patch(f"/api/maps/places/{pid}", headers=_hdr(user), json={"icon": "heart"})
    assert r.json()["icon"] == "heart" and r.json()["colour"] == "#2F9E6E"
    # Only the picker's icons, and real colours: these reach the page.
    for bad in ({"icon": "<script>"}, {"colour": "red;background:url(x)"}):
        assert (await client.patch(f"/api/maps/places/{pid}", headers=_hdr(user), json=bad)).status_code == 422
