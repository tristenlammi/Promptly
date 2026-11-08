"""Warnings on your route, routing around closures, and a place's More details.

TomTom and the router are stubbed: the code under test is which incidents count as
on your road, what gets kept out of, and what happens when there's no way round.
"""
from __future__ import annotations

import math
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from app.config import get_settings
from app.maps import engine, incidents, planning, traffic


# A straight road going north: 0.01° of latitude is about 1.1 km.
ROAD = [(-27.50 + i * 0.001, 153.0) for i in range(21)]


def incident(ident: str = "a", category: int = 8, coords: list[list[float]] | None = None, delay: int = 0, road: str | None = "Main Street") -> dict[str, Any]:
    if coords is None:
        coords = [[153.0, -27.495], [153.0, -27.494], [153.0, -27.493]]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"id": ident, "iconCategory": category, "delay": delay, "from": road, "to": "High Street", "events": [{"description": "Closed by police"}]},
    }


def test_incident_on_the_road_in_your_direction():
    found = incidents.on_route([incident()], ROAD)
    assert len(found) == 1
    assert found[0]["closed"] is True
    assert found[0]["label"] == "Road closed"
    assert found[0]["text"] == "Closed by police"
    assert found[0]["along_km"] == pytest.approx(0.6, abs=0.1)


def test_incident_on_the_other_side_of_the_road_is_not_yours():
    opposite = [[153.0, -27.493], [153.0, -27.494], [153.0, -27.495]]
    assert incidents.on_route([incident(coords=opposite)], ROAD) == []


def test_incident_on_a_nearby_road_is_not_yours():
    parallel = [[153.002, -27.495], [153.002, -27.494], [153.002, -27.493]]
    assert incidents.on_route([incident(coords=parallel)], ROAD) == []


def test_a_road_that_only_crosses_yours_is_not_yours():
    crossing = [[152.999, -27.494], [153.0, -27.494], [153.001, -27.494]]
    assert incidents.on_route([incident(coords=crossing)], ROAD) == []


def test_they_come_in_the_order_you_reach_them():
    later = incident("late", 1, [[153.0, -27.485], [153.0, -27.484]])
    sooner = incident("soon", 9, [[153.0, -27.498], [153.0, -27.497]])
    assert [i["id"] for i in incidents.on_route([later, sooner], ROAD)] == ["soon", "late"]


def test_a_small_queue_is_left_to_the_traffic_time():
    small = incident("q", 6, delay=30)
    big = incident("Q", 6, delay=300)
    assert [i["id"] for i in incidents.on_route([small, big], ROAD)] == ["Q"]


def test_spoken_line():
    found = incidents.on_route([incident(category=1, delay=540)], ROAD)[0]
    assert incidents.spoken(found) == "Crash on Main Street, 0.6 km ahead, adds about 9 min"


def test_exclusions_cover_a_long_closure_and_stay_inside_the_router_limit():
    long_one = incident("long", coords=[[153.0, -27.5 + i * 0.0005] for i in range(30)])
    found = incidents.on_route([long_one], ROAD)
    rings = incidents.exclusions(found)
    assert len(rings) > 1
    assert sum(len(r) for r in rings) <= 100
    many = [{**found[0], "id": str(i)} for i in range(30)]
    assert sum(len(r) for r in incidents.exclusions(many)) <= 100


def test_boxes_for_a_short_trip_is_one_request():
    assert len(incidents.boxes_for([ROAD, ROAD])) == 1


def test_boxes_for_a_very_long_trip_stay_inside_the_limits():
    # Brisbane to Sydney, about 730 km: under 10,000 km² each, and a few requests at most.
    line = [(-27.5 - i * 0.065, 153.0 - i * 0.018) for i in range(100)]
    boxes = incidents.boxes_for([line])
    assert 1 < len(boxes) <= incidents.MAX_BOXES
    for west, south, east, north in boxes:
        assert (north - south) * 111 * (east - west) * 111 * math.cos(math.radians((north + south) / 2)) < 10_000


class Stub:
    """Stands in for the provider; counts what was asked."""

    def __init__(self, status: int = 200, payload: Any = None) -> None:
        self.status, self.payload, self.calls = status, payload, []

    async def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> httpx.Response:
        self.calls.append((url, params))
        return httpx.Response(self.status, json=self.payload, request=httpx.Request("GET", url))


