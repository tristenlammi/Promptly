"""Live traffic for P Maps, from TomTom's flow tiles: "traffic adds 6 min".

The route never leaves this server. It fetches the map squares a route passes
through, using the admin's key, and works the delay out here. TomTom sees this
server's address and which squares, not who's asking or where they're going.

Each tile is cached per person and only for as long as TomTom's response says,
as its terms require. A daily cap keeps a busy server inside the free allowance.
With no key, or when TomTom can't be reached, routes simply have no traffic.
"""
from __future__ import annotations

import asyncio
import email.utils
import logging
import math
import struct
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

from . import data

logger = logging.getLogger("promptly.maps.traffic")


class _HideKey(logging.Filter):
    """TomTom's key goes in the URL, and httpx logs every URL at INFO level. Those
    lines must never reach the logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "api.tomtom.com" not in record.getMessage()


logging.getLogger("httpx").addFilter(_HideKey())

FLOW_URL = "https://api.tomtom.com/traffic/map/4/tile/flow/{kind}/{z}/{x}/{y}.pbf"
INCIDENTS_URL = "https://api.tomtom.com/traffic/map/4/tile/incidents/{z}/{x}/{y}.pbf"
ROUTE_ZOOM = 10
MAX_TILES_PER_ROUTE = 60
CHUNK_METRES = 150.0
MATCH_METRES = 35.0
HEADING_DEGREES = 40.0
# Fractions of the road's usual free-flowing speed. City roads sit around 0.7 just
# from traffic lights, so only well below that counts as busy.
SLOW = 0.6
JAM = 0.35
ATTRIBUTION = "Traffic © TomTom"

_client: httpx.AsyncClient | None = None
_cache: OrderedDict[tuple, tuple[float, bytes]] = OrderedDict()
_CACHE_ENTRIES = 3000
_parsed: OrderedDict[tuple, "_Index"] = OrderedDict()
_PARSED_ENTRIES = 300


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=3.0), headers={"Accept-Encoding": "gzip"})
    return _client


async def traffic_key(db: AsyncSession) -> str | None:
    """The admin's key, or one set in the server's config."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.auth.utils import decrypt_secret

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is not None and row.maps_traffic_key_encrypted:
        try:
            return decrypt_secret(row.maps_traffic_key_encrypted)
        except Exception:  # noqa: BLE001 — an unreadable key is the same as none
            logger.warning("The stored traffic key couldn't be read")
    return (get_settings().MAPS_TRAFFIC_KEY or "").strip() or None


# ---- The daily cap ----------------------------------------------------------


def _day_key() -> str:
    return f"maps:traffic:{datetime.now(timezone.utc):%Y%m%d}"


async def _spend() -> bool:
    """Count a request. False once today's allowance is gone."""
    from app.redis_client import redis

    try:
        used = await redis.incr(_day_key())
        if used == 1:
            await redis.expire(_day_key(), 2 * 86400)
    except Exception:  # noqa: BLE001 — without a counter, the provider's own limit still applies
        return True
    return used <= get_settings().MAPS_TRAFFIC_DAILY_LIMIT


async def used_today() -> int:
    from app.redis_client import redis

    try:
        return int(await redis.get(_day_key()) or 0)
    except Exception:  # noqa: BLE001
        return 0


# ---- Fetching ---------------------------------------------------------------


def _expires_in(headers: httpx.Headers) -> float:
    """How long TomTom allows this response to be kept, in seconds. No header: not at all."""
    raw = headers.get("expires")
    if not raw:
        return 0.0
    try:
        return max(0.0, email.utils.parsedate_to_datetime(raw).timestamp() - time.time())
    except (TypeError, ValueError):
        return 0.0


async def _spend_layer() -> bool:
    """The traffic layer's share of today's allowance."""
    from app.redis_client import redis

    key = f"maps:traffic-layer:{datetime.now(timezone.utc):%Y%m%d}"
    try:
        used = await redis.incr(key)
        if used == 1:
            await redis.expire(key, 2 * 86400)
    except Exception:  # noqa: BLE001
        return True
    return used <= get_settings().MAPS_TRAFFIC_LAYER_DAILY_LIMIT


