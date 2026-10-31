"""Open Food Facts (barcode + name search), the built-in food list, and the
trends feed — the kind's own endpoints at ``/api/items/k/meals/…``.

OFF is queried server-side (no third-party request from the person's
browser, one place for the timeout and User-Agent OFF asks for). Results
are mapped to the file's food shape (per 100 g) and cached in memory for a
while (single worker; it's only a politeness cache).
"""
from __future__ import annotations

import logging
import os
import re
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

logger = logging.getLogger("promptly.items.meals.off")

OFF_BASE = "https://world.openfoodfacts.org"
TIMEOUT_S = 10.0
CACHE_TTL_S = 6 * 3600
_FIELDS = (
    "code,product_name,product_name_en,generic_name,brands,serving_size,serving_quantity,"
    "quantity,nutriments,nutrition_data_per"
)


def _version() -> str:
    v = os.environ.get("PROMPTLY_VERSION") or os.environ.get("APP_VERSION")
    if v:
        return v.strip()
    for p in Path(__file__).resolve().parents:
        f = p / "VERSION"
        if f.is_file():
            try:
                return f.read_text(encoding="utf-8").strip()[:20] or "dev"
            except OSError:
                break
    return "dev"


USER_AGENT = f"Promptly/{_version()} (self-hosted)"


def _client() -> httpx.AsyncClient:
    """The HTTP client (tests swap in a mock transport here)."""
    return httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT}, follow_redirects=True)


_cache: dict[str, tuple[float, Any]] = {}

# --- politeness: per-user rate limits + a short memory of failures --------
# In-process (the backend runs one worker). Cache hits don't count.
RATE_LIMITS = {"search": (10, 60.0), "barcode": (40, 60.0)}  # (calls, seconds)
FAIL_TTL_S = 60.0
_calls: dict[tuple[str, str], deque] = {}
_failed: dict[str, float] = {}
_down_until = 0.0


class RateLimited(Exception):
    def __init__(self, retry_after: float) -> None:
        super().__init__(f"retry in {retry_after:.0f}s")
        self.retry_after = retry_after


def check_rate(user_key: str, what: str) -> None:
    """Count one Open Food Facts call for ``user_key`` (sliding window);
    raises :class:`RateLimited` when they're over the limit."""
    limit, window = RATE_LIMITS[what]
    now = time.monotonic()
    q = _calls.setdefault((user_key, what), deque())
    while q and now - q[0] >= window:
        q.popleft()
    if len(q) >= limit:
        raise RateLimited(window - (now - q[0]))
    q.append(now)
    if len(_calls) > 5000:  # forget idle people
        for k in [k for k, v in _calls.items() if not v or now - v[-1] > 3600][:2000]:
            _calls.pop(k, None)


def _recent_failure(key: str) -> bool:
    now = time.monotonic()
    if now < _down_until:
        return True
    at = _failed.get(key)
    return at is not None and now - at < FAIL_TTL_S


def _note_failure(key: str) -> None:
    global _down_until
    now = time.monotonic()
    _failed[key] = now
    if len(_failed) > 500:
        for k in sorted(_failed, key=lambda k: _failed[k])[:250]:
            _failed.pop(k, None)
    # Several different lookups failing within a minute means OFF is down:
    # stop asking for a short while instead of hammering it.
    if sum(1 for t in _failed.values() if now - t < FAIL_TTL_S) >= 3:
        _down_until = now + 30.0


def valid_gtin(code: str) -> bool:
    """A GTIN-8/12/13/14 (EAN-8, UPC-A, EAN-13, ITF-14) with a correct
    check digit."""
    if not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return False
    digits = [int(c) for c in code]
    body, check = digits[:-1], digits[-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def _cached(key: str) -> Any:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    return None


def _remember(key: str, value: Any) -> None:
    if len(_cache) > 500:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
            _cache.pop(k, None)
    _cache[key] = (time.monotonic(), value)


# ------------------------------------------------------------------ mapping


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "."))
        except ValueError:
            return None
    return None


# OFF nutriment → (our key, factor from OFF's grams)
_MICRO_MAP = {
    "potassium": ("potassium_mg", 1000),
    "calcium": ("calcium_mg", 1000),
    "iron": ("iron_mg", 1000),
    "magnesium": ("magnesium_mg", 1000),
    "zinc": ("zinc_mg", 1000),
    "vitamin-a": ("vitamin_a_ug", 1_000_000),
    "vitamin-c": ("vitamin_c_mg", 1000),
    "vitamin-d": ("vitamin_d_ug", 1_000_000),
    "vitamin-b12": ("vitamin_b12_ug", 1_000_000),
    "vitamin-b9": ("folate_ug", 1_000_000),
    "folates": ("folate_ug", 1_000_000),
    "cholesterol": ("cholesterol_mg", 1000),
    "trans-fat": ("trans_fat_g", 1),
    "monounsaturated-fat": ("mono_fat_g", 1),
    "polyunsaturated-fat": ("poly_fat_g", 1),
    "omega-3-fat": ("omega3_g", 1),
    "caffeine": ("caffeine_mg", 1000),
    "added-sugars": ("added_sugar_g", 1),
}


