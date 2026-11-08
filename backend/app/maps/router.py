"""P Maps (``/api/maps``): search, routes, saved places, parking, chargers and
cameras. Each person's places are their own. The phone's native driving screen
signs in with an app password (scope ``maps``); the web app with its session.

Searches and routes go only to the local services (see ``engine``)."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.basic import client_ip, user_from_basic
from app.auth.deps import _bearer, get_current_user, require_admin
from app.auth.models import User
from app.config import get_settings
from app.database import get_db

from . import data, engine, incidents, nearby
from .models import MapParked, MapPlace, MapPreferredRoute, MapRecent

router = APIRouter()

MAX_RECENTS = 40
Lat = Field(ge=-90, le=90)
Lon = Field(ge=-180, le=180)


async def maps_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The signed-in person, or the phone's app password."""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        return await user_from_basic(db, header, scope="maps", ip=client_ip(request))
    return await get_current_user(request, credentials, db)


async def assistant_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The same for the assistant, which reaches far more than the map does."""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        return await user_from_basic(db, header, scope="assistant", ip=client_ip(request))
    return await get_current_user(request, credentials, db)


# ---- What this server has ---------------------------------------------------


@router.get("/config")
async def config(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    from . import traffic
    from .links import basemap_link

    has_traffic = bool(await traffic.traffic_key(db))
    state = await asyncio.to_thread(data.status)
    manifest = await asyncio.to_thread(data.manifest)
    return {
        "basemap": await basemap_link(user),
        "ready": manifest is not None,
        "building": state.get("state") == "building",
        "step": state.get("step") or None,
        "failed": state.get("state") == "failed",
        "built_at": (manifest or {}).get("built_at"),
        "osm_data": (manifest or {}).get("osm_data"),
        "attribution": "© OpenStreetMap contributors · Protomaps · Addresses: G-NAF © Geoscape Australia",
        "traffic": has_traffic,
    }


@router.get("/data-status")
async def data_status(admin: User = Depends(require_admin)) -> dict[str, Any]:
    """For the admin panel: how the map data's doing."""
    _ = admin
    state = await asyncio.to_thread(data.status)
    manifest = await asyncio.to_thread(data.manifest)
    return {
        "ready": manifest is not None,
        "building": state.get("state") == "building",
        "step": state.get("step") or None,
        "failed": state.get("state") == "failed",
        "built_at": (manifest or {}).get("built_at"),
        "addresses": await asyncio.to_thread(data.addresses_state),
        "overdue_days": 0 if state.get("state") == "building" else data.overdue_days((manifest or {}).get("built_at"), get_settings().MAPS_REFRESH_DAYS),
        # Offline packs for phones (maps-offline): off | building | waiting | failed | ready.
        "offline": await asyncio.to_thread(offline_state),
    }


# ---- Search -----------------------------------------------------------------


def _matches(query: str, *fields: str | None) -> bool:
    text = " ".join(f for f in fields if f).lower()
    return all(word in text for word in query.lower().split())


def _contact_addresses(contact: dict[str, Any]) -> list[tuple[str | None, str]]:
    out = []
    for a in contact.get("addresses") or []:
        if not isinstance(a, dict):
            continue
        parts = [a.get(k) for k in ("street", "city", "region", "state", "postcode", "postal_code", "country")]
        line = ", ".join(str(p) for p in parts if p)
        if line:
            out.append((a.get("label"), line))
    return out