async def fetch_tile(key: str, user_id: uuid.UUID, kind: str, z: int, x: int, y: int, *, layer: bool = False) -> bytes | None:
    """One tile: flow ("relative", "absolute") or "incidents". Empty bytes: nothing
    there. None: couldn't get it. ``layer``: for the map layer, not a route."""
    slot = (user_id, kind, z, x, y)
    held = _cache.get(slot)
    if held and held[0] > time.time():
        _cache.move_to_end(slot)
        return held[1]
    if (layer and not await _spend_layer()) or not await _spend():
        logger.info("Today's traffic allowance is used up")
        return None
    try:
        if kind == "incidents":
            r = await _http().get(INCIDENTS_URL.format(z=z, x=x, y=y), params={"key": key, "tags": "[icon_category,description,delay,magnitude,end_date]"})
        else:
            r = await _http().get(FLOW_URL.format(kind=kind, z=z, x=x, y=y), params={"key": key})
    except httpx.HTTPError as e:
        logger.info("Traffic request failed: %s", type(e).__name__)
        return None
    if r.status_code == 204:
        return b""
    if r.status_code != 200:
        # Never log the URL: the key's in it.
        logger.warning("Traffic provider said %s", r.status_code)
        return None
    keep = _expires_in(r.headers)
    if keep > 0:
        _cache[slot] = (time.time() + keep, r.content)
        while len(_cache) > _CACHE_ENTRIES:
            _cache.popitem(last=False)
    return r.content


async def check_key(key: str) -> tuple[bool, str]:
    """Does this key work? One small tile, for the admin's Test button."""
    try:
        r = await _http().get(FLOW_URL.format(kind="relative", z=2, x=3, y=2), params={"key": key})
    except httpx.HTTPError:
        return False, "Couldn't reach TomTom from this server."
    if r.status_code in (200, 204):
        return True, "The key works."
    if r.status_code in (401, 403):
        return False, "TomTom refused that key."
    if r.status_code == 429:
        return False, "The key is valid, but it's over its limit right now."
    return False, f"TomTom answered {r.status_code}."


# ---- Reading a vector tile ---------------------------------------------------


def _varint(b: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        x = b[i]
        i += 1
        result |= (x & 127) << shift
        shift += 7
        if x < 128:
            return result, i


def _fields(b: bytes):  # noqa: ANN202
    i = 0
    while i < len(b):
        k, i = _varint(b, i)
        number, wire = k >> 3, k & 7
        if wire == 0:
            v, i = _varint(b, i)
        elif wire == 2:
            n, i = _varint(b, i)
            v = b[i : i + n]
            i += n
        elif wire == 1:
            v = b[i : i + 8]
            i += 8
        elif wire == 5:
            v = b[i : i + 4]
            i += 4
        else:
            raise ValueError("Unknown field type")
        yield number, v


def _packed(b: bytes) -> list[int]:
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i)
        out.append(v)
    return out


def _value(b: bytes) -> Any:
    for n, v in _fields(b):
        if n == 1:
            return v.decode("utf-8", "replace")
        if n == 2:
            return struct.unpack("<f", v)[0]
        if n == 3:
            return struct.unpack("<d", v)[0]
        if n in (4, 5):
            return v
        if n == 6:
            return (v >> 1) ^ -(v & 1)
        if n == 7:
            return bool(v)
    return None


@dataclass
class _Index:
    """A tile's road pieces, bucketed so a point only looks at those nearby."""

    cells: dict[tuple[int, int], list[tuple[float, float, float, float, float, bool, float]]] = field(default_factory=dict)


_GRID = 64