def _per100(nutriments: dict, serving_g: float | None) -> dict | None:
    """Per-100 g nutrition from OFF's nutriments (falling back to per-serving
    values scaled by the serving size). None when there's no energy."""

    def get(name: str) -> float | None:
        v = _num(nutriments.get(f"{name}_100g"))
        if v is None and serving_g:
            s = _num(nutriments.get(f"{name}_serving"))
            if s is not None:
                v = s * 100 / serving_g
        return v

    kcal = get("energy-kcal")
    if kcal is None:
        kj = get("energy-kj")
        if kj is None:
            kj = get("energy")  # OFF's "energy" is kJ
        kcal = kj / 4.184 if kj is not None else None
    if kcal is None:
        return None
    sodium = get("sodium")
    if sodium is None:
        salt = get("salt")
        sodium = salt / 2.5 if salt is not None else 0.0
    out = {
        "kcal": round(max(0.0, kcal), 1),
        "protein": round(max(0.0, get("proteins") or 0), 1),
        "carbs": round(max(0.0, get("carbohydrates") or 0), 1),
        "sugar": round(max(0.0, get("sugars") or 0), 1),
        "fibre": round(max(0.0, get("fiber") or 0), 1),
        "fat": round(max(0.0, get("fat") or 0), 1),
        "sat_fat": round(max(0.0, get("saturated-fat") or 0), 1),
        "sodium": round(max(0.0, sodium * 1000), 1),
        "micros": {},
    }
    for name, (key, factor) in _MICRO_MAP.items():
        v = get(name)
        if v is not None and v >= 0 and key not in out["micros"]:
            out["micros"][key] = round(v * factor, 2)
    return out


_QTY_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(g|gr|grams?|ml|mL|cl|l)\b", re.I)


def _grams_in(text: str | None) -> float | None:
    if not text:
        return None
    m = _QTY_RE.search(text)
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    u = m.group(2).lower()
    if u == "cl":
        n *= 10
    elif u == "l":
        n *= 1000
    return n if 0 < n <= 5000 else None


def map_product(p: dict) -> dict | None:
    """An OFF product → the file's food shape, or None if it has no
    nutrition we can use."""
    if not isinstance(p, dict):
        return None
    name = (p.get("product_name") or p.get("product_name_en") or p.get("generic_name") or "").strip()
    if not name:
        return None
    serving_g = _num(p.get("serving_quantity"))
    if serving_g is not None and not (0 < serving_g <= 5000):
        serving_g = None
    if serving_g is None:
        serving_g = _grams_in(p.get("serving_size"))
    per100 = _per100(p.get("nutriments") or {}, serving_g)
    if per100 is None:
        return None
    servings = []
    if serving_g:
        label = (p.get("serving_size") or "").strip()[:60] or f"1 serving ({serving_g:g} g)"
        servings.append({"id": "s1", "label": label, "grams": round(serving_g, 1)})
    pack_g = _grams_in(p.get("quantity"))
    if pack_g and (not serving_g or abs(pack_g - serving_g) > 1):
        servings.append({"id": f"s{len(servings) + 1}", "label": f"1 pack ({p.get('quantity', '').strip()[:40]})", "grams": round(pack_g, 1)})
    qty = (p.get("quantity") or "").lower()
    liquid = bool(re.search(r"\d\s*(ml|cl|l)\b", qty))
    brand = (p.get("brands") or "").split(",")[0].strip()[:80]
    code = "".join(ch for ch in str(p.get("code") or "") if ch.isdigit())[:20] or None
    return {
        "name": name[:120],
        "brand": brand,
        "barcode": code,
        "servings": servings,
        "default_serving": servings[0]["id"] if servings else None,
        "per100": per100,
        "liquid": liquid,
        "source": "off",
    }


# -------------------------------------------------------------------- calls


class OffUnavailable(Exception):
    pass


BARCODE_HELP = "A barcode is the 8, 12, 13 or 14 digits under the stripes (EAN-8, UPC-A, EAN-13 or GTIN-14)."


