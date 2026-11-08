"""The way you prefer between two places, and offering a faster way mid-trip."""
from __future__ import annotations

import uuid

import httpx
import pytest

HOME = {"lat": -27.50, "lon": 153.00, "name": "Home"}
WORK = {"lat": -27.40, "lon": 153.10, "name": "Work"}
# The way you like goes round by the coast; the direct way is a little quicker.
THROUGH = [{"lat": -27.45, "lon": 153.15, "heading": 45}, {"lat": -27.42, "lon": 153.13, "heading": 300}]


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


def _trip(points, seconds, street="Direct Rd"):
    return {"trip": {
        "summary": {"length": 15.0, "time": seconds},
        "legs": [{
            "shape": _encode(points), "summary": {"length": 15.0, "time": seconds},
            "maneuvers": [{"instruction": "Go", "length": 15.0, "time": seconds, "type": 1, "street_names": [street], "begin_shape_index": 0}],
        }],
    }}


DIRECT = [(HOME["lat"], HOME["lon"]), (-27.45, 153.05), (WORK["lat"], WORK["lon"])]
COAST = [(HOME["lat"], HOME["lon"]), (-27.45, 153.15), (-27.42, 153.13), (WORK["lat"], WORK["lon"])]


@pytest.fixture
def valhalla(monkeypatch):
    from app.config import get_settings
    from app.maps import engine

    asked = []
    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "")

    async def fake(path, body):
        asked.append(body)
        through = [p for p in body["locations"] if p.get("type") == "through"]
        return _trip(COAST, 1080, "Coast Rd") if through else _trip(DIRECT, 900)

    monkeypatch.setattr(engine, "valhalla", fake)
    return asked


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