def parse_tile(content: bytes, z: int, x: int, y: int) -> _Index:
    """Road pieces as map-fraction coordinates, with traffic level and closure."""
    index = _Index()
    n = 2**z
    for number, layer in _fields(content):
        if number != 3:
            continue
        keys: list[str] = []
        values: list[Any] = []
        features: list[bytes] = []
        extent = 4096
        for m, v in _fields(layer):
            if m == 3:
                keys.append(v.decode())
            elif m == 4:
                values.append(_value(v))
            elif m == 2:
                features.append(v)
            elif m == 5:
                extent = v
        for feature in features:
            tags: dict[str, Any] = {}
            geometry: list[int] = []
            for m, v in _fields(feature):
                if m == 2:
                    t = _packed(v)
                    tags = {keys[t[i]]: values[t[i + 1]] for i in range(0, len(t) - 1, 2)}
                elif m == 4:
                    geometry = _packed(v)
            level = tags.get("traffic_level")
            if not isinstance(level, (int, float)):
                continue
            closed = bool(tags.get("road_closure"))
            i = cx = cy = 0
            prev: tuple[float, float] | None = None
            while i < len(geometry):
                command, count = geometry[i] & 7, geometry[i] >> 3
                i += 1
                if command == 7:
                    continue
                for _ in range(count):
                    dx, dy = geometry[i], geometry[i + 1]
                    i += 2
                    cx += (dx >> 1) ^ -(dx & 1)
                    cy += (dy >> 1) ^ -(dy & 1)
                    point = ((x + cx / extent) / n, (y + cy / extent) / n)
                    if command == 2 and prev is not None and point != prev:
                        heading = math.atan2(point[0] - prev[0], -(point[1] - prev[1]))
                        cell = (int((prev[0] + point[0]) / 2 * n * _GRID), int((prev[1] + point[1]) / 2 * n * _GRID))
                        index.cells.setdefault(cell, []).append((prev[0], prev[1], point[0], point[1], float(level), closed, heading))
                    prev = point
    return index


