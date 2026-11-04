"""Fuel, food and the rest: near you, or along the way.

All of it comes from the map on this server, so nobody outside learns what you
looked for or where you were. Finding something along a route also works out
how much time it really adds, which is what decides whether a stop is worth it.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from fastapi import HTTPException

from . import data, engine

CATEGORIES: dict[str, dict[str, Any]] = {
    "fuel": {"label": "Fuel", "tags": ["amenity:fuel"], "words": {"fuel", "petrol", "petrol station", "gas", "gas station", "servo", "service station", "diesel"}},
    "food": {"label": "Food", "tags": ["amenity:restaurant", "amenity:fast_food"], "words": {"food", "restaurant", "restaurants", "fast food", "takeaway", "something to eat", "lunch", "dinner"}},
    "coffee": {"label": "Coffee", "tags": ["amenity:cafe"], "words": {"coffee", "cafe", "cafes", "café"}},
    "groceries": {"label": "Groceries", "tags": ["shop:supermarket", "shop:convenience"], "words": {"groceries", "grocery", "supermarket", "supermarkets", "convenience store"}},
    "chemist": {"label": "Chemist", "tags": ["amenity:pharmacy"], "words": {"chemist", "pharmacy", "chemists"}},
    "toilets": {"label": "Toilets", "tags": ["amenity:toilets"], "words": {"toilet", "toilets", "bathroom", "restroom", "public toilets"}},
    "parking": {"label": "Parking", "tags": ["amenity:parking"], "words": {"parking", "car park", "carpark"}},
    "atm": {"label": "ATM", "tags": ["amenity:atm"], "words": {"atm", "cash machine"}},
    "hotel": {"label": "Places to stay", "tags": ["tourism:hotel", "tourism:motel"], "words": {"hotel", "hotels", "motel", "motels", "accommodation", "somewhere to stay"}},
}
NEAR_RADIUS_KM = 8.0
# How far ahead to look on a route, and how many spots to ask about.
AHEAD_M = 60_000.0
MAX_SAMPLES = 10
# Only the closest few get a real detour worked out; each is a route request.
MAX_DETOURS = 5


def category_for(query: str) -> str | None:
    """"fuel near me", "the nearest servo", "coffee": a category, not a place name."""
    q = re.sub(r"[^\w\s]", " ", query.lower())
    q = re.sub(r"\b(near me|nearby|near here|around here|closest|nearest|find|a|an|the|me|some)\b", " ", q)
    q = " ".join(q.split())
    for key, c in CATEGORIES.items():
        if q in c["words"]:
            return key
    return None


async def _ask(category: str, lat: float, lon: float, radius_km: float, limit: int) -> list[dict[str, Any]]:
    tags = CATEGORIES[category]["tags"]
    found = await engine.photon("/reverse", {"lat": lat, "lon": lon, "radius": radius_km, "limit": limit, "osm_tag": tags})
    rows = []
    label = CATEGORIES[category]["label"]
    for f in found:
        row = engine.label(f)
        # An unnamed car park or toilet block is still what you asked for, on that road.
        if not (f.get("properties") or {}).get("name"):
            row["address"] = ", ".join(x for x in (row["name"], row["address"]) if x and x != "Dropped pin") or None
            row["name"] = label
        rows.append(row)
    return [r for r in rows if r["lat"] is not None]


async def around(category: str, lat: float, lon: float, limit: int = 12) -> list[dict[str, Any]]:
    """Closest first."""
    rows = await _ask(category, lat, lon, NEAR_RADIUS_KM, min(50, limit * 3))
    for row in rows:
        row["distance_m"] = round(data.distance_m(lat, lon, row["lat"], row["lon"]))
    rows.sort(key=lambda r: r["distance_m"])
    return _distinct(rows)[:limit]


def _distinct(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[float, float]] = set()
    out = []
    for row in rows:
        key = (round(row["lat"], 3), round(row["lon"], 3))
        if key not in seen:
            seen.add(key)
            out.append(row)
    return out


def _spots(line: list[tuple[float, float]], gap_m: float) -> list[tuple[float, float]]:
    spots = [line[0]]
    along = since = 0.0
    for a, b in zip(line, line[1:]):
        d = data.distance_m(a[0], a[1], b[0], b[1])
        along += d
        since += d
        if along > AHEAD_M:
            break
        if since >= gap_m:
            spots.append(b)
            since = 0.0
    if len(spots) > MAX_SAMPLES:
        step = len(spots) / MAX_SAMPLES
        spots = [spots[int(i * step)] for i in range(MAX_SAMPLES)]
    return spots


async def along(category: str, line: list[tuple[float, float]], within_m: float = 1000.0, limit: int = 8) -> list[dict[str, Any]]:
    """What's near the road ahead, in the order you'd reach it."""
    if len(line) < 2:
        return []
    radius_km = max(0.5, within_m * 2 / 1000)
    groups = await asyncio.gather(
        *(_ask(category, lat, lon, radius_km, 20) for lat, lon in _spots(line, radius_km * 1500)),
        return_exceptions=True,
    )
    rows: list[dict[str, Any]] = []
    for group in groups:
        if isinstance(group, HTTPException):
            raise group
        if not isinstance(group, BaseException):
            rows += group
    return _distinct(data.near_line(rows, line, within_m))[:limit * 3]


async def with_detours(rows: list[dict[str, Any]], here: dict[str, Any], to: dict[str, Any], mode: str = "drive", limit: int = 8) -> list[dict[str, Any]]:
    """How long each adds to the trip, quickest to get to first. Closest to the
    road are worked out; the rest aren't offered."""
    options = {"tolls": False, "highways": False, "ferries": False, "alternates": 0}

    async def seconds(stops: list[dict[str, Any]]) -> float | None:
        try:
            return engine.routes_out(await engine.valhalla("/route", engine.route_body(stops, mode, **options)))[0]["seconds"]
        except HTTPException:
            return None

    closest = sorted(rows, key=lambda r: r.get("off_m", 0))[:MAX_DETOURS]
    base, *times = await asyncio.gather(
        seconds([here, to]),
        *(seconds([here, {"lat": r["lat"], "lon": r["lon"], "name": r["name"]}, to]) for r in closest),
    )
    out = []
    for row, t in zip(closest, times):
        if t is not None and base is not None:
            out.append({**row, "adds_seconds": max(0, round(t - base))})
    out.sort(key=lambda r: (r["adds_seconds"], r.get("along_m", 0)))
    return out[:limit]
