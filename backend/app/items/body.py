"""About you, once: the body details and weigh-ins that Body & Health
(``health``), Macros (``meals``) and Workout (``workout``) all ask for.

* **Profile** — sex, date of birth (or just the birth year), height and the
  weight / length units — lives on the account (``users.settings["body"]``)
  and is written into each app's own fields, so every form and every AI turn
  sees the same values. Change it in any of the three (or Account → About
  you) and the other two follow.
* **Weigh-ins** are one log: a day's weight added, changed or removed in
  Health or Macros is made in the other too, and Workout's body weight
  follows the newest one. (Workout's own body-weight field counts as
  today's weigh-in when you change it there.)

It's private: only the person's *own* app files are read or written — a
file someone shared with you is never touched, and your details never go
into a file shared with you. Archives are left as they were.

Every change is a delta (what this save changed), so a value removed in one
app isn't brought back from another. The first time someone opens one of
the apps, what's already in all three is merged once (``seed``): for each
detail, the most recently changed file wins.
"""
from __future__ import annotations

import copy
import logging
import uuid
from contextvars import ContextVar
from datetime import date, datetime, time, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.items.body")

BODY_KINDS = ("health", "meals", "workout")
PROFILE_FIELDS = ("sex", "birth_date", "birth_year", "height_cm", "weight_unit", "length_unit")
SEED_FLAG = "seeded"

# Set while this module writes the other apps, so those writes don't echo back.
_SYNCING: ContextVar[bool] = ContextVar("body_syncing", default=False)


# ------------------------------------------------------------- reading


def profile_of(kind: str, data: dict) -> dict[str, Any]:
    """The shared details one app holds (only the ones it has a field for;
    None = not set there)."""
    data = data or {}
    if kind == "health":
        p, s = data.get("profile") or {}, data.get("settings") or {}
        bd = p.get("birth_date")
        return {
            "sex": p.get("sex") if p.get("sex") in ("female", "male", "intersex") else None,
            "birth_date": bd,
            "birth_year": int(bd[:4]) if bd else None,
            "height_cm": p.get("height_cm"),
            "weight_unit": s.get("weight_unit"),
            "length_unit": s.get("length_unit"),
        }
    if kind == "meals":
        p, s = data.get("profile") or {}, data.get("settings") or {}
        return {
            "sex": p.get("sex") or None,
            "birth_year": p.get("birth_year"),
            "height_cm": p.get("height_cm"),
            "weight_unit": s.get("weight_unit"),
        }
    if kind == "workout":
        s = data.get("settings") or {}
        return {"sex": s.get("sex") or None, "birth_year": s.get("birth_year"), "weight_unit": s.get("units")}
    return {}


def weights_of(kind: str, data: dict) -> dict[str, float]:
    """Weigh-ins by day (the day's last one), in kg."""
    data = data or {}
    out: dict[str, float] = {}
    if kind == "health":
        rows = [r for r in data.get("readings") or [] if r.get("metric") == "weight" and r.get("value") is not None]
        for r in sorted(rows, key=lambda r: r.get("at") or ""):
            out[r["at"][:10]] = round(float(r["value"]), 2)
    elif kind == "meals":
        for w in data.get("weighins") or []:
            out[w["date"]] = round(float(w["kg"]), 2)
    return out


def _bodyweight(data: dict) -> float | None:
    v = (data.get("settings") or {}).get("bodyweight_kg")
    return round(float(v), 2) if v is not None else None


# ------------------------------------------------------------- writing


def apply_profile(kind: str, data: dict, prof: dict[str, Any]) -> bool:
    """Write the shared details into one app's fields (in place). Only sets
    what's known and what that app can hold. True when anything changed."""
    changed = False

    def put(block: str, key: str, value: Any) -> None:
        nonlocal changed
        if value is None:
            return
        target = data.setdefault(block, {})
        if target.get(key) != value:
            target[key] = value
            changed = True

    sex, year, cm, wu = prof.get("sex"), prof.get("birth_year"), prof.get("height_cm"), prof.get("weight_unit")
    if kind == "health":
        put("profile", "sex", sex)
        if prof.get("birth_date"):
            put("profile", "birth_date", prof["birth_date"])
        put("profile", "height_cm", cm)
        put("settings", "weight_unit", wu)
        put("settings", "length_unit", prof.get("length_unit"))
    elif kind == "meals":
        put("profile", "sex", sex if sex in ("male", "female") else None)
        put("profile", "birth_year", year)
        put("profile", "height_cm", cm if cm is None or 90 <= cm <= 250 else None)
        put("settings", "weight_unit", wu)
    elif kind == "workout":
        put("settings", "sex", sex if sex in ("male", "female") else None)
        put("settings", "birth_year", year)
        put("settings", "units", wu)
    return changed


