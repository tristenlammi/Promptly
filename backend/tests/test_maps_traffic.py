"""Live traffic: "traffic adds X min" from flow tiles, the key staying on the
server, per-person caching within TomTom's limits, and no key or no TomTom never
costing you the route. TomTom itself is stubbed."""
from __future__ import annotations

import email.utils
import math
import time
import uuid

import httpx
import pytest


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


# ---- a small vector tile writer
def _vi(v: int) -> bytes:
    out = bytearray()
    while v >= 128:
        out.append((v & 127) | 128)
        v >>= 7
    out.append(v)
    return bytes(out)


def _ld(field: int, b: bytes) -> bytes:
    return _vi(field << 3 | 2) + _vi(len(b)) + b


def _zig(v: int) -> int:
    return (v << 1) ^ (v >> 63)


def _tile(lines: list[tuple[list[tuple[int, int]], float]]) -> bytes:
    """One layer of lines, each with its traffic level (a double value)."""
    import struct

    layer = _ld(1, b"Traffic flow") + _ld(3, b"traffic_level")
    values = sorted({level for _, level in lines})
    for v in values:
        layer += _ld(4, _vi(3 << 3 | 1) + struct.pack("<d", v))
    for points, level in lines:
        cx = cy = 0
        geom = [1 << 3 | 1, _zig(points[0][0]), _zig(points[0][1])]
        cx, cy = points[0]
        geom.append((len(points) - 1) << 3 | 2)
        for x, y in points[1:]:
            geom += [_zig(x - cx), _zig(y - cy)]
            cx, cy = x, y
        tags = b"".join(_vi(v) for v in (0, values.index(level)))
        feature = _ld(2, tags) + _vi(3 << 3) + _vi(2) + _ld(4, b"".join(_vi(v) for v in geom))
        layer += _ld(2, feature)
    layer += _vi(5 << 3) + _vi(4096)
    return _ld(3, layer)


def _merc(lat, lon):
    return (lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


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


# A straight 3 km road, heading east inside one tile.
A = (-27.50, 153.00)
B = (-27.50, 153.03)
Z = 10


def _road_tile(level: float) -> tuple[int, int, bytes]:
    n = 2**Z
    ax, ay = _merc(*A)
    bx, by = _merc(*B)
    x, y = int(ax * n), int(ay * n)
    assert int(bx * n) == x
    pts = [(round((ax * n - x) * 4096), round((ay * n - y) * 4096)), (round((bx * n - x) * 4096), round((by * n - y) * 4096))]
    return x, y, _tile([(pts, level)])


class Provider:
    """Stands in for TomTom: 60 km/h now on a road that's normally 120 km/h."""

    def __init__(self, status=200, expires_in=120, error=False):
        self.calls: list[str] = []
        self.status, self.expires_in, self.error = status, expires_in, error

    async def get(self, url, params=None):
        self.calls.append(url)
        if self.error:
            raise httpx.ConnectError("down")
        level = 60.0 if "/absolute/" in url else 0.5
        headers = {}
        if self.expires_in:
            headers["Expires"] = email.utils.formatdate(time.time() + self.expires_in, usegmt=True)
        return httpx.Response(self.status, content=_road_tile(level)[2], headers=headers)


@pytest.fixture
def provider(monkeypatch):
    from app.maps import traffic

    p = Provider()
    monkeypatch.setattr(traffic, "_http", lambda: p)
    traffic._cache.clear()
    traffic._parsed.clear()
    return p


@pytest.fixture
def key(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "test-traffic-key")


def _route(seconds=108.0):
    km = 2.96
    return {"km": km, "seconds": seconds, "legs": [{"shape": _encode([A, B]), "km": km, "seconds": seconds, "steps": []}]}


async def test_a_busy_road_says_how_much_traffic_adds(db, user, key, provider):
    from app.maps.traffic import annotate

    route = _route()
    assert await annotate(db, user.id, [route])
    t = route["traffic"]
    # 2.96 km at 60 km/h is about 178 s; at its usual 120 km/h, about 89 s.
    assert abs(t["seconds"] - 178) < 6 and abs(t["free_seconds"] - 89) < 6
    assert abs(t["adds_seconds"] - 89) < 6
    assert t["covered"] > 0.9 and t["jams"][0]["kind"] == "slow"


async def test_the_fastest_route_right_now_comes_first(db, user, key, provider):
    from app.maps.traffic import annotate

    # On paper the first is quicker; off the known road, the second keeps its own time.
    busy = _route(seconds=100)
    elsewhere = {"km": 3.0, "seconds": 130, "legs": [{"shape": _encode([(-27.9, 153.2), (-27.9, 153.23)]), "km": 3.0, "seconds": 130, "steps": []}]}
    routes = [busy, elsewhere]
    assert await annotate(db, user.id, routes)
    assert routes[0] is elsewhere and "traffic" not in elsewhere and routes[1]["traffic"]["seconds"] > 130


async def test_no_key_or_no_tomtom_still_gives_the_route(db, user, monkeypatch):
    from app.config import get_settings
    from app.maps import traffic

    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "")
    route = _route()
    assert not await traffic.annotate(db, user.id, [route]) and "traffic" not in route

    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "k")
    traffic._cache.clear()
    for broken in (Provider(error=True), Provider(status=403), Provider(status=429)):
        monkeypatch.setattr(traffic, "_http", lambda b=broken: b)
        assert not await traffic.annotate(db, user.id, [route]) and "traffic" not in route


