"""P Maps: your own places stay yours, search puts them first, routes are
shaped for the app, and the phone's app password only needs the ``maps`` scope.
The two map services are stubbed; they run in their own container."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi import HTTPException


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


def _feature(lat, lon, **props):
    return {"geometry": {"coordinates": [lon, lat]}, "properties": props}


@pytest.fixture
def photon(monkeypatch):
    from app.maps import engine

    calls = []

    async def fake(path, params):
        calls.append((path, params))
        return [_feature(-27.47, 153.02, name="South Bank Parklands", city="Brisbane", state="Queensland", osm_key="leisure", osm_value="park")]

    monkeypatch.setattr(engine, "photon", fake)
    return calls


async def _other(db):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    return other


PLACE = {"name": "Mum's", "lat": -33.86, "lon": 151.2, "address": "1 Test St, Sydney"}


async def test_saved_places_are_private_and_home_is_one_place(db, user, client):
    other = await _other(db)
    r = await client.post("/api/maps/places", headers=_hdr(user), json=PLACE)
    assert r.status_code == 201
    pid = r.json()["id"]
    assert (await client.get("/api/maps/places", headers=_hdr(other))).json()["places"] == []
    # Someone else can neither change nor delete it.
    assert (await client.patch(f"/api/maps/places/{pid}", headers=_hdr(other), json={"name": "x"})).status_code == 404
    await client.delete(f"/api/maps/places/{pid}", headers=_hdr(other))
    assert len((await client.get("/api/maps/places", headers=_hdr(user))).json()["places"]) == 1

    for lat in (-27.0, -28.0):
        await client.post("/api/maps/places", headers=_hdr(user), json={"kind": "home", "name": "Home", "lat": lat, "lon": 153.0})
    homes = [p for p in (await client.get("/api/maps/places", headers=_hdr(user))).json()["places"] if p["kind"] == "home"]
    assert [h["lat"] for h in homes] == [-28.0]


async def test_everything_needs_a_sign_in(client):
    for path in ("/api/maps/config", "/api/maps/places", "/api/maps/search?q=test", "/api/maps/chargers?bbox=1,2,3,4"):
        assert (await client.get(path)).status_code == 401, path


async def test_search_puts_your_own_places_and_contacts_first(db, user, client, photon):
    from app.items import service

    await client.post("/api/maps/places", headers=_hdr(user), json={**PLACE, "name": "Sam's gym"})
    row, _ = await service.open_app(db, user, "contacts")
    await db.commit()
    r = await client.post(
        f"/api/items/{row.id}/actions/add_contacts", headers=_hdr(user),
        json={"args": {"contacts": [{"full_name": "Sam Lee", "addresses": [{"label": "Home", "street": "2 Test St", "city": "Brisbane"}]}]}},
    )
    assert r.status_code == 200, r.text
    got = (await client.get("/api/maps/search", headers=_hdr(user), params={"q": "sam", "lat": -27.5, "lon": 153.0})).json()["results"]
    kinds = [x["kind"] for x in got]
    assert kinds[:2] == ["favourite", "contact"], got
    assert got[1]["name"] == "Sam Lee" and got[1]["lat"] == -27.47
    # The map search leans towards where you are, and that only goes to the local service.
    assert any(path == "/api" and params.get("lat") == -27.5 for path, params in photon)


async def test_another_persons_contacts_never_show(db, user, client, photon):
    from app.items import service

    other = await _other(db)
    row, _ = await service.open_app(db, other, "contacts")
    await db.commit()
    await client.post(
        f"/api/items/{row.id}/actions/add_contacts", headers=_hdr(other),
        json={"args": {"contacts": [{"full_name": "Secret Person", "addresses": [{"street": "3 Test St", "city": "Perth"}]}]}},
    )
    got = (await client.get("/api/maps/search", headers=_hdr(user), params={"q": "secret"})).json()["results"]
    assert not [x for x in got if x["kind"] == "contact"]


TRIP = {
    "trip": {
        "summary": {"length": 12.5, "time": 900, "has_toll": True, "has_highway": True, "has_ferry": False},
        "legs": [{
            "shape": "_p~iF~ps|U_ulLnnqC",
            "summary": {"length": 12.5, "time": 900},
            "maneuvers": [{"instruction": "Drive north.", "length": 12.5, "time": 900, "type": 1, "street_names": ["Test Rd"], "begin_shape_index": 0}],
        }],
        "locations": [{"original_index": 0}, {"original_index": 2}, {"original_index": 1}, {"original_index": 3}],
    },
    "alternates": [{"trip": {"summary": {"length": 14.0, "time": 800}, "legs": []}}],
}


async def test_routes_ask_the_way_you_chose_and_keep_the_stops_in_order(user, client, monkeypatch):
    from app.maps import engine

    asked = []

    async def fake(path, body):
        asked.append((path, body))
        return TRIP

    monkeypatch.setattr(engine, "valhalla", fake)
    stops = [{"lat": -27.0 - i, "lon": 153.0, "name": f"S{i}"} for i in range(4)]
    r = await client.post(
        "/api/maps/route", headers=_hdr(user),
        json={"stops": stops, "mode": "drive", "avoid_tolls": True, "avoid_ferries": True, "best_order": True},
    )
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["order"] == [0, 2, 1, 3]
    assert [p for p, _ in asked] == ["/optimized_route", "/route"]
    body = asked[1][1]
    assert [loc["lat"] for loc in body["locations"]] == [-27.0, -29.0, -28.0, -30.0]
    assert body["costing_options"]["auto"]["use_tolls"] == 0.0 and body["costing_options"]["auto"]["use_ferry"] == 0.0
    assert "use_highways" not in body["costing_options"]["auto"]
    route = got["routes"][0]
    assert route["km"] == 12.5 and route["toll"] and not route["ferry"]
    assert route["legs"][0]["steps"][0]["street"] == "Test Rd"
    assert len(got["routes"]) == 2


async def test_no_route_is_a_clear_answer_and_a_stopped_service_says_so(user, client, monkeypatch):
    from app.config import get_settings
    from app.maps import engine

    class Stub:
        def __init__(self, status=400, error=False):
            self.status, self.error = status, error

        async def post(self, url, json):
            if self.error:
                raise httpx.ConnectError("down")
            return httpx.Response(self.status, json={"error_code": 442, "error": "No path could be found"})

    body = {"stops": [{"lat": -27, "lon": 153}, {"lat": -42, "lon": 147}]}
    monkeypatch.setattr(get_settings(), "MAPS_VALHALLA_URL", "http://maps:8002")
    monkeypatch.setattr(engine, "_http", lambda: Stub())
    r = await client.post("/api/maps/route", headers=_hdr(user), json=body)
    assert r.status_code == 422 and "No route" in r.json()["detail"]
    monkeypatch.setattr(engine, "_http", lambda: Stub(error=True))
    assert (await client.post("/api/maps/route", headers=_hdr(user), json=body)).status_code == 503


async def test_parking_is_one_spot_and_yours(db, user, client):
    other = await _other(db)
    for lat in (-27.1, -27.2):
        assert (await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": lat, "lon": 153.0})).status_code == 200
    assert (await client.get("/api/maps/places", headers=_hdr(user))).json()["parked"]["lat"] == -27.2
    assert (await client.get("/api/maps/places", headers=_hdr(other))).json()["parked"] is None
    await client.delete("/api/maps/parked", headers=_hdr(user))
    assert (await client.get("/api/maps/places", headers=_hdr(user))).json()["parked"] is None


async def test_parking_saved_with_no_signal_keeps_its_time(db, user, client):
    """The phone sends a place it saved in a dead spot later, with when you parked:
    it keeps that time, and never replaces a place saved after it."""
    from datetime import datetime, timedelta, timezone

    early = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    r = await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -33.0, "lon": 151.0, "at": early})
    assert r.status_code == 200 and r.json()["at"].startswith(early[:16])
    # Parked again since (the web, another phone)...
    assert (await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -27.0, "lon": 153.0})).status_code == 200
    # ...so the dead spot's place, arriving late, doesn't win.
    late = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    r = await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -33.5, "lon": 151.5, "at": late})
    assert r.status_code == 200 and r.json()["lat"] == -27.0
    assert (await client.get("/api/maps/places", headers=_hdr(user))).json()["parked"]["lat"] == -27.0
    # A time in the future is now, and a newer offline one does replace an older one.
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -34.0, "lon": 150.0, "at": future, "source": "auto"})
    assert r.status_code == 200 and r.json()["lat"] == -34.0
    parked = (await client.get("/api/maps/places", headers=_hdr(user))).json()["parked"]
    assert parked["lat"] == -34.0 and datetime.fromisoformat(parked["at"]) <= datetime.now(timezone.utc)
    # No time at all keeps today's behaviour: now, whatever was there.
    assert (await client.put("/api/maps/parked", headers=_hdr(user), json={"lat": -35.0, "lon": 149.0})).json()["lat"] == -35.0


async def test_recents_keep_one_row_per_place(user, client):
    spot = {"name": "Cafe", "lat": -27.5, "lon": 153.0}
    for name in ("Cafe", "Cafe renamed"):
        await client.post("/api/maps/recents", headers=_hdr(user), json={**spot, "name": name})
    assert [r["name"] for r in (await client.get("/api/maps/places", headers=_hdr(user))).json()["recents"]] == ["Cafe renamed"]
    await client.delete("/api/maps/recents", headers=_hdr(user))
    assert (await client.get("/api/maps/places", headers=_hdr(user))).json()["recents"] == []


def _encode(points):
    out, last_lat, last_lon = [], 0, 0

    def one(value):
        value = ~(value << 1) if value < 0 else value << 1
        while value >= 0x20:
            out.append(chr((0x20 | (value & 0x1F)) + 63))
            value >>= 5
        out.append(chr(value + 63))

    for lat, lon in points:
        la, lo = round(lat * 1e6), round(lon * 1e6)
        one(la - last_lat)
        one(lo - last_lon)
        last_lat, last_lon = la, lo
    return "".join(out)


@pytest.fixture
def map_build(tmp_path, monkeypatch):
    from app.config import get_settings
    from app.maps import data

    build = tmp_path / "build-1"
    build.mkdir()
    (tmp_path / "current").write_text("build-1")
    (build / "manifest.json").write_text(json.dumps({"built_at": "2026-11-04T00:00:00Z", "osm_data": ""}))
    (build / "basemap.pmtiles").write_bytes(b"PMTiles" + bytes(100))
    (build / "chargers.json").write_text(json.dumps([
        {"lat": -27.5, "lon": 153.001, "name": "On the way", "sockets": [{"type": "CCS2", "count": 2, "kw": 150}], "max_kw": 150},
        {"lat": -27.5, "lon": 153.002, "name": "Slow one", "sockets": [{"type": "Type 2", "count": 1, "kw": 7}], "max_kw": 7},
        {"lat": -30.0, "lon": 150.0, "name": "Far away", "sockets": [], "max_kw": None},
    ]))
    (build / "cameras.json").write_text(json.dumps([{"lat": -27.5, "lon": 153.0003, "maxspeed": 60, "direction": None, "name": None}, {"lat": -27.51, "lon": 153.0, "maxspeed": None, "direction": None, "name": None}]))
    monkeypatch.setattr(get_settings(), "MAPS_DATA_DIR", str(tmp_path))
    data._cache.build = None
    yield tmp_path
    data._cache.build = None


async def test_chargers_by_area_plug_power_and_route(map_build, user, client):
    got = (await client.get("/api/maps/chargers", headers=_hdr(user), params={"bbox": "152,-28,154,-27"})).json()["chargers"]
    assert {c["name"] for c in got} == {"On the way", "Slow one"}
    got = (await client.get("/api/maps/chargers", headers=_hdr(user), params={"bbox": "152,-28,154,-27", "plug": "CCS2"})).json()["chargers"]
    assert [c["name"] for c in got] == ["On the way"]
    got = (await client.get("/api/maps/chargers", headers=_hdr(user), params={"bbox": "152,-28,154,-27", "min_kw": 50})).json()["chargers"]
    assert [c["name"] for c in got] == ["On the way"]
    shape = _encode([(-27.5, 153.0), (-27.5, 153.01)])
    along = (await client.post("/api/maps/chargers/along", headers=_hdr(user), json={"shapes": [shape]})).json()["chargers"]
    assert [c["name"] for c in along] == ["On the way", "Slow one"]
    assert (await client.post("/api/maps/chargers/along", headers=_hdr(user), json={"shapes": ["!"]})).status_code in (200, 422)


async def test_only_cameras_on_your_road_warn(map_build, user, client):
    shape = _encode([(-27.5, 153.0), (-27.5, 153.01)])
    got = (await client.post("/api/maps/cameras/along", headers=_hdr(user), json={"shapes": [shape]})).json()["cameras"]
    assert [c["maxspeed"] for c in got] == [60]


async def test_config_and_map_link(map_build, user, client):
    got = (await client.get("/api/maps/config", headers=_hdr(user))).json()
    assert got["ready"] and got["basemap"].startswith("/m/")
    r = await client.get(f"/api{got['basemap']}", headers={"Range": "bytes=0-6"})
    assert r.status_code == 206 and r.content == b"PMTiles"
    # Behind nginx, the bytes come from the build's folder.
    r = await client.get(f"/api{got['basemap']}", headers={"X-Promptly-Accel": "1"})
    assert r.headers["X-Accel-Redirect"] == "/_maps/build-1/basemap.pmtiles"


@pytest.mark.parametrize(("marker", "state"), [("addresses.source", "ok"), ("addresses.failed", "missing"), (None, "unknown")])
async def test_admins_can_see_if_addresses_are_missing(map_build, marker, state):
    from app.maps import data

    if marker:
        (data.root() / "build-1" / marker).write_text("")
    assert data.addresses_state() == state


@pytest.mark.parametrize(("age", "late"), [(10, 0), (30, 0), (37, 0), (40, 10)])
def test_overdue_map_data(age, late):
    from datetime import datetime, timedelta, timezone

    from app.maps import data

    built = (datetime.now(timezone.utc) - timedelta(days=age)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert data.overdue_days(built, 30) == late


async def test_map_data_status_is_for_admins(map_build, db, user, client):
    from app.auth.utils import create_access_token

    assert (await client.get("/api/maps/data-status")).status_code == 401
    if user.role != "admin":
        assert (await client.get("/api/maps/data-status", headers=_hdr(user))).status_code == 403
    user.role = "admin"
    await db.commit()
    headers = {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}
    got = (await client.get("/api/maps/data-status", headers=headers)).json()
    assert got["ready"] is True and got["addresses"] == "unknown"


async def test_config_with_no_map_says_so(tmp_path, monkeypatch, user, client):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "MAPS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MAP_PMTILES", raising=False)
    (tmp_path / "status.json").write_text(json.dumps({"state": "building", "step": "routing"}))
    got = (await client.get("/api/maps/config", headers=_hdr(user))).json()
    assert got["basemap"] is None and got["building"] and not got["ready"]


async def test_the_phone_signs_in_with_an_app_password_that_has_the_maps_scope(db, user, client):
    import base64

    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    def basic(token):
        return {"Authorization": "Basic " + base64.b64encode(f"{user.username}:{token}".encode()).decode()}

    good, old = new_token(), new_token()
    db.add(AppPassword(user_id=user.id, name="phone", token_hash=token_hash(good), hint=hint(good), scopes=["upload", "maps"]))
    db.add(AppPassword(user_id=user.id, name="old", token_hash=token_hash(old), hint=hint(old), scopes=["upload"]))
    await db.commit()
    assert (await client.get("/api/maps/places", headers=basic(good))).status_code == 200
    assert (await client.get("/api/maps/places", headers=basic(old))).status_code == 403
    assert (await client.get("/api/maps/places", headers=basic("nope"))).status_code == 401


def test_a_stopped_service_is_503_when_it_has_no_address(monkeypatch):
    import asyncio

    from app.config import get_settings
    from app.maps import engine

    monkeypatch.setattr(get_settings(), "MAPS_PHOTON_URL", "")
    with pytest.raises(HTTPException) as e:
        asyncio.run(engine.photon("/api", {"q": "x"}))
    assert e.value.status_code == 503


def test_shapes_decode_as_lat_lon():
    from app.maps.data import decode_polyline

    points = [(-27.5, 153.0), (-27.51, 153.02)]
    assert decode_polyline(_encode(points)) == points