async def _contacts(db: AsyncSession, user: User, query: str) -> list[dict[str, Any]]:
    """Your contacts whose name matches, placed through their saved address."""
    from app.items import service as items
    from app.items.kinds.contacts.logic import display_name

    found: list[tuple[str, str | None, str]] = []
    for _row, doc in await items.list_items(db, user, "contacts", limit=5, archives=False):
        for c in (doc.data or {}).get("contacts", []) or []:
            name = display_name(c)
            if not name or not _matches(query, name):
                continue
            for addr_label, line in _contact_addresses(c):
                found.append((name, addr_label, line))
    out: list[dict[str, Any]] = []
    for name, addr_label, line in found[:4]:
        try:
            hits = await engine.photon("/api", {"q": line, "limit": 1})
        except HTTPException:
            return out
        if hits:
            hit = engine.label(hits[0])
            out.append({
                "kind": "contact",
                "name": name,
                "address": f"{addr_label}: {line}" if addr_label else line,
                "lat": hit["lat"],
                "lon": hit["lon"],
            })
    return out


async def find_places(db: AsyncSession, user: User, query: str, near: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """Your own places first, then the people you know, then the map."""
    out: list[dict[str, Any]] = []
    if query.strip().lower() in {"my car", "the car", "car", "where i parked", "parked", "my parked car"}:
        parked = await db.get(MapParked, user.id)
        if parked is not None:
            out.append({"kind": "place", "name": "Your car", "address": parked.note, "lat": parked.lat, "lon": parked.lon})
    places = (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id))).scalars().all()
    for p in places:
        if _matches(query, p.name, p.address, p.list_name, p.kind if p.kind in ("home", "work") else None):
            out.append({"kind": p.kind, "id": str(p.id), "name": p.name, "address": p.address, "lat": p.lat, "lon": p.lon})
    recents = (
        await db.execute(select(MapRecent).where(MapRecent.user_id == user.id).order_by(MapRecent.used_at.desc()).limit(MAX_RECENTS))
    ).scalars().all()
    out += [
        {"kind": "recent", "name": r.name, "address": r.address, "lat": r.lat, "lon": r.lon}
        for r in recents if _matches(query, r.name, r.address)
    ][:3]
    try:
        out += await _contacts(db, user, query)
    except Exception:  # noqa: BLE001 — a broken contacts file costs its results, not the search
        pass
    # "Fuel", "the nearest servo": what's around you, not a place with that name.
    category = nearby.category_for(query) if near else None
    if category:
        out += await nearby.around(category, near["lat"], near["lon"], limit=8)
    params: dict[str, Any] = {"q": query, "limit": 8, **(near or {})}
    seen = {(round(r["lat"], 4), round(r["lon"], 4)) for r in out if r.get("lat") is not None}
    for f in await engine.photon("/api", params):
        row = engine.label(f)
        if row["lat"] is None or (round(row["lat"], 4), round(row["lon"], 4)) in seen:
            continue
        out.append(row)
    return out


@router.get("/search")
async def search(
    q: str = Query(min_length=1, max_length=200),
    lat: float | None = Query(default=None, ge=-90, le=90),
    lon: float | None = Query(default=None, ge=-180, le=180),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(maps_user),
) -> dict[str, Any]:
    near = {"lat": lat, "lon": lon} if lat is not None and lon is not None else None
    return {"results": await find_places(db, user, q.strip(), near)}


@router.get("/reverse")
async def reverse(
    lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), user: User = Depends(maps_user)
) -> dict[str, Any]:
    """What's at this spot (a long-press on the map)."""
    hits = await engine.photon("/reverse", {"lat": lat, "lon": lon, "limit": 1})
    if not hits:
        return {"kind": "pin", "name": "Dropped pin", "address": None, "lat": lat, "lon": lon}
    return {**engine.label(hits[0]), "lat": lat, "lon": lon}


# ---- Routes -----------------------------------------------------------------


class Stop(BaseModel):
    lat: float = Lat
    lon: float = Lon
    name: str | None = Field(default=None, max_length=200)


class Via(BaseModel):
    lat: float = Lat
    lon: float = Lon