def apply_weights(kind: str, data: dict, upserts: dict[str, float], deletes: set[str], tz: Any) -> bool:
    """Make these weigh-in changes in one app (in place)."""
    changed = False
    if kind == "meals":
        by_day = {w["date"]: w for w in data.get("weighins") or []}
        for d in deletes:
            if by_day.pop(d, None) is not None:
                changed = True
        for d, kg in upserts.items():
            if by_day.get(d, {}).get("kg") != kg:
                by_day[d] = {"date": d, "kg": kg}
                changed = True
        if changed:
            data["weighins"] = [by_day[d] for d in sorted(by_day)]
            if data["weighins"]:
                data.setdefault("profile", {})["weight_kg"] = round(float(data["weighins"][-1]["kg"]), 1)
    elif kind == "health":
        readings = list(data.get("readings") or [])
        kept = [r for r in readings if not (r.get("metric") == "weight" and (r.get("at") or "")[:10] in deletes)]
        changed = len(kept) != len(readings)
        ids = {r.get("id") for r in kept}
        for d, kg in upserts.items():
            same_day = [r for r in kept if r.get("metric") == "weight" and (r.get("at") or "")[:10] == d]
            if same_day:
                last = max(same_day, key=lambda r: r.get("at") or "")
                if last.get("value") is None or round(float(last["value"]), 2) != kg:
                    last["value"] = kg
                    changed = True
                continue
            at = datetime.combine(date.fromisoformat(d), time(8, 0), tzinfo=tz).isoformat(timespec="seconds")
            rid = "r" + uuid.uuid4().hex[:8]
            while rid in ids:
                rid = "r" + uuid.uuid4().hex[:8]
            ids.add(rid)
            kept.append({"id": rid, "metric": "weight", "at": at, "value": kg, "note": ""})
            changed = True
        if changed:
            data["readings"] = kept
    elif kind == "workout" and upserts:
        newest = upserts[max(upserts)]
        if _bodyweight(data) != newest:
            data.setdefault("settings", {})["bodyweight_kg"] = newest
            changed = True
    return changed


# ------------------------------------------------------------- the shared copy


def stored(user: User) -> dict[str, Any]:
    return dict(((user.settings or {}).get("body")) or {})


def _store(user: User, body: dict[str, Any]) -> None:
    settings = dict(user.settings or {})
    settings["body"] = body
    user.settings = settings  # a new dict, so the JSONB column is marked dirty


def merge_profile(body: dict[str, Any], changes: dict[str, Any]) -> bool:
    """Fold changed details into the shared copy. A new birth year drops a
    date of birth from another year (it can't both be right)."""
    changed = False
    for k, v in changes.items():
        if v is None or body.get(k) == v:
            continue
        body[k] = v
        changed = True
        if k == "birth_year" and body.get("birth_date") and int(body["birth_date"][:4]) != v:
            body.pop("birth_date")
        if k == "birth_date":
            body["birth_year"] = int(v[:4])
    return changed


async def _own_files(db: AsyncSession, user: User, skip: uuid.UUID | None = None):
    """The person's own app file for each of the three kinds (not archives)."""
    from app.items.service import primary_file

    out = []
    for kind in BODY_KINDS:
        found = await primary_file(db, user, kind)
        if found is not None and found[0].id != skip:
            out.append(found)
    return out


async def _write(db: AsyncSession, user: User, row, doc, data: dict) -> None:
    from app.items.service import save_data

    token = _SYNCING.set(True)
    try:
        await save_data(db, user, row, doc, data, base_revision=None, source="sync", trash_removed=False)
    except Exception:  # noqa: BLE001 — one app refusing must not break the save that started this
        logger.exception("couldn't write shared body details into %s %s", doc.kind, doc.file_id)
    finally:
        _SYNCING.reset(token)