def _merc(lat: float, lon: float) -> tuple[float, float]:
    return (lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def _nearest(index: _Index, z: int, px: float, py: float, heading: float, metres_per_unit: float) -> tuple[float, bool] | None:
    """The traffic on the road under this point, running the same way."""
    n = 2**z
    cx, cy = int(px * n * _GRID), int(py * n * _GRID)
    best: tuple[float, float, bool] | None = None
    limit = math.radians(HEADING_DEGREES)
    for gx in (cx - 1, cx, cx + 1):
        for gy in (cy - 1, cy, cy + 1):
            for ax, ay, bx, by, level, closed, h in index.cells.get((gx, gy), ()):
                if abs((h - heading + math.pi) % (2 * math.pi) - math.pi) > limit:
                    continue
                vx, vy = bx - ax, by - ay
                t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
                d = math.hypot(px - (ax + t * vx), py - (ay + t * vy)) * metres_per_unit
                if d <= MATCH_METRES and (best is None or d < best[0]):
                    best = (d, level, closed)
    return (best[1], best[2]) if best else None


# ---- A route's traffic -------------------------------------------------------


@dataclass
class _Chunk:
    lat: float
    lon: float
    heading: float
    tile: tuple[int, int]
    metres: float
    seconds: float
    line: list[list[float]]


def _chunks(route: dict[str, Any]) -> list[_Chunk]:
    """The route in pieces of about 150 m, each with our own time for it."""
    out: list[_Chunk] = []
    n = 2**ROUTE_ZOOM
    for leg in route.get("legs") or []:
        if not leg.get("shape"):
            continue
        pts = data.decode_polyline(leg["shape"])
        # Seconds a metre, from the steps: each covers a run of the shape.
        steps = leg.get("steps") or []
        rate: list[float] = [0.0] * max(0, len(pts) - 1)
        for s, step in enumerate(steps):
            start = step.get("at") or 0
            end = (steps[s + 1].get("at") or 0) if s + 1 < len(steps) else len(pts) - 1
            metres = (step.get("km") or 0) * 1000
            value = (step.get("seconds") or 0) / metres if metres else 0.0
            for i in range(start, min(end, len(rate))):
                rate[i] = value
        if not any(rate) and leg.get("km"):
            rate = [(leg.get("seconds") or 0) / (leg["km"] * 1000)] * len(rate)
        i = 0
        while i < len(pts) - 1:
            start = i
            metres = seconds = 0.0
            while i < len(pts) - 1 and metres < CHUNK_METRES:
                d = data.distance_m(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
                metres += d
                seconds += d * rate[i]
                i += 1
            mid = start + max(0, (i - start - 1) // 2)
            a, b = pts[mid], pts[min(mid + 1, len(pts) - 1)]
            ax, ay = _merc(*a)
            bx, by = _merc(*b)
            if (ax, ay) == (bx, by):
                continue
            lat, lon = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            px, py = _merc(lat, lon)
            out.append(_Chunk(
                lat, lon, math.atan2(bx - ax, -(by - ay)), (int(px * n), int(py * n)), metres, seconds,
                [[round(p[1], 6), round(p[0], 6)] for p in pts[start : i + 1]],
            ))
    return out


async def _indexes(key: str, user_id: uuid.UUID, kind: str, tiles: list[tuple[int, int]]) -> dict[tuple[int, int], _Index]:
    z = ROUTE_ZOOM
    gate = asyncio.Semaphore(6)

    async def one(tile: tuple[int, int]) -> tuple[tuple[int, int], _Index | None]:
        async with gate:
            content = await fetch_tile(key, user_id, kind, z, tile[0], tile[1])
        if content is None:
            return tile, None
        slot = (hash(content), kind, tile)
        held = _parsed.get(slot)
        if held is None:
            held = await asyncio.to_thread(parse_tile, content, z, tile[0], tile[1])
            _parsed[slot] = held
            while len(_parsed) > _PARSED_ENTRIES:
                _parsed.popitem(last=False)
        return tile, held

    found = await asyncio.gather(*(one(t) for t in tiles))
    return {t: i for t, i in found if i is not None}


def _measure(chunks: list[_Chunk], speeds: dict, levels: dict) -> dict[str, Any]:
    now = free = matched = total = 0.0
    closures = 0
    jams: list[dict[str, Any]] = []
    for c in chunks:
        total += c.metres
        unit = 40075016.7 * math.cos(math.radians(c.lat))
        px, py = _merc(c.lat, c.lon)
        fast = speeds.get(c.tile)
        rel = levels.get(c.tile)
        speed = _nearest(fast, ROUTE_ZOOM, px, py, c.heading, unit) if fast else None
        level = _nearest(rel, ROUTE_ZOOM, px, py, c.heading, unit) if rel else None
        kmh = speed[0] if speed else 0.0
        fraction = level[0] if level else 0.0
        if kmh <= 0:
            now += c.seconds
            free += c.seconds
            continue
        matched += c.metres
        here = c.metres / (kmh / 3.6)
        now += here
        free += here * fraction if fraction > 0 else here
        if (speed and speed[1]) or (level and level[1]):
            closures += 1
        if 0 < fraction < SLOW:
            kind = "jam" if fraction < JAM else "slow"
            if jams and jams[-1]["kind"] == kind and jams[-1]["line"][-1] == c.line[0]:
                jams[-1]["line"] += c.line[1:]
            else:
                jams.append({"kind": kind, "line": list(c.line)})
    if not total or matched / total < 0.3:
        return {}
    return {
        "seconds": round(now),
        "free_seconds": round(free),
        "adds_seconds": max(0, round(now - free)),
        "covered": round(matched / total, 2),
        "closures": closures,
        "jams": jams,
    }


async def annotate(db: AsyncSession, user_id: uuid.UUID, routes: list[dict[str, Any]]) -> bool:
    """Add ``traffic`` to each route and put the fastest right now first.
    False (and no change) when traffic isn't available."""
    key = await traffic_key(db)
    if not key or not routes:
        return False
    try:
        pieces = await asyncio.to_thread(lambda: [_chunks(r) for r in routes])
        # In the order you'd drive them, so a very long trip gets the near part.
        seen: dict[tuple[int, int], None] = {}
        for chunks in pieces:
            for c in chunks:
                if len(seen) < MAX_TILES_PER_ROUTE:
                    seen.setdefault(c.tile)
        tiles = list(seen)
        speeds, levels = await asyncio.gather(_indexes(key, user_id, "absolute", tiles), _indexes(key, user_id, "relative", tiles))
        if not speeds:
            return False
        results = await asyncio.to_thread(lambda: [_measure(c, speeds, levels) for c in pieces])
    except Exception:  # noqa: BLE001 — traffic never costs you the route
        logger.exception("Couldn't work out traffic for a route")
        return False
    any_traffic = False
    for route, measured in zip(routes, results):
        if measured:
            route["traffic"] = measured
            any_traffic = True
    if any_traffic:
        routes.sort(key=lambda r: (r.get("traffic") or {}).get("seconds", r.get("seconds") or 0))
    return any_traffic


def travel_seconds(route: dict[str, Any]) -> float:
    """The best time we have for this route."""
    return (route.get("traffic") or {}).get("seconds") or route.get("seconds") or 0
