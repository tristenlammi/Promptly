"""Working out which way to go: the routes on offer, live traffic, and the way you
prefer between two places. Everything that asks for a route comes through here,
so the map, chat, Today and the car all agree.

A preferred route is kept as points it passes through. Asked to go between the
same two places, that way comes first even when another is a little quicker, and
the others say how much they'd save."""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import data, engine, incidents, traffic
from .models import MapPreferredRoute

logger = logging.getLogger("promptly.maps")

SAME_PLACE_M = 500.0
ON_THE_WAY_M = 800.0
MAX_THROUGH = 12
CLOSE_ENOUGH = 0.01
# A different way has to save this much before we suggest changing mid-trip.
FASTER_MINUTES = 5.0
FASTER_FRACTION = 0.1


def _line(route: dict[str, Any]) -> list[tuple[float, float]]:
    line: list[tuple[float, float]] = []
    for leg in route.get("legs") or []:
        if leg.get("shape"):
            line += data.decode_polyline(leg["shape"])
    return line


def _heading(a: tuple[float, float], b: tuple[float, float]) -> int:
    import math

    x = (b[1] - a[1]) * math.cos(math.radians(a[0]))
    return round(math.degrees(math.atan2(x, b[0] - a[0]))) % 360


def through_points(route: dict[str, Any]) -> list[dict[str, Any]]:
    """A few points along a route that bring a new request back onto it, each
    with its direction of travel so it lands on the right side of the road."""
    line = _line(route)
    if len(line) < 3:
        return []
    along = [0.0]
    for a, b in zip(line, line[1:]):
        along.append(along[-1] + data.distance_m(a[0], a[1], b[0], b[1]))
    total = along[-1]
    if total < 1000:
        return []
    gap = max(1500.0, total / MAX_THROUGH)
    # Turns are poor places to pin: it's unclear which road they're on.
    turns: set[int] = set()
    offset = 0
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            turns.add(offset + (step.get("at") or 0))
        if leg.get("shape"):
            offset += len(data.decode_polyline(leg["shape"]))
    out: list[dict[str, Any]] = []
    next_at = gap
    for i in range(len(line) - 1):
        if along[i] < next_at or along[i] > total - 300 or along[i] < 300:
            continue
        if any(abs(i - t) < 2 for t in turns):
            continue
        if data.distance_m(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]) < 5:
            continue
        out.append({"lat": round(line[i][0], 6), "lon": round(line[i][1], 6), "heading": _heading(line[i], line[i + 1])})
        next_at = along[i] + gap
        if len(out) >= MAX_THROUGH:
            break
    return out


def _via_name(route: dict[str, Any]) -> str | None:
    """The road most of this route is on, to tell routes apart."""
    totals: dict[str, float] = {}
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            if step.get("street"):
                totals[step["street"]] = totals.get(step["street"], 0.0) + (step.get("km") or 0)
    return max(totals, key=lambda k: totals[k]) if totals else None