async def _prefer(client, user, **extra):
    r = await client.post("/api/maps/preferred", headers=_hdr(user), json={"start": HOME, "end": WORK, "through": THROUGH, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def _route(client, user, a=HOME, b=WORK):
    r = await client.post("/api/maps/route", headers=_hdr(user), json={"stops": [a, b]})
    assert r.status_code == 200, r.text
    return r.json()["routes"]


async def test_your_usual_way_comes_first_even_when_slower(user, client, valhalla):
    assert [r.get("preferred") for r in await _route(client, user)] == [None]
    saved = await _prefer(client, user)
    routes = await _route(client, user)
    assert routes[0]["preferred"]["id"] == saved["id"] and routes[0]["via_name"] == "Coast Rd"
    assert routes[0]["slower_seconds"] == 180
    assert routes[1].get("preferred") is None and routes[1]["slower_seconds"] == 0


async def test_nearby_starts_count_but_other_trips_dont(user, client, valhalla):
    await _prefer(client, user)
    # Down the road from home: still that trip.
    near = {"lat": HOME["lat"] + 0.003, "lon": HOME["lon"], "name": "Your location"}
    assert (await _route(client, user, near, WORK))[0].get("preferred")
    # The other direction, and somewhere else, aren't.
    assert not (await _route(client, user, WORK, HOME))[0].get("preferred")
    other = {"lat": -28.0, "lon": 153.4, "name": "Elsewhere"}
    assert not (await _route(client, user, HOME, other))[0].get("preferred")


async def test_saving_again_replaces_and_routes_are_private(db, user, client, valhalla):
    from app.auth.models import User

    await _prefer(client, user)
    second = await _prefer(client, user, tolerance_minutes=20)
    rows = (await client.get("/api/maps/preferred", headers=_hdr(user))).json()["routes"]
    assert [r["id"] for r in rows] == [second["id"]] and rows[0]["name"] == "Home to Work"

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    assert (await client.get("/api/maps/preferred", headers=_hdr(other))).json()["routes"] == []
    assert not (await _route(client, other))[0].get("preferred")
    assert (await client.patch(f"/api/maps/preferred/{second['id']}", headers=_hdr(other), json={"tolerance_minutes": 5})).status_code == 404
    await client.delete(f"/api/maps/preferred/{second['id']}", headers=_hdr(other))
    assert (await _route(client, user))[0].get("preferred")

    r = await client.patch(f"/api/maps/preferred/{second['id']}", headers=_hdr(user), json={"tolerance_minutes": 15})
    assert r.json()["tolerance_minutes"] == 15
    await client.delete(f"/api/maps/preferred/{second['id']}", headers=_hdr(user))
    assert not (await _route(client, user))[0].get("preferred")


async def test_a_way_that_cant_be_followed_falls_back(user, client, monkeypatch):
    from fastapi import HTTPException

    from app.config import get_settings
    from app.maps import engine

    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "")

    async def fake(path, body):
        if any(p.get("type") == "through" for p in body["locations"]):
            raise HTTPException(422, detail="No route")
        return _trip(DIRECT, 900)

    monkeypatch.setattr(engine, "valhalla", fake)
    await _prefer(client, user)
    routes = await _route(client, user)
    assert len(routes) == 1 and not routes[0].get("preferred")


async def test_driving_follows_it_including_after_a_wrong_turn(user, client, valhalla):
    await _prefer(client, user)

    async def ask(lat, lon, **extra):
        r = await client.post("/api/maps/navigate/route", headers=_hdr(user), json={
            "costing": "auto", "format": "osrm",
            "locations": [{"lat": lat, "lon": lon}, {"lat": WORK["lat"], "lon": WORK["lon"], "type": "break"}], **extra,
        })
        assert r.status_code == 200, r.text
        return valhalla[-1]["locations"]

    # From the start: through both points.
    assert len(await ask(HOME["lat"], HOME["lon"])) == 4
    # Partway along, near the first: only what's still ahead.
    locations = await ask(-27.452, 153.15)
    assert [p.get("lat") for p in locations[1:-1]] == [THROUGH[1]["lat"]]
    # Off somewhere else: a plain route.
    assert len(await ask(-27.9, 153.5)) == 2
    # A route picked elsewhere already has its own points, which are left alone.
    r = await client.post("/api/maps/navigate/route", headers=_hdr(user), json={
        "costing": "auto",
        "locations": [{"lat": HOME["lat"], "lon": HOME["lon"]}, {"lat": -27.45, "lon": 153.05, "type": "via"}, {"lat": WORK["lat"], "lon": WORK["lon"]}],
    })
    assert r.status_code == 200 and valhalla[-1]["locations"][1]["lat"] == -27.45


def test_through_points_avoid_turns_and_face_the_way_you_go():
    from app.maps.planning import through_points

    # 20 km heading east.
    line = [(-27.5, 153.0 + i * 0.002) for i in range(100)]
    route = {"legs": [{"shape": _encode(line), "steps": [{"at": 0}, {"at": 50}]}]}
    points = through_points(route)
    assert 2 <= len(points) <= 12
    assert all(p["heading"] == 90 for p in points)
    assert not any(abs(p["lon"] - line[50][1]) < 0.003 for p in points)
    assert through_points({"legs": [{"shape": _encode(line[:2]), "steps": []}]}) == []


def test_routes_going_the_same_way_arent_different():
    from app.maps.planning import different

    a = {"legs": [{"shape": _encode([(-27.5, 153.0 + i * 0.001) for i in range(50)])}]}
    b = {"legs": [{"shape": _encode([(-27.5001, 153.0 + i * 0.001) for i in range(50)])}]}
    c = {"legs": [{"shape": _encode([(-27.6, 153.0 + i * 0.001) for i in range(50)])}]}
    assert not different(a, b) and different(a, c)


def _current(seconds, adds=300):
    return {"km": 15, "seconds": seconds, "legs": [{"shape": _encode(DIRECT), "km": 15, "seconds": seconds, "steps": []}], "traffic": {"seconds": seconds, "adds_seconds": adds}}


async def _better(db, user, monkeypatch, now, option_seconds, option_points=COAST):
    from app.maps import engine, planning, traffic

    async def fake(path, body):
        return _trip(option_points, option_seconds, "Coast Rd")

    async def annotate(db_, uid, routes):
        for r in routes:
            r["traffic"] = {"seconds": r["seconds"], "adds_seconds": 0}
        return True

    monkeypatch.setattr(engine, "valhalla", fake)
    monkeypatch.setattr(traffic, "annotate", annotate)
    here = {"lat": HOME["lat"], "lon": HOME["lon"], "heading": 45}
    return await planning.better_route(db, user, here, {"lat": WORK["lat"], "lon": WORK["lon"]}, "drive", _current(now))


async def test_a_faster_way_is_only_offered_when_its_worth_it(db, user, monkeypatch):
    # Saves 8 of 30 minutes.
    offer = await _better(db, user, monkeypatch, 1800, 1320)
    assert offer["saves_seconds"] == 480 and offer["via_name"] == "Coast Rd" and "through" in offer
    # 4 minutes isn't enough.
    assert await _better(db, user, monkeypatch, 1800, 1560) is None
    # Nor is the same road, however the times differ.
    assert await _better(db, user, monkeypatch, 1800, 1200, DIRECT) is None
    # Nor when you're nearly there.
    assert await _better(db, user, monkeypatch, 240, 60) is None


async def test_your_usual_way_needs_a_bigger_saving(db, user, monkeypatch):
    from app.maps.models import MapPreferredRoute

    db.add(MapPreferredRoute(
        id=uuid.uuid4(), user_id=user.id, name="Home to Work", mode="drive", from_name="Home", from_lat=HOME["lat"], from_lon=HOME["lon"],
        to_name="Work", to_lat=WORK["lat"], to_lon=WORK["lon"], through=THROUGH, tolerance_minutes=12,
    ))
    await db.commit()
    # 8 minutes would normally be offered, but this route asks for 12.
    assert await _better(db, user, monkeypatch, 1800, 1320) is None
    assert (await _better(db, user, monkeypatch, 1800, 1000))["saves_seconds"] == 800


async def test_the_driving_screen_is_told_about_a_faster_way(user, client, monkeypatch):
    from app.maps import engine, traffic

    async def annotate(db_, uid, routes):
        for r in routes:
            seconds = 1800 if r["seconds"] == 1000 else r["seconds"]
            r["traffic"] = {"seconds": seconds, "free_seconds": seconds, "adds_seconds": 300, "closures": 0, "jams": [], "covered": 1}
        return True

    async def fake(path, body):
        return _trip(COAST, 1100, "Coast Rd")

    monkeypatch.setattr(traffic, "annotate", annotate)
    monkeypatch.setattr(engine, "valhalla", fake)
    body = {"shapes": [_encode(DIRECT)], "seconds": 1000, "km": 15, "lat": HOME["lat"], "lon": HOME["lon"], "to": WORK}
    got = (await client.post("/api/maps/traffic/route", headers=_hdr(user), json=body)).json()
    assert got["traffic"]["adds_seconds"] == 300 and got["faster"]["saves_seconds"] == 700
    # Without a destination (a multi-stop trip), just the traffic.
    del body["to"]
    got = (await client.post("/api/maps/traffic/route", headers=_hdr(user), json=body)).json()
    assert got["traffic"] and got["faster"] is None


async def test_reroutes_from_the_phone_check_closures_now_and_then(user, client, valhalla, monkeypatch):
    from app.maps import planning

    checks: list[bool] = []
    real = planning.around_for_navigation

    async def spy(db, ask, check_closures=True):
        checks.append(check_closures)
        return await real(db, ask, check_closures)

    monkeypatch.setattr(planning, "around_for_navigation", spy)
    body = {"costing": "auto", "format": "osrm", "locations": [{"lat": -27.9, "lon": 153.5}, {"lat": WORK["lat"], "lon": WORK["lon"]}]}
    reroute = {**_hdr(user), "X-Promptly-Reroute": "1"}
    assert (await client.post("/api/maps/navigate/route", headers=_hdr(user), json=body)).status_code == 200
    assert (await client.post("/api/maps/navigate/route", headers=reroute, json=body)).status_code == 200
    assert (await client.post("/api/maps/navigate/route", headers=reroute, json=body)).status_code == 200
    # Starting checks; the wrong turns right after it don't.
    assert checks == [True, False, False]
    # A new trip checks again.
    assert (await client.post("/api/maps/navigate/route", headers=_hdr(user), json=body)).status_code == 200
    assert checks[-1] is True
