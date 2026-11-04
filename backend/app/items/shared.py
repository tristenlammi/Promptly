"""Preferences the apps share, so they're set once (alongside ``body.py``,
which shares body details and weigh-ins).

* **Food** — diets, allergies and dislikes: Macros (``meals``) and Meal
  Plan (``mealplan``). Change them in either and the other follows. (Health's
  allergy list is medical — medicines too — so it isn't part of this.)
* **Currency** — the account's currency, Budget's, and Trip's default for
  new trips (each trip keeps its own). Change any one and the others follow.
* **Units** (metric / imperial) and **time format** (auto / 12h / 24h) —
  account settings. New app files start with them; changing them in
  Account updates every app. An app's own unit switch stays that app's
  choice (a cook's cups don't decide the bathroom scale), except Trip's
  12h / 24h, which is the same setting as the account's.

Kept on ``users.settings`` (``diet``, ``currency``, ``units``, ``clock``).
Only the person's own app files are written — never one shared with them.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.items import body


def _split(s: str | None) -> list[str]:
    return [p.strip() for p in (s or "").replace(";", ",").split(",") if p.strip()]


def _join(xs: list[str], limit: int = 300) -> str:
    out = ", ".join(xs)
    return out if len(out) <= limit else out[:limit].rsplit(",", 1)[0]


def _norm(xs: list[str] | None) -> list[str]:
    out: list[str] = []
    for x in xs or []:
        x = str(x).strip().lower()
        if x and x not in out:
            out.append(x)
    return out


# ------------------------------------------------------------- facets


@dataclass(frozen=True)
class Facet:
    key: str  # where it's kept on users.settings
    kinds: tuple[str, ...]
    read: Callable[[str, dict], Any]  # the value an app holds (None = not set there)
    write: Callable[[str, dict, Any], bool]  # put the value into an app's data (in place)
    two_way: bool = True  # an app's own change becomes everyone's


def _diet_read(kind: str, data: dict) -> dict | None:
    if kind == "meals":
        p = data.get("profile") or {}
        v = {"diets": _norm(p.get("diet_tags")), "allergies": _norm(_split(p.get("allergies"))), "dislikes": _norm(_split(p.get("dislikes")))}
    else:
        p = data.get("preferences") or {}
        v = {"diets": _norm(p.get("diets")), "allergies": _norm(p.get("allergies")), "dislikes": _norm(p.get("dislikes"))}
    return v if any(v.values()) else None


def _diet_write(kind: str, data: dict, v: dict) -> bool:
    if kind == "meals":
        p = data.setdefault("profile", {})
        want = {"diet_tags": v["diets"][:20], "allergies": _join(v["allergies"]), "dislikes": _join(v["dislikes"])}
    else:
        p = data.setdefault("preferences", {})
        want = {"diets": v["diets"][:12], "allergies": v["allergies"][:20], "dislikes": v["dislikes"][:40]}
    changed = any(p.get(k) != val for k, val in want.items())
    p.update(want)
    return changed


def _put(data: dict, block: str, key: str, value: Any) -> bool:
    target = data.setdefault(block, {})
    if value is None or target.get(key) == value:
        return False
    target[key] = value
    return True


def _currency_read(kind: str, data: dict) -> str | None:
    s = data.get("settings") or {}
    return (s.get("currency") if kind == "budget" else s.get("home_currency")) or None


def _currency_write(kind: str, data: dict, v: str) -> bool:
    return _put(data, "settings", "currency" if kind == "budget" else "home_currency", v)


IMPERIAL = {
    # kind: (block, key, metric value, imperial value)
    "trip": [("settings", "distance", "km", "mi")],
    "mealplan": [("preferences", "units", "metric", "imperial")],
    "health": [("settings", "temp_unit", "c", "f"), ("settings", "water_unit", "ml", "oz")],
    "meals": [("settings", "water_unit", "ml", "floz")],
}


def _units_write(kind: str, data: dict, v: str) -> bool:
    changed = False
    for block, key, metric, imperial in IMPERIAL.get(kind, []):
        changed = _put(data, block, key, imperial if v == "imperial" else metric) or changed
    return changed


def _clock_read(kind: str, data: dict) -> str | None:
    return (data.get("settings") or {}).get("clock") or None


def _clock_write(kind: str, data: dict, v: str) -> bool:
    return _put(data, "settings", "clock", v)


FACETS = (
    Facet("diet", ("meals", "mealplan"), _diet_read, _diet_write),
    Facet("currency", ("budget", "trip"), _currency_read, _currency_write),
    Facet("units", tuple(IMPERIAL), lambda k, d: None, _units_write, two_way=False),
    Facet("clock", ("trip",), _clock_read, _clock_write),
)
KINDS = {k for f in FACETS for k in f.kinds}


# ------------------------------------------------------------- plumbing


def _settings(user: User) -> dict:
    return dict(user.settings or {})


def _set(user: User, key: str, value: Any) -> None:
    s = _settings(user)
    s[key] = value
    user.settings = s  # a new dict, so the JSONB column is marked dirty


async def _own(db: AsyncSession, user: User, kinds: tuple[str, ...], skip=None):
    from app.items.service import primary_file

    out = []
    for kind in kinds:
        found = await primary_file(db, user, kind)
        if found is not None and found[0].id != skip:
            out.append(found)
    return out


async def _push(db: AsyncSession, user: User, facet: Facet, value: Any, skip=None) -> None:
    for row, doc in await _own(db, user, facet.kinds, skip=skip):
        data = copy.deepcopy(doc.data or {})
        if facet.write(doc.kind, data, value):
            await body._write(db, user, row, doc, data)


# ------------------------------------------------------------- the hooks


async def after_save(db: AsyncSession, user: User | None, row, kind: str, before: dict, after: dict) -> None:
    """Called by ``save_data``: an app's own change to a shared preference
    becomes the account's, and the person's other apps follow."""
    if kind not in KINDS or body._SYNCING.get():
        return
    if user is None or user.id != row.user_id:
        return
    for facet in FACETS:
        if not facet.two_way or kind not in facet.kinds:
            continue
        new = facet.read(kind, after or {})
        if new is None or new == facet.read(kind, before or {}):
            continue
        if _settings(user).get(facet.key) != new:
            _set(user, facet.key, new)
        await _push(db, user, facet, new, skip=row.id)


async def prefill(user: User, kind: str, data: dict) -> dict:
    """A new app file starts with the account's shared preferences."""
    if kind not in KINDS:
        return data
    data = copy.deepcopy(data)
    s = _settings(user)
    for facet in FACETS:
        if kind in facet.kinds and s.get(facet.key):
            facet.write(kind, data, s[facet.key])
    return data