class RouteBody(BaseModel):
    stops: list[Stop] = Field(min_length=2, max_length=20)
    mode: Literal["drive", "walk", "cycle"] = "drive"
    avoid_tolls: bool = False
    avoid_highways: bool = False
    avoid_ferries: bool = False
    # Keep the first and last stops; put the ones between in the best order.
    best_order: bool = False
    # Roads you want to go along, as points tapped on them.
    via: list[Via] = Field(default_factory=list, max_length=5)


@router.post("/route")
async def route(body: RouteBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    stops = [s.model_dump() for s in body.stops]
    options = {"tolls": body.avoid_tolls, "highways": body.avoid_highways, "ferries": body.avoid_ferries}
    order = list(range(len(stops)))
    if body.best_order and len(stops) > 3:
        ask = engine.route_body(stops, body.mode, **options, alternates=0)
        for loc in ask["locations"]:
            loc.pop("name", None)
        found = await engine.valhalla("/optimized_route", ask)
        order = [loc["original_index"] for loc in found["trip"]["locations"]]
        stops = [stops[i] for i in order]
    from . import planning

    planned = await planning.plan(db, user, stops, body.mode, **options, via=[v.model_dump() for v in body.via])
    return {**planned, "order": order}


@router.get("/nearby")
async def near_you(
    category: str = Query(max_length=20),
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    user: User = Depends(maps_user),
) -> dict[str, Any]:
    """Fuel, food and so on around a point, closest first."""
    _ = user
    if category not in nearby.CATEGORIES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown category.")
    return {"results": await nearby.around(category, lat, lon)}


class NearbyAlong(BaseModel):
    category: str = Field(max_length=20)
    shapes: list[str] = Field(min_length=1, max_length=25)  # what's left of the trip
    here: Stop
    to: Stop
    mode: Literal["drive", "walk", "cycle"] = "drive"


@router.post("/nearby/along")
async def near_the_way(body: NearbyAlong, user: User = Depends(maps_user)) -> dict[str, Any]:
    """What's on the way, each with how long stopping there adds."""
    _ = user
    if body.category not in nearby.CATEGORIES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown category.")
    line = [p for s in body.shapes for p in data.decode_polyline(s)]
    rows = await nearby.along(body.category, line)
    if not rows:
        rows = await nearby.along(body.category, line, within_m=3000.0)
    results = await nearby.with_detours(rows, body.here.model_dump(), body.to.model_dump(), body.mode) if rows else []
    return {"results": results}


@router.post("/assistant")
async def assistant(
    request: Request,
    audio: UploadFile | None = File(default=None),
    text: str | None = Form(default=None, max_length=500),
    state: str = Form(default="{}", max_length=200_000),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(assistant_user),
) -> dict[str, Any]:
    """What you said after "Hey Promptly", for apps installed before /api/assistant."""
    from .assistant import answer_request

    return await answer_request(request, audio, text, state, db, user)


class TrafficNow(BaseModel):
    shapes: list[str] = Field(min_length=1, max_length=25)  # what's left of the trip
    seconds: float = Field(ge=0)  # our own estimate for it
    km: float = Field(ge=0)
    # With these, also look for a quicker way to get there.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    heading: float | None = Field(default=None, ge=0, le=360)
    to: Stop | None = None
    mode: Literal["drive", "walk", "cycle"] = "drive"
    # Also check for crashes and closures ahead: the phone asks every 10 minutes.
    warnings: bool = False


@router.post("/traffic/route")
async def traffic_on_route(body: TrafficNow, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """How the rest of a trip looks right now, and whether another way would be
    worth taking: the driving screen asks every few minutes."""
    from . import planning, traffic

    route_ = {"km": body.km, "seconds": body.seconds, "legs": [{"shape": s, "km": body.km / len(body.shapes), "seconds": body.seconds / len(body.shapes), "steps": []} for s in body.shapes]}
    here = {"lat": body.lat, "lon": body.lon, "heading": body.heading}
    can_change = body.to is not None and body.lat is not None and body.lon is not None
    ahead: list[dict[str, Any]] | None = None
    faster = None
    if body.warnings:
        line = [p for s in body.shapes for p in data.decode_polyline(s)]
        reported = await incidents.fetch(db, [line])
        ahead = incidents.on_route(reported, line)
        closed = [i for i in ahead if i["closed"]]
        if closed and can_change:
            faster = await planning.way_round_closure(here, body.to.model_dump(), body.mode, closed, reported)
    if not await traffic.annotate(db, user.id, [route_]):
        return {"traffic": None, "faster": faster, "incidents": ahead}
    found = route_["traffic"]
    if faster is None and can_change:
        faster = await planning.better_route(db, user, here, body.to.model_dump(), body.mode, route_)
    return {"traffic": {k: found[k] for k in ("seconds", "free_seconds", "adds_seconds", "closures", "jams")}, "faster": faster, "incidents": ahead}


@router.get("/traffic/incidents/{z}/{x}/{y}.pbf")
async def incident_tile(z: int, x: int, y: int, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> Response:
    """Incidents for the map layer, through this server, zoomed in only: further out
    TomTom groups them, and looking around would spend the allowance."""
    from . import traffic

    if z != 13 or not (0 <= x < 2**z and 0 <= y < 2**z):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    key = await traffic.traffic_key(db)
    content = await traffic.fetch_tile(key, user.id, "incidents", z, x, y, layer=True) if key else None
    if not content:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return Response(content=content, media_type="application/x-protobuf", headers={"Cache-Control": "private, max-age=60"})


class PlaceAsk(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float = Lat
    lon: float = Lon


@router.post("/place/details")
async def place_more(body: PlaceAsk, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Hours, phone and website, asked for one place at a time, from TomTom. This
    tells TomTom which place, so it only happens when you press the button."""
    got = await incidents.place_details(db, body.name, body.lat, body.lon)
    if got is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="More details aren't available right now.")
    return got


@router.get("/traffic/tile/{z}/{x}/{y}.pbf")
async def traffic_tile(z: int, x: int, y: int, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> Response:
    """The traffic layer's tiles, through this server: the key stays here, and
    TomTom doesn't see who's looking at the map."""
    from . import traffic

    if not 9 <= z <= 11 or not (0 <= x < 2**z and 0 <= y < 2**z):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    key = await traffic.traffic_key(db)
    content = await traffic.fetch_tile(key, user.id, "relative", z, x, y, layer=True) if key else None
    if not content:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return Response(content=content, media_type="application/x-protobuf", headers={"Cache-Control": "private, max-age=60"})


@router.post("/traffic/test")
async def traffic_test(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict[str, Any]:
    """Does the saved key work, and how much of today's allowance has gone?"""
    from . import traffic

    key = await traffic.traffic_key(db)
    if not key:
        return {"ok": False, "message": "No key saved.", "used_today": 0}
    ok, message = await traffic.check_key(key)
    return {"ok": ok, "message": message, "used_today": await traffic.used_today(), "daily_limit": get_settings().MAPS_TRAFFIC_DAILY_LIMIT}


# The fields the native driving screen's navigation library asks for.
_NAV_FIELDS = {
    "locations", "costing", "costing_options", "units", "language", "format", "banner_instructions", "voice_instructions",
    "filters", "directions_options", "alternates", "shape_format", "id",
}


@router.post("/navigate/route")
async def navigate_route(
    body: dict[str, Any], request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)
) -> dict[str, Any]:
    """A route for turn-by-turn on the phone, in the format its library reads.
    The phone marks the ones its navigation library asks for after a wrong turn
    (``X-Promptly-Reroute: 1``): those check for closures every few minutes, not
    every time."""
    locations = body.get("locations")
    if not isinstance(locations, list) or not 2 <= len(locations) <= 20:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Two to twenty stops.")
    check = await incidents.closures_due(user.id, request.headers.get("x-promptly-reroute") == "1")
    ask = {k: v for k, v in body.items() if k in _NAV_FIELDS}
    # A plain A to B follows the way you prefer, including after a wrong turn.
    from . import planning

    if len(locations) == 2 and all(isinstance(p, dict) and isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float)) for p in locations):
        mode = {"auto": "drive", "pedestrian": "walk", "bicycle": "cycle"}.get(str(ask.get("costing")), "drive")
        found = await planning.find_preferred(db, user.id, locations[0], locations[1], mode)
        if found:
            ask = {**planning.with_through(ask, found[1]), "alternates": ask.get("alternates", 0)}
            try:
                return await planning.around_for_navigation(db, ask, check)
            except HTTPException:
                ask = {k: v for k, v in body.items() if k in _NAV_FIELDS}
    return await planning.around_for_navigation(db, ask, check)


# ---- The way you prefer ------------------------------------------------------


class ThroughPoint(BaseModel):
    lat: float = Lat
    lon: float = Lon
    heading: float | None = Field(default=None, ge=0, le=360)


class PreferredBody(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    start: Stop
    end: Stop
    through: list[ThroughPoint] = Field(min_length=1, max_length=20)
    mode: Literal["drive", "walk", "cycle"] = "drive"
    tolerance_minutes: int = Field(default=10, ge=1, le=120)


def _preferred(p: MapPreferredRoute) -> dict[str, Any]:
    return {
        "id": str(p.id), "name": p.name, "mode": p.mode, "from_name": p.from_name, "to_name": p.to_name,
        "from": {"lat": p.from_lat, "lon": p.from_lon, "name": p.from_name}, "to": {"lat": p.to_lat, "lon": p.to_lon, "name": p.to_name},
        "tolerance_minutes": p.tolerance_minutes,
    }


@router.get("/preferred")
async def preferred_routes(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    rows = (await db.execute(select(MapPreferredRoute).where(MapPreferredRoute.user_id == user.id).order_by(MapPreferredRoute.created_at))).scalars().all()
    return {"routes": [_preferred(p) for p in rows]}


@router.post("/preferred", status_code=status.HTTP_201_CREATED)
async def add_preferred(body: PreferredBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Save this as the way you go between these two places. There's one per
    direction: saving again replaces it."""
    start, end = body.start, body.end
    rows = (await db.execute(select(MapPreferredRoute).where(MapPreferredRoute.user_id == user.id, MapPreferredRoute.mode == body.mode))).scalars().all()
    for old in rows:
        if data.distance_m(old.from_lat, old.from_lon, start.lat, start.lon) <= 500 and data.distance_m(old.to_lat, old.to_lon, end.lat, end.lon) <= 500:
            await db.delete(old)
    await db.flush()
    from_name, to_name = start.name or "Start", end.name or "Destination"
    row = MapPreferredRoute(
        id=uuid.uuid4(), user_id=user.id, name=(body.name or "").strip() or f"{from_name} to {to_name}", mode=body.mode,
        from_name=from_name, from_lat=start.lat, from_lon=start.lon, to_name=to_name, to_lat=end.lat, to_lon=end.lon,
        through=[p.model_dump(exclude_none=True) for p in body.through], tolerance_minutes=body.tolerance_minutes,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _preferred(row)


class PreferredPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tolerance_minutes: int | None = Field(default=None, ge=1, le=120)


@router.patch("/preferred/{route_id}")
async def edit_preferred(route_id: uuid.UUID, body: PreferredPatch, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    row = await db.get(MapPreferredRoute, route_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Not found.")
    for key, value in body.model_dump(exclude_none=True).items():
        setattr(row, key, value)
    await db.commit()
    return _preferred(row)


@router.delete("/preferred/{route_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_preferred(route_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    await db.execute(delete(MapPreferredRoute).where(MapPreferredRoute.id == route_id, MapPreferredRoute.user_id == user.id))
    await db.commit()


# ---- Your places ------------------------------------------------------------


# The picker's icons (frontend/scripts/gen_place_icons.mjs).
ICONS = (
    "bookmark", "star", "heart", "users", "coffee", "utensils", "beer", "shopping-cart", "fuel", "car", "wrench", "dumbbell",
    "graduation-cap", "stethoscope", "baby", "dog", "trees", "tent", "waves", "plane",
)
Icon = Literal[ICONS]  # type: ignore[valid-type]
COLOUR = r"^#[0-9A-Fa-f]{6}$"


class PlaceBody(BaseModel):
    kind: Literal["home", "work", "favourite", "list"] = "favourite"
    icon: Icon | None = None
    colour: str | None = Field(default=None, pattern=COLOUR)
    list_name: str | None = Field(default=None, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=400)
    note: str | None = Field(default=None, max_length=4000)
    lat: float = Lat
    lon: float = Lon


def _place(p: MapPlace) -> dict[str, Any]:
    return {
        "id": str(p.id), "kind": p.kind, "list_name": p.list_name, "name": p.name, "address": p.address,
        "note": p.note, "lat": p.lat, "lon": p.lon, "icon": p.icon, "colour": p.colour,
    }


@router.get("/places")
async def places(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    rows = (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id).order_by(MapPlace.created_at))).scalars().all()
    recents = (
        await db.execute(select(MapRecent).where(MapRecent.user_id == user.id).order_by(MapRecent.used_at.desc()).limit(10))
    ).scalars().all()
    parked = await db.get(MapParked, user.id)
    return {
        "places": [_place(p) for p in rows],
        "recents": [{"name": r.name, "address": r.address, "lat": r.lat, "lon": r.lon} for r in recents],
        "parked": _parked(parked) if parked else None,
    }


@router.post("/places", status_code=status.HTTP_201_CREATED)
async def add_place(body: PlaceBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Save a place. There's one Home and one Work: saving again moves them."""
    if body.kind in ("home", "work"):
        await db.execute(delete(MapPlace).where(MapPlace.user_id == user.id, MapPlace.kind == body.kind))
    if body.kind == "list" and not (body.list_name or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Name the list.")
    row = MapPlace(id=uuid.uuid4(), user_id=user.id, **body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _place(row)


class PlacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=4000)
    list_name: str | None = Field(default=None, max_length=80)
    icon: Icon | None = None
    colour: str | None = Field(default=None, pattern=COLOUR)


@router.patch("/places/{place_id}")
async def edit_place(place_id: uuid.UUID, body: PlacePatch, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    row = await db.get(MapPlace, place_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Not found.")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    await db.commit()
    return _place(row)


@router.delete("/places/{place_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_place(place_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    await db.execute(delete(MapPlace).where(MapPlace.id == place_id, MapPlace.user_id == user.id))
    await db.commit()


class RecentBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=400)
    lat: float = Lat
    lon: float = Lon


@router.post("/recents", status_code=status.HTTP_204_NO_CONTENT)
async def add_recent(body: RecentBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    now = datetime.now(timezone.utc)
    key = f"{body.lat:.4f},{body.lon:.4f}"
    await db.execute(
        insert(MapRecent)
        .values(id=uuid.uuid4(), user_id=user.id, key=key, used_at=now, **body.model_dump())
        .on_conflict_do_update(constraint="uq_map_recents_user_key", set_={"name": body.name, "address": body.address, "used_at": now})
    )
    stale = (
        await db.execute(select(MapRecent.id).where(MapRecent.user_id == user.id).order_by(MapRecent.used_at.desc()).offset(MAX_RECENTS))
    ).scalars().all()
    if stale:
        await db.execute(delete(MapRecent).where(MapRecent.id.in_(stale)))
    await db.commit()


@router.delete("/recents", status_code=status.HTTP_204_NO_CONTENT)
async def clear_recents(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    await db.execute(delete(MapRecent).where(MapRecent.user_id == user.id))
    await db.commit()


# ---- Where you parked -------------------------------------------------------


class ParkedBody(BaseModel):
    lat: float = Lat
    lon: float = Lon
    note: str | None = Field(default=None, max_length=400)
    source: Literal["manual", "auto"] = "manual"


def _parked(p: MapParked) -> dict[str, Any]:
    return {"lat": p.lat, "lon": p.lon, "note": p.note, "at": p.at.isoformat(), "source": p.source}


@router.put("/parked")
async def set_parked(body: ParkedBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    values = {"lat": body.lat, "lon": body.lon, "note": body.note, "source": body.source, "at": now}
    await db.execute(
        insert(MapParked).values(user_id=user.id, **values).on_conflict_do_update(index_elements=["user_id"], set_=values)
    )
    await db.commit()
    return {**values, "at": now.isoformat()}


@router.delete("/parked", status_code=status.HTTP_204_NO_CONTENT)
async def clear_parked(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    await db.execute(delete(MapParked).where(MapParked.user_id == user.id))
    await db.commit()


# ---- Chargers and cameras ---------------------------------------------------


def _box(bbox: str) -> tuple[float, float, float, float]:
    try:
        west, south, east, north = (float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bbox is west,south,east,north.") from None
    return west, south, east, north


def _plugged(rows: list[dict[str, Any]], plug: str | None, min_kw: float | None) -> list[dict[str, Any]]:
    if plug:
        rows = [r for r in rows if any(s["type"].startswith(plug) for s in r["sockets"])]
    if min_kw:
        rows = [r for r in rows if (r.get("max_kw") or 0) >= min_kw]
    return rows


@router.get("/chargers")
async def chargers(
    bbox: str,
    plug: str | None = Query(default=None, max_length=40),
    min_kw: float | None = Query(default=None, ge=0),
    user: User = Depends(maps_user),
) -> dict[str, Any]:
    rows = await asyncio.to_thread(data.chargers)
    return {"chargers": _plugged(data.in_box(rows, _box(bbox)), plug, min_kw)[:500]}


class AlongBody(BaseModel):
    shapes: list[str] = Field(min_length=1, max_length=25)  # each leg's encoded shape
    within_m: float = Field(default=1500, ge=50, le=10000)
    plug: str | None = Field(default=None, max_length=40)
    min_kw: float | None = Field(default=None, ge=0)


def _line(shapes: list[str]) -> list[tuple[float, float]]:
    line: list[tuple[float, float]] = []
    for shape in shapes:
        try:
            line += data.decode_polyline(shape)
        except (IndexError, ValueError):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That isn't a route shape.") from None
    return line


@router.post("/chargers/along")
async def chargers_along(body: AlongBody, user: User = Depends(maps_user)) -> dict[str, Any]:
    def work() -> list[dict[str, Any]]:
        return data.near_line(_plugged(data.chargers(), body.plug, body.min_kw), _line(body.shapes), body.within_m)

    return {"chargers": (await asyncio.to_thread(work))[:200]}


@router.post("/cameras/along")
async def cameras_along(body: AlongBody, user: User = Depends(maps_user)) -> dict[str, Any]:
    """Speed cameras on this route, for warnings on the way."""
    def work() -> list[dict[str, Any]]:
        return data.near_line(data.cameras(), _line(body.shapes), min(body.within_m, 60))

    return {"cameras": await asyncio.to_thread(work)}


@router.get("/cameras")
async def cameras(bbox: str, user: User = Depends(maps_user)) -> dict[str, Any]:
    rows = await asyncio.to_thread(data.cameras)
    return {"cameras": data.in_box(rows, _box(bbox))[:1000]}


# ---- Offline areas (maps-offline) ---------------------------------------------
# Their own module, included here so main.py isn't touched.
from .offline import router as offline_router, state as offline_state  # noqa: E402

router.include_router(offline_router)