def clean_barcode(code: str) -> str:
    """Digits only, validated (raises ValueError with a helpful message)."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) not in (8, 12, 13, 14):
        raise ValueError(f"{BARCODE_HELP} That one has {len(code)}.")
    if not valid_gtin(code):
        raise ValueError("That barcode's last (check) digit doesn't match, so a digit is probably off. Check the number and try again.")
    return code


def cached_barcode(code: str) -> tuple[bool, dict | None]:
    """(known, food) from the cache, without asking OFF."""
    hit = _cached(f"b:{code}")
    return (hit is not None), (hit or None)


async def lookup_barcode(code: str) -> dict | None:
    code = clean_barcode(code)
    key = f"b:{code}"
    hit = _cached(key)
    if hit is not None:
        return hit or None
    if _recent_failure(key):
        raise OffUnavailable()
    try:
        async with _client() as c:
            r = await c.get(f"{OFF_BASE}/api/v2/product/{code}.json", params={"fields": _FIELDS})
    except httpx.HTTPError as e:
        logger.info("OFF barcode lookup failed: %r", e)
        _note_failure(key)
        raise OffUnavailable() from e
    if r.status_code == 404:
        _remember(key, {})
        return None
    if r.status_code >= 400:
        _note_failure(key)
        raise OffUnavailable()
    try:
        body = r.json()
    except ValueError as e:
        _note_failure(key)
        raise OffUnavailable() from e
    if body.get("status") not in (1, "1", "success") or not body.get("product"):
        _remember(key, {})
        return None
    food = map_product(body["product"])
    if food and not food.get("barcode"):
        food["barcode"] = code
    _remember(key, food or {})
    return food


def search_key(query: str, limit: int = 20) -> str:
    return f"s:{' '.join(query.split())[:100].lower()}:{limit}"


def is_cached(key: str) -> bool:
    return _cached(key) is not None


async def search(query: str, limit: int = 20) -> list[dict]:
    q = " ".join(query.split())[:100]
    if len(q) < 2:
        return []
    key = search_key(q, limit)
    hit = _cached(key)
    if hit is not None:
        return hit
    if _recent_failure(key):
        raise OffUnavailable()
    try:
        async with _client() as c:
            r = await c.get(
                f"{OFF_BASE}/cgi/search.pl",
                params={
                    "search_terms": q,
                    "search_simple": 1,
                    "action": "process",
                    "json": 1,
                    "page_size": max(1, min(50, limit)),
                    "fields": _FIELDS,
                },
            )
    except httpx.HTTPError as e:
        logger.info("OFF search failed: %r", e)
        _note_failure(key)
        raise OffUnavailable() from e
    if r.status_code >= 400:
        _note_failure(key)
        raise OffUnavailable()
    try:
        body = r.json()
    except ValueError as e:
        _note_failure(key)
        raise OffUnavailable() from e
    out: list[dict] = []
    seen: set[str] = set()
    for p in body.get("products") or []:
        f = map_product(p)
        if not f:
            continue
        sig = f"{f['name'].lower()}|{f['brand'].lower()}"
        if sig in seen:
            continue
        seen.add(sig)
        out.append(f)
    _remember(key, out)
    return out


# ------------------------------------------------------------------- router

router = APIRouter()


def _limited(e: RateLimited) -> HTTPException:
    wait = max(1, round(e.retry_after))
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"That's a lot of lookups. Try again in {wait} s, or add the food by hand.",
        headers={"Retry-After": str(wait)},
    )


@router.get("/off/barcode/{code}")
async def barcode_endpoint(code: str, user: User = Depends(get_current_user)) -> dict:
    try:
        clean = clean_barcode(code)
        known, _ = cached_barcode(clean)
        if not known:
            check_rate(str(user.id), "barcode")
        food = await lookup_barcode(clean)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RateLimited as e:
        raise _limited(e)
    except OffUnavailable:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Open Food Facts didn't answer. Try again, or add the food by hand.")
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That barcode isn't in Open Food Facts yet.")
    return {"food": food}


@router.get("/off/search")
async def search_endpoint(q: str = Query(min_length=1, max_length=100), user: User = Depends(get_current_user)) -> dict:
    try:
        if not is_cached(search_key(q)):
            check_rate(str(user.id), "search")
        foods = await search(q)
    except RateLimited as e:
        raise _limited(e)
    except OffUnavailable:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Open Food Facts didn't answer. Try again in a moment.")
    return {"foods": foods}


@router.get("/builtin/foods")
async def builtin_endpoint(user: User = Depends(get_current_user)) -> dict:
    from app.items.kinds.meals.foods_db import builtin_foods, categories

    return {"foods": list(builtin_foods().values()), "categories": categories()}


@router.get("/trends/{file_id}")
async def trends_endpoint(
    file_id: uuid.UUID,
    days: int = Query(default=90, ge=14, le=730),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Weight (this file's weigh-ins + the owner's Body & Health item), the
    smoothed trend and the adaptive TDEE — for the Trends tab."""
    from datetime import timedelta

    from app.items import service
    from app.items.kinds.meals import science

    try:
        row, doc, _ = await service.load(db, user, file_id)
    except service.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    if doc.kind != "meals":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    from app.items.kinds.meals.models import hydrate

    ctx = service.make_context(db, user, row.id)
    data = hydrate(doc.data or {})
    own = [(w["date"], float(w["kg"])) for w in data.get("weighins") or []]
    health: list[tuple[str, float]] = []
    health_title = None
    if row.user_id == user.id:  # only the owner's own health data, never a viewer's
        got = await service.latest_of_kind(db, user, "health")
        if got:
            health_title = got[1]
            health = science.weights_from_health(got[2])
    weights = science.merge_weights(health, own)
    since = (ctx.today - timedelta(days=days)).isoformat()
    tr = science.trend(weights)
    return {
        "weights": [{"date": d, "kg": kg} for d, kg in weights if d >= since],
        "trend": [{"date": d, "kg": kg} for d, kg in tr if d >= since],
        "health_item": health_title,
        "tdee": science.estimate_tdee(data, weights, ctx.today),
    }