async def test_tiles_are_kept_per_person_and_only_as_long_as_allowed(db, user, key, provider, monkeypatch):
    from app.maps import traffic

    await traffic.annotate(db, user.id, [_route()])
    first = len(provider.calls)
    assert first == 2  # the two kinds of one tile
    await traffic.annotate(db, user.id, [_route()])
    assert len(provider.calls) == first
    # Someone else doesn't share them: TomTom's terms don't allow a shared cache.
    await traffic.annotate(db, uuid.uuid4(), [_route()])
    assert len(provider.calls) == first * 2
    # A response with no expiry isn't kept at all.
    plain = Provider(expires_in=0)
    monkeypatch.setattr(traffic, "_http", lambda: plain)
    traffic._cache.clear()
    who = uuid.uuid4()
    await traffic.annotate(db, who, [_route()])
    await traffic.annotate(db, who, [_route()])
    assert len(plain.calls) == 4


async def test_the_daily_cap_stops_requests(db, user, key, provider, monkeypatch):
    from app.config import get_settings
    from app.maps import traffic

    async def spent():
        return False

    monkeypatch.setattr(traffic, "_spend", spent)
    route = _route()
    assert not await traffic.annotate(db, user.id, [route])
    assert provider.calls == []
    assert get_settings().MAPS_TRAFFIC_DAILY_LIMIT * 30 <= 200_000


async def test_the_route_api_carries_traffic_and_the_tile_proxy_hides_the_key(db, user, client, key, provider, monkeypatch):
    from app.maps import engine

    async def valhalla(path, body):
        return {"trip": {"summary": {"length": 2.96, "time": 108}, "legs": [{"shape": _encode([A, B]), "summary": {"length": 2.96, "time": 108}, "maneuvers": []}]}}

    monkeypatch.setattr(engine, "valhalla", valhalla)
    r = await client.post("/api/maps/route", headers=_hdr(user), json={"stops": [{"lat": A[0], "lon": A[1]}, {"lat": B[0], "lon": B[1]}]})
    got = r.json()
    assert got["traffic"] is True and got["routes"][0]["traffic"]["adds_seconds"] > 0

    assert (await client.get("/api/maps/config", headers=_hdr(user))).json()["traffic"] is True

    x, y, _ = _road_tile(0.6)
    tile = await client.get(f"/api/maps/traffic/tile/{Z}/{x}/{y}.pbf", headers=_hdr(user))
    assert tile.status_code == 200 and tile.content
    assert "test-traffic-key" not in str(tile.headers) and b"test-traffic-key" not in tile.content
    assert (await client.get(f"/api/maps/traffic/tile/{Z}/{x}/{y}.pbf")).status_code == 401
    # Nothing out of range is passed on.
    before = len(provider.calls)
    assert (await client.get("/api/maps/traffic/tile/3/1/1.pbf", headers=_hdr(user))).status_code == 204
    assert (await client.get(f"/api/maps/traffic/tile/{Z}/99999/1.pbf", headers=_hdr(user))).status_code == 204
    assert len(provider.calls) == before

    live = await client.post("/api/maps/traffic/route", headers=_hdr(user), json={"shapes": [_encode([A, B])], "seconds": 108, "km": 2.96})
    assert live.json()["traffic"]["adds_seconds"] > 0