@pytest.fixture
def provider(monkeypatch):
    def install(stub: Stub, key: str | None = "test-key") -> Stub:
        monkeypatch.setattr(traffic, "_http", lambda: stub)
        monkeypatch.setattr(traffic, "traffic_key", AsyncMock(return_value=key))
        monkeypatch.setattr(incidents, "_spend", AsyncMock(return_value=True))
        return stub

    return install


async def test_no_key_means_no_request(provider):
    stub = provider(Stub(payload={"incidents": [incident()]}), key=None)
    assert await incidents.fetch(None, [ROAD]) == []
    assert stub.calls == []


async def test_allowance_used_up_means_no_request(provider, monkeypatch):
    stub = provider(Stub(payload={"incidents": [incident()]}))
    monkeypatch.setattr(incidents, "_spend", AsyncMock(return_value=False))
    assert await incidents.fetch(None, [ROAD]) == []
    assert stub.calls == []


async def test_provider_errors_mean_no_warnings(provider):
    provider(Stub(status=500, payload={}))
    assert await incidents.fetch(None, [ROAD]) == []


async def test_the_daily_counter_stops_at_the_limit(monkeypatch):
    import app.redis_client as rc

    counts = {"n": 0}

    class Redis:
        async def incr(self, _key: str) -> int:
            counts["n"] += 1
            return counts["n"]

        async def expire(self, *_: Any) -> None:
            return None

    monkeypatch.setattr(rc, "redis", Redis())
    assert await incidents._spend("incidents", 2) is True
    assert await incidents._spend("incidents", 2) is True
    assert await incidents._spend("incidents", 2) is False


def route_on(line: list[tuple[float, float]], km: float = 5.0, seconds: float = 400.0) -> dict[str, Any]:
    from app.maps.data import decode_polyline  # noqa: F401 — the shape below is what it reads

    return {"km": km, "seconds": seconds, "legs": [{"shape": encode(line), "km": km, "seconds": seconds, "steps": []}]}


def encode(line: list[tuple[float, float]]) -> str:
    out, last = [], [0, 0]
    for lat, lon in line:
        for i, v in enumerate((round(lat * 1e6), round(lon * 1e6))):
            d = v - last[i]
            last[i] = v
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63))
                d >>= 5
            out.append(chr(d + 63))
    return "".join(out)


AROUND = [(-27.50, 153.0), (-27.50, 153.01), (-27.48, 153.01), (-27.48, 153.0)]
STOPS = [{"lat": -27.50, "lon": 153.0}, {"lat": -27.48, "lon": 153.0}]


