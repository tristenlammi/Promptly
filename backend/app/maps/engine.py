"""Talking to the two local map services: Valhalla (routes) and Photon (search).
Both run in the ``maps`` container on this server; nothing leaves it."""
from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException, status

from app.config import get_settings

logger = logging.getLogger("promptly.maps")
_TIMEOUT = httpx.Timeout(20.0, connect=3.0)
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT)
    return _client


def _down() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Maps aren't ready on this server yet.")


async def valhalla(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """A Valhalla call. Its "no route" answers become a clean 422."""
    url = get_settings().MAPS_VALHALLA_URL
    if not url:
        raise _down()
    try:
        r = await _http().post(f"{url}{path}", json=body)
    except httpx.HTTPError:
        raise _down() from None
    if r.status_code >= 500:
        raise _down()
    data = r.json()
    if r.status_code != 200:
        # The code only: Valhalla's text can name the places asked about (G3).
        logger.info("valhalla %s said %s", path, data.get("error_code"))
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=_why(data))
    return data


def _why(data: dict[str, Any]) -> str:
    code = data.get("error_code")
    # Valhalla's codes for "nowhere near a road" and "no way there".
    if code in {171, 442}:
        return "No route between these places."
    if code in {170, 154, 155, 157}:
        return "These places are too far apart to route, or one isn't near a road."
    return "No route between these places."


async def photon(path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    url = get_settings().MAPS_PHOTON_URL
    if not url:
        raise _down()
    try:
        r = await _http().get(f"{url}{path}", params=params)
    except httpx.HTTPError:
        raise _down() from None
    if r.status_code != 200:
        raise _down()
    return r.json().get("features") or []


def label(feature: dict[str, Any]) -> dict[str, Any]:
    """One search result, the way the app shows it."""
    p = feature.get("properties") or {}
    lon, lat = (feature.get("geometry") or {}).get("coordinates") or (None, None)
    number, street = p.get("housenumber"), p.get("street")
    road = " ".join(x for x in (number, street) if x)
    name = p.get("name") or road or p.get("city") or p.get("state") or "Dropped pin"
    area = " ".join(x for x in (p.get("city") or p.get("locality") or p.get("district"), p.get("state"), p.get("postcode")) if x)
    parts = [road if road and road != name else None, area if area != name else None]
    return {
        "kind": "address" if (number and not p.get("name")) else "place",
        "name": name,
        "address": ", ".join(x for x in parts if x) or None,
        "lat": lat,
        "lon": lon,
        "category": p.get("osm_value") if p.get("osm_key") not in {"place", "highway", "building"} else None,
    }


COSTING = {"drive": "auto", "walk": "pedestrian", "cycle": "bicycle"}


def route_body(
    stops: list[dict[str, Any]], mode: str, *, tolls: bool, highways: bool, ferries: bool, alternates: int, language: str = "en-GB"
) -> dict[str, Any]:
    """A Valhalla request. An ``avoid`` is a strong preference, not a ban, so a
    trip that needs a ferry (Tasmania) still has an answer."""
    costing = COSTING[mode]
    options: dict[str, Any] = {}
    if tolls:
        options["use_tolls"] = 0.0
    if highways and costing == "auto":
        options["use_highways"] = 0.0
    if ferries:
        options["use_ferry"] = 0.0
    last = len(stops) - 1
    body: dict[str, Any] = {
        "locations": [
            {"lat": s["lat"], "lon": s["lon"], "type": "break", **({"name": s["name"]} if i in (0, last) and s.get("name") else {})}
            for i, s in enumerate(stops)
        ],
        "costing": costing,
        "costing_options": {costing: options},
        "units": "kilometers",
        "language": language,
    }
    if alternates and len(stops) == 2:
        body["alternates"] = alternates
    return body


def _route(trip: dict[str, Any]) -> dict[str, Any]:
    summary = trip.get("summary") or {}
    legs = []
    for leg in trip.get("legs") or []:
        legs.append({
            "shape": leg.get("shape"),
            "km": (leg.get("summary") or {}).get("length"),
            "seconds": (leg.get("summary") or {}).get("time"),
            "steps": [
                {
                    "text": m.get("instruction"),
                    "km": m.get("length"),
                    "seconds": m.get("time"),
                    "type": m.get("type"),
                    "street": (m.get("street_names") or [None])[0],
                    "at": m.get("begin_shape_index"),
                }
                for m in leg.get("maneuvers") or []
            ],
        })
    return {
        "km": summary.get("length"),
        "seconds": summary.get("time"),
        "toll": bool(summary.get("has_toll")),
        "highway": bool(summary.get("has_highway")),
        "ferry": bool(summary.get("has_ferry")),
        "legs": legs,
    }


def routes_out(data: dict[str, Any]) -> list[dict[str, Any]]:
    """The main route, then its alternatives."""
    out = [_route(data["trip"])]
    for alt in data.get("alternates") or []:
        if alt.get("trip"):
            out.append(_route(alt["trip"]))
    return out