async def account_changed(db: AsyncSession, user: User, keys: set[str]) -> None:
    """Account → About you changed currency, units or time format: write it
    into every app. Units also set the shared body units (kg/lb, cm/in)."""
    s = _settings(user)
    for facet in FACETS:
        if facet.key in keys and s.get(facet.key):
            await _push(db, user, facet, s[facet.key])
    if "units" in keys and s.get("units") in ("metric", "imperial"):
        imperial = s["units"] == "imperial"
        await body.update_profile(db, user, {"weight_unit": "lb" if imperial else "kg", "length_unit": "in" if imperial else "cm"})


SEED_FLAG = "shared_seeded"


async def seed(db: AsyncSession, user: User) -> None:
    """Once per person, for what they set before the apps shared it: an app
    that has nothing yet takes the newest value another app has (nothing
    already set is overwritten), and an empty account setting takes it too."""
    from datetime import datetime, timezone

    s = _settings(user)
    for facet in FACETS:
        if not facet.two_way:
            continue
        files = await _own(db, user, facet.kinds)
        held = [(row, doc, facet.read(doc.kind, doc.data or {})) for row, doc in files]
        have = [h for h in held if h[2] is not None]
        if not have:
            continue
        newest = max(have, key=lambda h: h[0].modified_at or datetime.min.replace(tzinfo=timezone.utc))[2]
        if not s.get(facet.key):
            _set(user, facet.key, newest)
        for row, doc, value in held:
            if value is None:
                data = copy.deepcopy(doc.data or {})
                if facet.write(doc.kind, data, newest):
                    await body._write(db, user, row, doc, data)
    _set(user, SEED_FLAG, True)