class Router:
    """Goes down the closed road unless told to keep out of something."""

    def __init__(self, around: bool = True) -> None:
        self.around, self.asks = around, []

    async def __call__(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        self.asks.append(body)
        if body.get("exclude_polygons"):
            if not self.around:
                from fastapi import HTTPException

                raise HTTPException(422, detail="No route")
            return {"trip": "around"}
        return {"trip": "straight"}


@pytest.fixture
def routed(monkeypatch):
    def install(router: Router, reported: list[dict[str, Any]]) -> Router:
        monkeypatch.setattr(engine, "valhalla", router)
        monkeypatch.setattr(engine, "routes_out", lambda a: [route_on(AROUND if a["trip"] == "around" else ROAD)])
        monkeypatch.setattr(incidents, "fetch", AsyncMock(return_value=reported))
        return router

    return install


async def test_keeping_out_finds_the_way_around(routed):
    router = routed(Router(), [incident()])
    closed = incidents.on_route([incident()], ROAD)
    answer = await planning._keeping_out({"locations": STOPS}, closed, [incident()], lambda a: planning._line(engine.routes_out(a)[0]))
    assert answer == {"trip": "around"}
    assert router.asks[0]["exclude_polygons"]


async def test_keeping_out_says_so_when_there_is_no_way_around(routed):
    routed(Router(around=False), [incident()])
    closed = incidents.on_route([incident()], ROAD)
    assert await planning._keeping_out({"locations": STOPS}, closed, [incident()], lambda a: planning._line(engine.routes_out(a)[0])) is None


async def test_keeping_out_gives_up_if_every_way_is_closed(routed):
    """Each way round runs into the closure again: stop trying, keep the warning."""
    routed(Router(), [incident()])
    closed = incidents.on_route([incident()], ROAD)
    still_closed = lambda a: ROAD  # noqa: E731
    assert await planning._keeping_out({"locations": STOPS}, closed, [incident()], still_closed) is None


async def test_a_closed_usual_way_gives_way_to_the_way_around(routed, monkeypatch):
    routed(Router(), [incident()])
    row = SimpleNamespace(id="r", name="My way", tolerance_minutes=10)
    monkeypatch.setattr(engine, "route_body", lambda stops, mode, **_: {"locations": list(stops), "costing": "auto"})
    monkeypatch.setattr(planning, "find_preferred", AsyncMock(return_value=(row, [])))
    monkeypatch.setattr(planning, "with_through", lambda body, _: body)
    monkeypatch.setattr(traffic, "annotate", AsyncMock(return_value=False))
    planned = await planning.plan(None, SimpleNamespace(id="u"), STOPS, "drive", pins=False)
    first, *rest = planned["routes"]
    assert first["avoids"] == ["Main Street"]
    assert not first["incidents"]
    assert rest[-1]["preferred"]["name"] == "My way"
    assert rest[-1]["incidents"][0]["closed"] is True


async def test_no_way_around_keeps_the_route_and_its_warning(routed, monkeypatch):
    routed(Router(around=False), [incident()])
    monkeypatch.setattr(engine, "route_body", lambda stops, mode, **_: {"locations": list(stops), "costing": "auto"})
    monkeypatch.setattr(planning, "find_preferred", AsyncMock(return_value=None))
    monkeypatch.setattr(traffic, "annotate", AsyncMock(return_value=False))
    planned = await planning.plan(None, SimpleNamespace(id="u"), STOPS, "drive", pins=False)
    assert len(planned["routes"]) == 1
    assert planned["routes"][0]["incidents"][0]["closed"] is True


async def test_way_round_closure_says_why(routed, monkeypatch):
    routed(Router(), [incident()])
    monkeypatch.setattr(engine, "route_body", lambda stops, mode, **_: {"locations": list(stops), "costing": "auto"})
    monkeypatch.setattr(planning, "checked_through", AsyncMock(return_value=[]))
    closed = incidents.on_route([incident()], ROAD)
    offer = await planning.way_round_closure({"lat": -27.5, "lon": 153.0, "heading": 0}, STOPS[1], "drive", closed, [incident()])
    assert offer is not None
    assert offer["reason"] == "Road closed on Main Street ahead"
    assert offer["saves_seconds"] == 0


async def test_navigation_route_stays_off_a_closure(monkeypatch):
    """What the phone asks for, in the format it asks in."""
    calls: list[dict[str, Any]] = []

    async def router(path: str, body: dict[str, Any]) -> dict[str, Any]:
        calls.append(body)
        return {"routes": [{"geometry": encode(AROUND if body.get("exclude_polygons") else ROAD)}]}

    monkeypatch.setattr(engine, "valhalla", router)
    monkeypatch.setattr(incidents, "fetch", AsyncMock(return_value=[incident()]))
    answer = await planning.around_for_navigation(None, {"locations": STOPS, "costing": "auto"})
    assert answer["routes"][0]["geometry"] == encode(AROUND)
    assert calls[-1]["exclude_polygons"]


async def test_navigation_keeps_the_route_if_nothing_is_closed(monkeypatch):
    calls: list[dict[str, Any]] = []

    async def router(path: str, body: dict[str, Any]) -> dict[str, Any]:
        calls.append(body)
        return {"routes": [{"geometry": encode(ROAD)}]}

    monkeypatch.setattr(engine, "valhalla", router)
    monkeypatch.setattr(incidents, "fetch", AsyncMock(return_value=[incident(category=9)]))
    await planning.around_for_navigation(None, {"locations": STOPS, "costing": "auto"})
    assert len(calls) == 1


async def test_navigation_on_foot_spends_nothing(monkeypatch):
    async def router(path: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"routes": [{"geometry": encode(ROAD)}]}

    fetch = AsyncMock(return_value=[])
    monkeypatch.setattr(engine, "valhalla", router)
    monkeypatch.setattr(incidents, "fetch", fetch)
    await planning.around_for_navigation(None, {"locations": STOPS, "costing": "pedestrian"})
    fetch.assert_not_called()


async def test_place_details_reads_the_answer_and_keeps_nothing(provider):
    stub = provider(Stub(payload={"results": [{"poi": {
        "name": "Bunnings", "phone": "+61 7 0000 0000", "url": "bunnings.com.au", "categories": ["hardware"],
        "openingHours": {"timeRanges": [{"startTime": {"date": "2026-11-04", "hour": 6, "minute": 0}, "endTime": {"date": "2026-11-04", "hour": 21, "minute": 30}}]},
    }}]}))
    got = await incidents.place_details(None, "Bunnings & Co", -27.5, 153.0)
    assert got["url"] == "https://bunnings.com.au"
    assert got["hours"] == [{"date": "2026-11-04", "opens": "06:00", "closes": "21:30"}]
    # The name is in the path, safely, and only one request went out.
    assert len(stub.calls) == 1
    assert "Bunnings%20%26%20Co" in stub.calls[0][0]


async def test_place_details_only_links_to_websites(provider):
    provider(Stub(payload={"results": [{"poi": {"name": "x", "url": "javascript:alert(1)"}}]}))
    got = await incidents.place_details(None, "x", -27.5, 153.0)
    assert not got["url"].lower().startswith("javascript:")


async def test_place_details_found_nothing(provider):
    provider(Stub(payload={"results": []}))
    assert await incidents.place_details(None, "x", -27.5, 153.0) == {"found": False}


async def test_place_details_without_a_key(provider):
    stub = provider(Stub(payload={}), key=None)
    assert await incidents.place_details(None, "x", -27.5, 153.0) is None
    assert stub.calls == []


async def test_the_layer_has_its_own_smaller_allowance(monkeypatch):
    assert get_settings().MAPS_TRAFFIC_LAYER_DAILY_LIMIT < get_settings().MAPS_TRAFFIC_DAILY_LIMIT
    spent: list[str] = []

    async def spend_layer() -> bool:
        spent.append("layer")
        return False

    async def spend() -> bool:
        spent.append("all")
        return True

    monkeypatch.setattr(traffic, "_spend_layer", spend_layer)
    monkeypatch.setattr(traffic, "_spend", spend)
    # A layer square that's over its share never touches the driving allowance.
    assert await traffic.fetch_tile("k", __import__("uuid").uuid4(), "relative", 10, 1, 1, layer=True) is None
    assert spent == ["layer"]


class _SetRedis:
    """Just enough of Redis's SET (with EX and NX) to follow the clock-less rule."""

    def __init__(self) -> None:
        self.keys: dict[str, str] = {}

    async def set(self, key: str, value: str, ex: int | None = None, nx: bool = False) -> bool | None:
        if nx and key in self.keys:
            return None
        self.keys[key] = value
        return True


async def test_wrong_turns_check_closures_once_every_few_minutes(monkeypatch):
    import app.redis_client as rc

    fake = _SetRedis()
    monkeypatch.setattr(rc, "redis", fake)
    me, other = "user-a", "user-b"
    # Starting a trip always checks.
    assert await incidents.closures_due(me, reroute=False) is True
    # A wrong turn straight after: no new check.
    assert await incidents.closures_due(me, reroute=True) is False
    assert await incidents.closures_due(me, reroute=True) is False
    # Someone else's trip is their own.
    assert await incidents.closures_due(other, reroute=True) is True
    # Five minutes on (the key has expired): the next wrong turn checks again.
    fake.keys.pop(f"maps:nav-closures:{me}")
    assert await incidents.closures_due(me, reroute=True) is True
    assert await incidents.closures_due(me, reroute=True) is False


async def test_without_redis_every_route_still_checks(monkeypatch):
    import app.redis_client as rc

    class Broken:
        async def set(self, *_: Any, **__: Any) -> None:
            raise ConnectionError("down")

    monkeypatch.setattr(rc, "redis", Broken())
    assert await incidents.closures_due("u", reroute=True) is True


async def test_a_reroute_between_checks_spends_nothing(monkeypatch):
    async def router(path: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"routes": [{"geometry": encode(ROAD)}]}

    fetch = AsyncMock(return_value=[incident()])
    monkeypatch.setattr(engine, "valhalla", router)
    monkeypatch.setattr(incidents, "fetch", fetch)
    answer = await planning.around_for_navigation(None, {"locations": STOPS, "costing": "auto"}, check_closures=False)
    assert answer["routes"][0]["geometry"] == encode(ROAD)
    fetch.assert_not_called()