# ------------------------------------------------------------- the hooks


async def after_save(db: AsyncSession, user: User | None, row, kind: str, before: dict, after: dict) -> None:
    """Called by ``save_data`` after one of the three apps was saved: carry
    what this save changed to the person's shared copy and their other two
    apps. Only for the owner's own file."""
    if kind not in BODY_KINDS or _SYNCING.get():
        return
    owner = user if user is not None and user.id == row.user_id else None
    if owner is None:
        return
    from app.items.service import zone_for

    if not stored(owner).get(SEED_FLAG):
        await seed(db, owner)
    old_p, new_p = profile_of(kind, before), profile_of(kind, after)
    prof_changes = {k: v for k, v in new_p.items() if v is not None and v != old_p.get(k)}
    old_w, new_w = weights_of(kind, before), weights_of(kind, after)
    upserts = {d: kg for d, kg in new_w.items() if old_w.get(d) != kg}
    deletes = set(old_w) - set(new_w)
    if kind == "workout":
        bw = _bodyweight(after)
        if bw is not None and bw != _bodyweight(before):
            upserts[datetime.now(zone_for(owner)).date().isoformat()] = bw

    body = stored(owner)
    if merge_profile(body, prof_changes):
        _store(owner, body)
    if not (prof_changes or upserts or deletes):
        return
    tz = zone_for(owner)
    for other_row, other_doc in await _own_files(db, owner, skip=row.id):
        data = copy.deepcopy(other_doc.data or {})
        touched = apply_profile(other_doc.kind, data, body)
        touched = apply_weights(other_doc.kind, data, upserts, deletes, tz) or touched
        if touched:
            await _write(db, owner, other_row, other_doc, data)


async def seed(db: AsyncSession, user: User) -> None:
    """Once per person: merge what their three apps already hold into the
    shared copy (most recently changed file wins each detail; weigh-ins are
    combined, the most recently changed file winning a day), then write the
    result back into all three."""
    from app.items.service import zone_for

    files = await _own_files(db, user)
    oldest_first = sorted(files, key=lambda fd: fd[0].modified_at or datetime.min.replace(tzinfo=timezone.utc))
    body: dict[str, Any] = stored(user)
    weights: dict[str, float] = {}
    for row, doc in oldest_first:
        merge_profile(body, {k: v for k, v in profile_of(doc.kind, doc.data or {}).items() if v is not None})
        weights.update(weights_of(doc.kind, doc.data or {}))
    body[SEED_FLAG] = True
    _store(user, body)
    tz = zone_for(user)
    for row, doc in files:
        data = copy.deepcopy(doc.data or {})
        touched = apply_profile(doc.kind, data, body)
        touched = apply_weights(doc.kind, data, dict(weights), set(), tz) or touched
        if touched:
            await _write(db, user, row, doc, data)


async def prefill(db: AsyncSession, user: User, kind: str, data: dict) -> dict:
    """A brand-new app file starts with what the person's other apps know."""
    if kind not in BODY_KINDS:
        return data
    from app.items.service import zone_for

    if not stored(user).get(SEED_FLAG):
        await seed(db, user)
    weights: dict[str, float] = {}
    for _row, doc in await _own_files(db, user):
        weights.update(weights_of(doc.kind, doc.data or {}))
    data = copy.deepcopy(data)
    apply_profile(kind, data, stored(user))
    apply_weights(kind, data, weights, set(), zone_for(user))
    return data


async def update_profile(db: AsyncSession, user: User, changes: dict[str, Any]) -> dict[str, Any]:
    """Account → About you: change the shared details and write them into
    all three apps."""
    if not stored(user).get(SEED_FLAG):
        await seed(db, user)
    body = stored(user)
    if merge_profile(body, changes):
        _store(user, body)
        for row, doc in await _own_files(db, user):
            data = copy.deepcopy(doc.data or {})
            if apply_profile(doc.kind, data, body):
                await _write(db, user, row, doc, data)
    return public(user)


def public(user: User) -> dict[str, Any]:
    body = stored(user)
    return {k: body.get(k) for k in PROFILE_FIELDS}