async def test_admins_set_the_key_and_it_is_never_shown(db, user, client, monkeypatch):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.auth.models import User
    from app.config import get_settings
    from app.maps import traffic

    monkeypatch.setattr(get_settings(), "MAPS_TRAFFIC_KEY", "")
    admin = User(email=f"a-{uuid.uuid4().hex[:8]}@example.com", username=f"a{uuid.uuid4().hex[:6]}", password_hash="x", role="admin", settings={})
    db.add(admin)
    if await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) is None:
        db.add(AppSettings(id=SINGLETON_APP_SETTINGS_ID))
    await db.commit()
    url = "/api/admin/app-settings"
    plain = user if user.role != "admin" else None
    if plain is not None:
        assert (await client.patch(url, headers=_hdr(plain), json={"maps_traffic_key": "nope"})).status_code == 403
        assert (await client.post("/api/maps/traffic/test", headers=_hdr(plain))).status_code == 403

    r = await client.patch(url, headers=_hdr(admin), json={"maps_traffic_key": " my-secret-key "})
    assert r.status_code == 200, r.text
    assert r.json()["maps_traffic_key_set"] is True and "my-secret-key" not in r.text
    assert await traffic.traffic_key(db) == "my-secret-key"
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID, populate_existing=True)
    assert "my-secret-key" not in (row.maps_traffic_key_encrypted or "")

    # Saving something else leaves it alone; an empty value clears it.
    await client.patch(url, headers=_hdr(admin), json={"mfa_required": False})
    assert await traffic.traffic_key(db) == "my-secret-key"
    r = await client.patch(url, headers=_hdr(admin), json={"maps_traffic_key": ""})
    assert r.json()["maps_traffic_key_set"] is False
    db.expire_all()
    assert await traffic.traffic_key(db) is None


def test_the_key_is_not_written_to_logs_on_failure(caplog, monkeypatch):
    import asyncio

    from app.maps import traffic

    async def go():
        monkeypatch.setattr(traffic, "_http", lambda: Provider(status=403))

        async def ok():
            return True

        monkeypatch.setattr(traffic, "_spend", ok)
        return await traffic.fetch_tile("secret-key", uuid.uuid4(), "relative", 10, 1, 1)

    assert asyncio.run(go()) is None
    assert "secret-key" not in caplog.text


def test_the_http_library_cannot_log_the_key(caplog):
    """httpx logs each URL at INFO, and the key's in TomTom's URL."""
    import logging

    from app.maps import traffic  # noqa: F401 — installs the filter

    log = logging.getLogger("httpx")
    with caplog.at_level(logging.INFO, logger="httpx"):
        log.info('HTTP Request: %s %s "%s %d %s"', "GET", "https://api.tomtom.com/traffic/x.pbf?key=secret-key", "HTTP/1.1", 200, "OK")
        log.info('HTTP Request: %s %s "%s %d %s"', "POST", "http://maps:8002/route", "HTTP/1.1", 200, "OK")
    assert "secret-key" not in caplog.text and "maps:8002" in caplog.text
