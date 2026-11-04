"""Today's "Getting there" card: when to leave for your next event, and where
the car is. The route starts from your latest timeline position, or Home."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import engine, traffic
from .models import MapParked, MapPlace, MapTrackPoint

logger = logging.getLogger("promptly.maps")

BUFFER_MINUTES = 5
SOON_MINUTES = 30
CACHE_SECONDS = 300


async def origin(db: AsyncSession, user: User, now: datetime) -> dict[str, Any] | None:
    """Where this person probably is now."""
    recent = (
        await db.execute(
            select(MapTrackPoint.lat, MapTrackPoint.lon)
            .where(MapTrackPoint.user_id == user.id, MapTrackPoint.at >= now - timedelta(hours=2))
            .order_by(MapTrackPoint.at.desc())
            .limit(1)
        )
    ).first()
    if recent:
        return {"lat": recent[0], "lon": recent[1], "name": "Your location"}
    home = (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id, MapPlace.kind == "home"))).scalars().first()
    return {"lat": home.lat, "lon": home.lon, "name": "Home"} if home else None


async def _trip(db: AsyncSession, user: User, origin: dict[str, float], location: str, warnings: bool) -> dict[str, Any] | None:
    """Minutes and km to this place, or None if the map can't place it."""
    hits = await engine.photon("/api", {"q": location, "limit": 1, "lat": origin["lat"], "lon": origin["lon"]})
    if not hits:
        return None
    to = engine.label(hits[0])
    from .incidents import spoken
    from .planning import plan

    route = (await plan(db, user, [origin, to], "drive", pins=False, warnings=warnings))["routes"][0]
    return {
        "minutes": max(1, round(traffic.travel_seconds(route) / 60)), "km": round(route["km"], 1), "lat": to["lat"], "lon": to["lon"], "name": to["name"],
        "traffic": bool(route.get("traffic")), "adds": round((route.get("traffic") or {}).get("adds_seconds", 0) / 60),
        "warning": spoken(route["incidents"][0]) if route.get("incidents") else None,
    }


async def _cached_trip(db: AsyncSession, user: User, origin: dict[str, float], location: str, warnings: bool) -> dict[str, Any] | None:
    """Today reloads every minute; the route needn't."""
    from app.redis_client import redis

    key = f"maps:leave:{user.id}:{round(origin['lat'], 2)},{round(origin['lon'], 2)}:{location[:120]}"
    try:
        held = await redis.get(key)
        if held:
            return json.loads(held) or None
    except Exception:  # noqa: BLE001 — without the cache it's just slower
        held = None
    trip = await _trip(db, user, origin, location, warnings)
    try:
        await redis.set(key, json.dumps(trip or {}), ex=CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return trip


async def maps_section(db: AsyncSession, user: User, sec: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    from fastapi import HTTPException

    out: dict[str, Any] = {"next": None, "parked": None}
    parked = await db.get(MapParked, user.id)
    if parked is not None:
        out["parked"] = {"at": parked.at.isoformat(), "url": f"/maps?to={parked.lat:.5f},{parked.lon:.5f},Your%20car"}

    events = (sec.get("events") or {}).get("events") or []
    upcoming = []
    for e in events:
        if not e.get("location") or e.get("all_day"):
            continue
        try:
            start = datetime.fromisoformat(str(e["start"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if start > now:
            upcoming.append((start, e))
    if upcoming:
        start, event = min(upcoming, key=lambda x: x[0])
        start_at = await origin(db, user, now)
        trip = None
        if start_at:
            try:
                # Incident checks are scarce: only once it's nearly time to go.
                trip = await _cached_trip(db, user, start_at, event["location"], start - now <= timedelta(hours=2))
            except HTTPException:
                trip = None  # the map isn't running: no card line, no fuss
        if trip:
            leave = start - timedelta(minutes=trip["minutes"] + BUFFER_MINUTES)
            local = leave.astimezone(now.tzinfo)
            label = local.strftime("%I:%M %p").lstrip("0").lower()
            out["next"] = {
                "title": event["title"],
                "place": event["location"],
                "minutes": trip["minutes"],
                "km": trip["km"],
                "traffic": trip.get("traffic", False),
                "adds": trip.get("adds", 0),
                "warning": trip.get("warning"),
                "leave_by": leave.isoformat(),
                "leave_by_label": label,
                "soon": leave - now <= timedelta(minutes=SOON_MINUTES),
                "url": f"/maps?to={trip['lat']:.5f},{trip['lon']:.5f},{quote(event['title'])}",
            }
    return out if out["next"] or out["parked"] else None