def different(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Do these go different ways? True when over 15% of one is away from the other."""
    other = {(round(p[0], 3), round(p[1], 3)) for p in _line(b)}
    if not other:
        return True
    line = _line(a)
    step = max(1, len(line) // 200)
    samples = line[::step]
    away = 0
    for p in samples:
        la, lo = round(p[0], 3), round(p[1], 3)
        if not any((round(la + dx * 0.001, 3), round(lo + dy * 0.001, 3)) in other for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
            away += 1
    return away > 0.15 * max(1, len(samples))


async def find_preferred(
    db: AsyncSession, user_id: uuid.UUID, start: dict[str, float], end: dict[str, float], mode: str
) -> tuple[MapPreferredRoute, list[dict[str, Any]]] | None:
    """Your preferred way to this place, and the points still ahead of you. Also
    matches from partway along it, so a reroute stays on your way."""
    rows = (
        await db.execute(select(MapPreferredRoute).where(MapPreferredRoute.user_id == user_id, MapPreferredRoute.mode == mode))
    ).scalars().all()
    for row in rows:
        if data.distance_m(row.to_lat, row.to_lon, end["lat"], end["lon"]) > SAME_PLACE_M:
            continue
        through = list(row.through or [])
        if data.distance_m(row.from_lat, row.from_lon, start["lat"], start["lon"]) <= SAME_PLACE_M:
            return row, through
        gaps = [data.distance_m(p["lat"], p["lon"], start["lat"], start["lon"]) for p in through]
        if gaps and min(gaps) <= ON_THE_WAY_M:
            return row, through[gaps.index(min(gaps)) + 1 :]
    return None


def with_through(body: dict[str, Any], through: list[dict[str, Any]]) -> dict[str, Any]:
    """The same request, made to pass through these points on the way to the end."""
    points = [
        {"lat": p["lat"], "lon": p["lon"], "type": "through", **({"heading": p["heading"], "heading_tolerance": 45} if p.get("heading") is not None else {})}
        for p in through
    ]
    locations = body["locations"]
    return {**body, "locations": [locations[0], *points, locations[-1]], "alternates": 0}


async def _gap(body: dict[str, Any], points: list[dict[str, Any]], route: dict[str, Any]) -> float:
    """How far off this route a request through these points ends up, as a
    fraction of its length. A point near a ramp or a parallel road can drag it away."""
    try:
        got = engine.routes_out(await engine.valhalla("/route", with_through(body, points)))[0]
    except HTTPException:
        return 1.0
    km = route.get("km") or 0
    if not km or different(got, route):
        return 1.0
    return abs((got.get("km") or 0) - km) / km


async def checked_through(body: dict[str, Any], route: dict[str, Any]) -> list[dict[str, Any]]:
    """Points that really do bring a request back onto this route. Tries them, and
    drops whichever pull it off course."""
    points = through_points(route)
    if not points:
        return []
    gap = await _gap(body, points, route)
    for point in list(points):
        if gap <= CLOSE_ENOUGH:
            break
        fewer = [p for p in points if p is not point]
        if not fewer:
            break
        tried = await _gap(body, fewer, route)
        if tried < gap:
            points, gap = fewer, tried
    return points


async def plan(
    db: AsyncSession,
    user: User,
    stops: list[dict[str, Any]],
    mode: str = "drive",
    *,
    tolls: bool = False,
    highways: bool = False,
    ferries: bool = False,
    alternates: int = 2,
    pins: bool = True,
    warnings: bool = True,
) -> dict[str, Any]:
    """Routes for this trip, best first: your preferred way if you have one and
    it's open, then the rest by how long they take right now. Roads reported
    closed are routed around, and anything else on the way is listed on each."""
    body = engine.route_body(stops, mode, tolls=tolls, highways=highways, ferries=ferries, alternates=alternates)
    routes = engine.routes_out(await engine.valhalla("/route", body))
    preferred: dict[str, Any] | None = None
    row: MapPreferredRoute | None = None
    if len(stops) == 2:
        found = await find_preferred(db, user.id, stops[0], stops[1], mode)
        if found:
            row, through = found
            try:
                preferred = engine.routes_out(await engine.valhalla("/route", with_through(body, through)))[0]
            except HTTPException:
                # A closure or a changed road: say nothing, use what works.
                logger.info("A preferred route couldn't be followed")
                preferred, row = None, None
    if preferred is not None and row is not None:
        preferred["preferred"] = {"id": str(row.id), "name": row.name, "tolerance_minutes": row.tolerance_minutes}
        preferred["through_saved"] = True
        # The same way may already be among the others.
        routes = [preferred, *[r for r in routes if different(r, preferred)]]

    around: dict[str, Any] | None = None
    if warnings and mode != "walk":
        reported = await incidents.fetch(db, [_line(r) for r in routes])
        for r in routes:
            r["incidents"] = incidents.on_route(reported, _line(r))
        closed = [i for r in routes for i in r["incidents"] if i["closed"]]
        if closed:
            around = await _go_around(body, routes, closed, reported)
            if around is not None:
                routes.append(around)

    has_traffic = await traffic.annotate(db, user.id, routes)
    # Open roads first. A closed route stays listed, last, with its warning.
    def is_closed(r: dict[str, Any]) -> bool:
        return any(i["closed"] for i in r.get("incidents") or [])

    open_routes = [r for r in routes if not is_closed(r)]
    if preferred is not None and not is_closed(preferred):
        open_routes = [preferred, *[r for r in open_routes if r is not preferred]]
    routes = [*open_routes, *[r for r in routes if is_closed(r)]]
    fastest = min(traffic.travel_seconds(r) for r in (open_routes or routes))
    for r in routes:
        r["slower_seconds"] = max(0, round(traffic.travel_seconds(r) - fastest))
        r["via_name"] = _via_name(r)
        r["through"] = await checked_through(body, r) if pins and len(stops) == 2 else []
    return {"routes": routes, "traffic": has_traffic}


async def _keeping_out(ask: dict[str, Any], closed: list[dict[str, Any]], reported: list[dict[str, Any]], line_of: Any) -> dict[str, Any] | None:
    """A route that stays off these closures. The way round one can run into
    another part of it, so that's checked and closed off too, a few times. None:
    the place is behind the closure, or there's no other way."""
    keep_out = list(closed)
    for _ in range(3):
        try:
            answer = await engine.valhalla("/route", {**ask, "exclude_polygons": incidents.exclusions(keep_out)})
        except HTTPException:
            return None
        still = [i for i in incidents.on_route(reported, line_of(answer)) if i["closed"]]
        if not still:
            return answer
        keep_out += still
    return None


async def _go_around(body: dict[str, Any], routes: list[dict[str, Any]], closed: list[dict[str, Any]], reported: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A route that keeps out of the closed roads, if there's one, and only if
    none of the routes on offer already does."""
    if any(not any(i["closed"] for i in r.get("incidents") or []) for r in routes):
        return None
    answer = await _keeping_out({**body, "alternates": 0}, closed, reported, lambda a: _line(engine.routes_out(a)[0]))
    if answer is None:
        return None
    route = engine.routes_out(answer)[0]
    route["incidents"] = incidents.on_route(reported, _line(route))
    route["avoids"] = sorted({i["from"] or i["label"] for i in closed})[:3]
    return route


async def way_round_closure(here: dict[str, Any], to: dict[str, float], mode: str, closed: list[dict[str, Any]], reported: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Mid-trip, with a road closed ahead: the way round it, whatever it costs."""
    start: dict[str, Any] = {"lat": here["lat"], "lon": here["lon"]}
    body = engine.route_body([start, to], mode, tolls=False, highways=False, ferries=False, alternates=0)
    if here.get("heading") is not None:
        body["locations"][0] |= {"heading": here["heading"], "heading_tolerance": 60}
    answer = await _keeping_out(body, closed, reported, lambda a: _line(engine.routes_out(a)[0]))
    if answer is None:
        return None
    route = engine.routes_out(answer)[0]
    return {
        "reason": f"{closed[0]['label']}{' on ' + closed[0]['from'] if closed[0].get('from') else ''} ahead",
        "saves_seconds": 0,
        "seconds": round(traffic.travel_seconds(route)),
        "km": route.get("km"),
        "via_name": _via_name(route),
        "through": await checked_through(body, route),
    }


async def around_for_navigation(db: AsyncSession, ask: dict[str, Any]) -> dict[str, Any]:
    """The phone's route request, kept off roads reported closed. Costs one
    incident request, so a day of driving stays inside the allowance."""
    answer = await engine.valhalla("/route", ask)
    if ask.get("costing") == "pedestrian":
        return answer
    routes = answer.get("routes") or []
    if not routes or not routes[0].get("geometry"):
        return answer
    line = data.decode_polyline(routes[0]["geometry"])
    reported = await incidents.fetch(db, [line])
    closed = [i for i in incidents.on_route(reported, line) if i["closed"]]
    if not closed:
        return answer
    def nav_line(a: dict[str, Any]) -> list[tuple[float, float]]:
        return data.decode_polyline(a["routes"][0]["geometry"])

    plain = [p for p in ask["locations"] if p.get("type") != "through"]
    for attempt in (ask, {**ask, "locations": plain}):
        around = await _keeping_out(attempt, closed, reported, nav_line)
        if around is not None:
            return around
    return answer


async def better_route(
    db: AsyncSession,
    user: User,
    here: dict[str, Any],
    to: dict[str, float],
    mode: str,
    current: dict[str, Any],
) -> dict[str, Any] | None:
    """Mid-trip: is another way enough quicker to be worth changing? Your
    preferred way needs a bigger saving before we mention it."""
    now = traffic.travel_seconds(current)
    if now < 300 or not current.get("traffic"):
        return None
    need = max(FASTER_MINUTES * 60, now * FASTER_FRACTION)
    found = await find_preferred(db, user.id, here, to, mode)
    if found:
        need = max(need, found[0].tolerance_minutes * 60)
    start: dict[str, Any] = {"lat": here["lat"], "lon": here["lon"]}
    body = engine.route_body([start, to], mode, tolls=False, highways=False, ferries=False, alternates=2)
    if here.get("heading") is not None:
        body["locations"][0] |= {"heading": here["heading"], "heading_tolerance": 60}
    try:
        options = engine.routes_out(await engine.valhalla("/route", body))
    except HTTPException:
        return None
    if not await traffic.annotate(db, user.id, options):
        return None
    for option in options:
        if not option.get("traffic"):
            continue
        saves = now - traffic.travel_seconds(option)
        if saves >= need and different(option, current):
            return {
                "saves_seconds": round(saves),
                "seconds": round(traffic.travel_seconds(option)),
                "km": option.get("km"),
                "via_name": _via_name(option),
                "through": await checked_through(body, option),
            }
    return None
