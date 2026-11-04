"""Crashes, closures and hazards on your route, from TomTom's Incident Details.

Your route stays on this server: it asks for the map area around the route and
picks out what's on your road, in your direction. These answers carry no expiry,
so TomTom's terms don't allow keeping them: each check is a fresh request, under
a daily cap that keeps a month inside the free allowance. No key, or the cap
reached, just means no warnings.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

from . import data, traffic

logger = logging.getLogger("promptly.maps.incidents")

DETAILS_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
PLACES_URL = "https://api.tomtom.com/search/2/poiSearch/{query}.json"
FIELDS = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,length,delay}}}"
MAX_BOX_KM2 = 9000.0
MAX_BOXES = 3
ON_ROUTE_M = 40.0
SAME_WAY_DEGREES = 60.0
STEP_M = 50.0
KINDS = {
    0: "Incident", 1: "Crash", 2: "Fog", 3: "Dangerous conditions", 4: "Heavy rain", 5: "Ice", 6: "Traffic queue",
    7: "Lane closed", 8: "Road closed", 9: "Roadworks", 10: "Strong wind", 11: "Flooding", 14: "Broken-down vehicle",
}
MAX_RINGS = 20
CLOSED = 8
JAM = 6


async def _spend(name: str, limit: int) -> bool:
    from app.redis_client import redis

    key = f"maps:{name}:{datetime.now(timezone.utc):%Y%m%d}"
    try:
        used = await redis.incr(key)
        if used == 1:
            await redis.expire(key, 2 * 86400)
    except Exception:  # noqa: BLE001 — without a counter, the provider's own limit still applies
        return True
    return used <= limit


def boxes_for(lines: list[list[tuple[float, float]]]) -> list[tuple[float, float, float, float]]:
    """Map areas covering these routes, in driving order, each under TomTom's
    10,000 km² limit. A very long trip gets its first few hundred km."""
    out: list[tuple[float, float, float, float]] = []
    pad = 0.01
    for line in lines:
        south = north = west = east = None
        for lat, lon in line:
            s, n = (lat if south is None else min(south, lat)), (lat if north is None else max(north, lat))
            w, e = (lon if west is None else min(west, lon)), (lon if east is None else max(east, lon))
            area = (n - s + 2 * pad) * 111.0 * (e - w + 2 * pad) * 111.0 * math.cos(math.radians((s + n) / 2))
            if area > MAX_BOX_KM2 and south is not None:
                out.append((west - pad, south - pad, east + pad, north + pad))
                south, north, west, east = lat, lat, lon, lon
            else:
                south, north, west, east = s, n, w, e
        if south is not None:
            out.append((west - pad, south - pad, east + pad, north + pad))
    # Alternatives usually share an area: one box that holds them all is one request.
    if len(out) > 1:
        whole = (min(b[0] for b in out), min(b[1] for b in out), max(b[2] for b in out), max(b[3] for b in out))
        if (whole[3] - whole[1]) * 111.0 * (whole[2] - whole[0]) * 111.0 * math.cos(math.radians((whole[1] + whole[3]) / 2)) <= MAX_BOX_KM2:
            return [whole]
    return out[:MAX_BOXES]


async def fetch(db: AsyncSession, lines: list[list[tuple[float, float]]]) -> list[dict[str, Any]]:
    """Incidents in the area of these routes. Empty if there's no key or no allowance."""
    key = await traffic.traffic_key(db)
    if not key or not any(lines):
        return []
    out: dict[str, dict[str, Any]] = {}
    for box in boxes_for([line for line in lines if line]):
        if not await _spend("incidents", get_settings().MAPS_INCIDENTS_DAILY_LIMIT):
            logger.info("Today's incident allowance is used up")
            break
        try:
            r = await traffic._http().get(
                DETAILS_URL, params={"key": key, "bbox": ",".join(f"{v:.5f}" for v in box), "fields": FIELDS, "language": "en-GB"}
            )
        except httpx.HTTPError as e:
            logger.info("Incident request failed: %s", type(e).__name__)
            continue
        if r.status_code != 200:
            logger.warning("Incident provider said %s", r.status_code)
            continue
        try:
            rows = r.json().get("incidents") or []
        except ValueError:
            continue
        for row in rows:
            ident = (row.get("properties") or {}).get("id")
            if ident:
                out[str(ident)] = row
    return list(out.values())


def _heading(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) % 360


