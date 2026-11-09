"""Place suggestions for a form's Location question (WP-F2.2).

``GET /api/f/{token}/places?q=&question=&lat=&lon=`` — the answer page's
type-ahead. It is the **only** map search a respondent's page uses, for
people with an account and people without one alike:

* It answers only while the form is open to this caller (the same
  ``answer_state`` the page itself goes by) **and** the live form has a
  Location question; anything else is the same ``{code: gone}`` 404 as a
  dead link.
* **Photon only**, never ``maps.router.find_places``: no one's saved
  places, recents or contacts — not the respondent's, not the form owner's.
  A signed-in respondent's own saved places come from their own
  ``/api/maps/places`` on their own device.
* ``ask=town`` (the question's setting) keeps only suburbs, towns and
  cities; ``address`` puts streets and houses first.
* At most 6 results; ``q`` is 2–120 characters.
* Limits: 60 a minute per address on the route, plus 300 an hour per form
  per person (an account, else the address) in Redis with a TTL. Results
  are cached in Redis for 10 minutes by (query, ask, rounded bias).
* Photon down, or Maps not set up: ``{results: [], maps: false}`` — the
  question still works as a plain text box, never an error on the page.
* The query text is never logged here, and never leaves the server
  (Photon runs in the ``maps`` container); nginx's access log redacts it.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from app.forms import answering as ans
from app.forms.responses import Refusal, gone, load

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.auth.models import User

logger = logging.getLogger("promptly.forms")

MAX_RESULTS = 6
PER_PERSON_PER_HOUR = 300
CACHE_SECONDS = 600
_HOUR = 3600

# Photon's ``type`` for a suburb, town or city.
TOWN_TYPES = ("city", "district", "locality")
STREET_TYPES = ("house", "street")


def _who(form_id: Any, user: User | None, ip: str) -> str:
    return f"form:{form_id}:places:{'u:' + str(user.id) if user is not None else (ip or 'unknown')}"


async def _over_limit(key: str) -> bool:
    """Count one search; True past the hourly cap. A Redis outage lets it
    through (Photon is local, and the route limit still holds)."""
    from app.config import get_settings
    from app.redis_client import redis

    if not get_settings().RATE_LIMIT_ENABLED:
        return False
    try:
        n = await redis.incr(key)
        if n == 1:
            await redis.expire(key, _HOUR)
        return int(n) > PER_PERSON_PER_HOUR
    except Exception:  # noqa: BLE001
        return False


def _cache_key(q: str, ask: str, near: tuple[float, float] | None) -> str:
    bias = f"{near[0]:.1f},{near[1]:.1f}" if near else "-"
    raw = f"{ask}|{' '.join(q.lower().split())}|{bias}"
    return "forms:places:cache:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _cached(key: str) -> list[dict[str, Any]] | None:
    from app.redis_client import redis

    try:
        raw = await redis.get(key)
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    try:
        out = json.loads(raw)
    except ValueError:
        return None
    return out if isinstance(out, list) else None


async def _keep(key: str, rows: list[dict[str, Any]]) -> None:
    from app.redis_client import redis

    try:
        await redis.set(key, json.dumps(rows), ex=CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass


def pick(features: list[dict[str, Any]], ask: str) -> list[dict[str, Any]]:
    """Photon features → at most :data:`MAX_RESULTS` rows for the box,
    filtered (town) or ordered (address) by what the question asks for."""
    from app.maps import engine

    rows: list[tuple[int, dict[str, Any]]] = []
    seen: set[tuple[float, float]] = set()
    for i, f in enumerate(features):
        props = f.get("properties") or {}
        kind = str(props.get("type") or "")
        if ask == "town" and kind not in TOWN_TYPES and not (not kind and props.get("osm_key") == "place"):
            continue
        row = engine.label(f)
        if row.get("lat") is None or row.get("lon") is None:
            continue
        spot = (round(float(row["lat"]), 4), round(float(row["lon"]), 4))
        if spot in seen:
            continue
        seen.add(spot)
        rank = 0 if ask != "address" or kind in STREET_TYPES else 1
        rows.append((rank * 1000 + i, {
            "kind": row["kind"],
            "name": row["name"],
            "address": row.get("address"),
            "category": row.get("category"),
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
        }))
    rows.sort(key=lambda r: r[0])
    return [r for _rank, r in rows[:MAX_RESULTS]]


async def search(
    db: AsyncSession,
    token: str,
    user: User | None,
    *,
    q: str,
    question: str | None,
    near: tuple[float, float] | None,
    ip: str,
) -> dict[str, Any]:
    """``GET /api/f/{token}/places``. Raises :class:`Refusal` (``gone`` for
    every form this caller can't use it for)."""
    from fastapi import HTTPException

    from app.maps import engine

    ctx = await load(db, token, user)
    if ctx.state != "open" or ctx.form is None:
        raise gone()
    form = ctx.form
    defn = ans.respondent_definition(form.definition or {})
    located = [i for i in defn.get("items") or [] if i.get("kind") == "location" and not i.get("deleted")]
    if not located:
        raise gone()
    target = next((i for i in located if i.get("id") == question), None) if question else located[0]
    if target is None:
        raise gone()
    ask = str((target.get("config") or {}).get("ask") or "any")
    if await _over_limit(_who(form.id, user, ip)):
        raise Refusal(429, "busy", "Too many searches. Type the place instead, or try again later.")
    q = " ".join(q.split())
    key = _cache_key(q, ask, near)
    hit = await _cached(key)
    if hit is not None:
        return {"results": hit, "maps": True}
    params: dict[str, Any] = {"q": q, "limit": 15}
    if ask == "town":
        params["layer"] = list(TOWN_TYPES)
    if near is not None:
        params["lat"], params["lon"] = near
    try:
        features = await engine.photon("/api", params)
    except HTTPException:
        return {"results": [], "maps": False}
    except Exception:  # noqa: BLE001 — never an error on the answer page
        logger.warning("forms: place search failed")  # no query text in the log
        return {"results": [], "maps": False}
    rows = pick(features, ask)
    await _keep(key, rows)
    return {"results": rows, "maps": True}


__all__ = ["MAX_RESULTS", "PER_PERSON_PER_HOUR", "pick", "search"]