class _Road:
    """A route as evenly spaced points, findable by position."""

    def __init__(self, line: list[tuple[float, float]]) -> None:
        self.points: list[tuple[float, float, float, float]] = []  # lat, lon, metres along, heading
        self.cells: dict[tuple[int, int], list[int]] = {}
        along = 0.0
        for a, b in zip(line, line[1:]):
            d = data.distance_m(a[0], a[1], b[0], b[1])
            if not d:
                continue
            h = _heading(a, b)
            steps = max(1, int(d // STEP_M))
            for i in range(steps):
                f = i / steps
                self._add(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, along + d * f, h)
            along += d
        if line:
            self._add(line[-1][0], line[-1][1], along, self.points[-1][3] if self.points else 0.0)

    def _add(self, lat: float, lon: float, along: float, heading: float) -> None:
        self.cells.setdefault((int(lat * 1000), int(lon * 1000)), []).append(len(self.points))
        self.points.append((lat, lon, along, heading))

    def near(self, lat: float, lon: float) -> tuple[float, float, float] | None:
        """(metres away, metres along, heading) of the closest part of the road."""
        cx, cy = int(lat * 1000), int(lon * 1000)
        best = None
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for i in self.cells.get((gx, gy), ()):
                    p = self.points[i]
                    d = data.distance_m(lat, lon, p[0], p[1])
                    if best is None or d < best[0]:
                        best = (d, p[2], p[3])
        return best


def on_route(rows: list[dict[str, Any]], line: list[tuple[float, float]]) -> list[dict[str, Any]]:
    """Which of these are on this road and going this way, in the order you'd reach them."""
    if len(line) < 2 or not rows:
        return []
    road = _Road(line)
    found: list[dict[str, Any]] = []
    for row in rows:
        p = row.get("properties") or {}
        coords = (row.get("geometry") or {}).get("coordinates") or []
        if (row.get("geometry") or {}).get("type") == "Point":
            coords = [coords]
        pts = [(c[1], c[0]) for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2]
        if not pts:
            continue
        # Short ones have few points; long ones only need sampling.
        step = max(1, len(pts) // 12)
        samples = pts[::step]
        hits: list[tuple[float, tuple[float, float]]] = []
        for i, pt in enumerate(samples):
            near = road.near(pt[0], pt[1])
            if near is None or near[0] > ON_ROUTE_M:
                continue
            if len(pts) >= 2:
                a = pts[min(i * step, len(pts) - 2)]
                b = pts[min(i * step + 1, len(pts) - 1)]
                if a != b and abs((_heading(a, b) - near[2] + 180) % 360 - 180) > SAME_WAY_DEGREES:
                    continue
            hits.append((near[1], pt))
        # Crossing a road isn't being on it: most of a longer one must be on the way.
        if not hits or len(hits) < max(1, len(samples) // 2):
            continue
        category = p.get("iconCategory") if p.get("iconCategory") in KINDS else 0
        delay = p.get("delay") or 0
        # A queue of under a minute is already counted in the traffic time.
        if category == JAM and delay < 60:
            continue
        hits.sort(key=lambda h: h[0])
        first = hits[0]
        events = [e.get("description") for e in p.get("events") or [] if e.get("description")]
        found.append({
            "id": str(p.get("id")),
            "category": category,
            "label": KINDS[category],
            "text": ", ".join(events[:2]) or KINDS[category],
            "from": p.get("from"),
            "to": p.get("to"),
            "delay_seconds": round(delay),
            "ends": p.get("endTime"),
            "closed": category == CLOSED,
            "lat": first[1][0],
            "lon": first[1][1],
            "along_km": round(first[0] / 1000, 1),
            "points": [[round(h[1][0], 6), round(h[1][1], 6)] for h in hits],
        })
    found.sort(key=lambda i: i["along_km"])
    return found


def exclusions(closed: list[dict[str, Any]]) -> list[list[list[float]]]:
    """Small boxes along each closed road, for the router to keep out of. A long
    closure covers several streets, so one box isn't enough. Valhalla allows 100
    corners in all, so 20 boxes shared out."""
    d = 0.00015
    seen: dict[str, dict[str, Any]] = {c["id"]: c for c in closed}
    each = max(1, MAX_RINGS // max(1, len(seen)))
    rings = []
    for c in list(seen.values())[:MAX_RINGS]:
        points = c.get("points") or [[c["lat"], c["lon"]]]
        step = max(1, math.ceil(len(points) / each))
        for lat, lon in points[::step]:
            rings.append([[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]])
    return rings[:MAX_RINGS]


def spoken(incident: dict[str, Any]) -> str:
    """One line, as a person would say it."""
    label = incident["label"]
    where = f" on {incident['from']}" if incident.get("from") else ""
    adds = f", adds about {round(incident['delay_seconds'] / 60)} min" if incident.get("delay_seconds", 0) >= 60 else ""
    return f"{label}{where}, {incident['along_km']:g} km ahead{adds}"


async def place_details(db: AsyncSession, name: str, lat: float, lon: float) -> dict[str, Any] | None:
    """Hours, phone and website for a place you asked about. Sends TomTom its name
    and position, and only when you press the button. Not kept."""
    from urllib.parse import quote

    key = await traffic.traffic_key(db)
    if not key or not await _spend("places", get_settings().MAPS_PLACES_DAILY_LIMIT):
        return None
    try:
        r = await traffic._http().get(
            PLACES_URL.format(query=quote(name[:120], safe="")),
            params={"key": key, "lat": lat, "lon": lon, "radius": 300, "limit": 1, "openingHours": "nextSevenDays"},
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        logger.warning("Place provider said %s", r.status_code)
        return None
    results = r.json().get("results") or []
    if not results:
        return {"found": False}
    poi = results[0].get("poi") or {}
    url = (poi.get("url") or "").strip()
    if url and not url.lower().startswith(("http://", "https://")):
        url = f"https://{url}"
    hours = []
    for span in (poi.get("openingHours") or {}).get("timeRanges") or []:
        a, b = span.get("startTime") or {}, span.get("endTime") or {}
        if a.get("date") is not None:
            hours.append({"date": a["date"], "opens": f"{a.get('hour', 0):02d}:{a.get('minute', 0):02d}", "closes": f"{b.get('hour', 0):02d}:{b.get('minute', 0):02d}"})
    return {
        "found": True,
        "name": poi.get("name"),
        "phone": poi.get("phone"),
        "url": url or None,
        "categories": (poi.get("categories") or [])[:3],
        "hours": hours,
    }
