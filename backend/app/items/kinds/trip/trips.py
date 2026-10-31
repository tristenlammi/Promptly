"""Many trips in one file: finding the trip an action means, the per-trip
"view" the trip logic works on, ordering (now → upcoming → undated → past)
and archiving trips that ended.

The trip logic (``logic``, ``actions``, ``reminders``, ``text``) was written
for one trip and reads ``data["settings"]["home_currency"]``. A *view* is the
trip's own dict with a ``settings`` block added: the file's preferences with
the trip's own home currency. ``enter`` adds it in place (so an action's
changes land in the file), ``leave`` takes it off again and writes back
what changed (home currency → the trip; preferences → the file).
"""
from __future__ import annotations

import difflib
from datetime import date

from app.items.spec import ActionError

DEFAULT_SETTINGS = {"home_currency": "AUD", "passport_months": 6, "onboarded": False, "clock": "auto", "distance": "km"}
FILE_PREFS = ("passport_months", "onboarded", "clock", "distance")


# ------------------------------------------------------------------ views


def file_settings(data: dict) -> dict:
    return {**DEFAULT_SETTINGS, **(data.get("settings") or {})}


def view(data: dict, trip: dict) -> dict:
    """A read-only view of one trip (a shallow copy with ``settings``)."""
    return {**trip, "settings": {**file_settings(data), "home_currency": trip.get("home_currency") or file_settings(data)["home_currency"]}}


def enter(data: dict, trip: dict) -> dict:
    trip["settings"] = {**file_settings(data), "home_currency": trip.get("home_currency") or file_settings(data)["home_currency"]}
    return trip


def leave(data: dict, trip: dict) -> None:
    s = trip.pop("settings", None)
    if not isinstance(s, dict):
        return
    trip["home_currency"] = s.get("home_currency") or trip.get("home_currency") or "AUD"
    fs = data.setdefault("settings", dict(DEFAULT_SETTINGS))
    for k in FILE_PREFS:
        if k in s:
            fs[k] = s[k]


# --------------------------------------------------------------- ordering


def title_of(trip: dict) -> str:
    if (trip.get("title") or "").strip():
        return trip["title"].strip()
    names = [d["name"] for d in trip.get("destinations", [])[:3]]
    return " & ".join(names) if names else "Untitled trip"


def bucket(trip: dict, today: date) -> str:
    """``now`` (happening today), ``upcoming``, ``undated`` or ``past``."""
    start, end = trip.get("start"), trip.get("end") or trip.get("start")
    if trip.get("status") == "done" and (not end or date.fromisoformat(end) < today or not start):
        return "past"
    if not start:
        return "undated"
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if e < today:
        return "past"
    if s <= today:
        return "now"
    return "upcoming"


def ordered(data: dict, today: date) -> list[tuple[str, dict]]:
    """Every trip with its bucket: now, upcoming (soonest first), undated,
    past (most recent first)."""
    groups: dict[str, list[dict]] = {"now": [], "upcoming": [], "undated": [], "past": []}
    for t in data.get("trips", []):
        groups[bucket(t, today)].append(t)
    for k in ("now", "upcoming", "undated"):
        groups[k].sort(key=lambda t: (t.get("start") or "9999", title_of(t).lower()))
    groups["past"].sort(key=lambda t: t.get("end") or t.get("start") or "", reverse=True)
    return [(k, t) for k in ("now", "upcoming", "undated", "past") for t in groups[k]]


def candidates_text(data: dict, today: date) -> str:
    rows = ordered(data, today)
    out = []
    for b, t in rows[:20]:
        dates = f" {t['start']}–{t.get('end') or t['start']}" if t.get("start") else ""
        out.append(f"{title_of(t)} (id {t['id']}{dates}, {b})")
    more = f" and {len(rows) - 20} more" if len(rows) > 20 else ""
    return "; ".join(out) + more


# ---------------------------------------------------------------- resolve


def _norm(s: str) -> str:
    return " ".join((s or "").lower().replace("-", " ").replace("_", " ").split())


def find(data: dict, ref: str, today: date) -> dict:
    """The trip ``ref`` names: an id, or a title / destination (fuzzy).
    Refuses (listing the trips) when nothing or several match."""
    trips = data.get("trips", [])
    r = (ref or "").strip()
    if not trips:
        raise ActionError("There are no trips yet — create one with create_trip.")
    for t in trips:
        if t["id"] == r:
            return t
    n = _norm(r)
    exact = [t for t in trips if _norm(title_of(t)) == n]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ActionError(f"More than one trip is called {ref!r}: {_list(exact, today)}. Pass the trip's id.")
    part = [t for t in trips if n and (n in _norm(title_of(t)) or _norm(title_of(t)) in n)]
    if not part:
        part = [t for t in trips if n and any(n == _norm(d["name"]) or n in _norm(d["name"]) for d in t.get("destinations", []))]
    if not part and n:
        close = difflib.get_close_matches(n, [_norm(title_of(t)) for t in trips], n=3, cutoff=0.72)
        part = [t for t in trips if _norm(title_of(t)) in close]
    if len(part) == 1:
        return part[0]
    if len(part) > 1:
        raise ActionError(f"{ref!r} could mean {_list(part, today)}. Which one? Pass its id or exact title.")
    raise ActionError(f"No trip matches {ref!r}. Trips: {candidates_text(data, today)}.")


def _list(trips: list[dict], today: date) -> str:
    sub = {"trips": trips}
    return candidates_text(sub, today)


def default(data: dict, today: date) -> dict:
    """The trip an action means when none is named: the only one; the one
    happening now; else the only one not over yet; else the next dated one
    (when nothing undated competes). Otherwise refuse, listing them."""
    trips = data.get("trips", [])
    if not trips:
        raise ActionError("There are no trips yet — create one with create_trip.")
    if len(trips) == 1:
        return trips[0]
    rows = ordered(data, today)
    now = [t for b, t in rows if b == "now"]
    if len(now) == 1:
        return now[0]
    if len(now) > 1:
        raise ActionError(f"Several trips are happening now: {_list(now, today)}. Ask which one, then pass trip=<id>.")
    live = [(b, t) for b, t in rows if b != "past"]
    if len(live) == 1:
        return live[0][1]
    upcoming = [t for b, t in live if b == "upcoming"]
    undated = [t for b, t in live if b == "undated"]
    if upcoming and not undated and (len(upcoming) == 1 or upcoming[0].get("start") != upcoming[1].get("start")):
        return upcoming[0]
    raise ActionError(f"Which trip? This file has {len(trips)}: {candidates_text(data, today)}. "
                      "Ask the person which one they mean, then pass trip=<id>.")


def resolve(data: dict, ref: str | None, today: date) -> dict:
    return find(data, ref, today) if ref and ref.strip() else default(data, today)


# ---------------------------------------------------------------- archive


def archive(data: dict, ctx, before_day: str) -> tuple[dict, dict]:  # noqa: ANN001 — ItemContext
    """Trips that ended before ``before_day`` move to the archive file
    (whole, with their bookings, money and photos of the plan); the rest
    stay. Trips without dates, or still going, never move."""
    try:
        cut = date.fromisoformat(before_day[:10])
    except ValueError as e:
        raise ActionError(f"{before_day!r} isn't a date — use YYYY-MM-DD.") from e
    keep, old = [], []
    for t in data.get("trips", []):
        end = t.get("end") or t.get("start")
        (old if end and date.fromisoformat(end) < cut else keep).append(t)
    if not old:
        raise ActionError(f"No trips ended before {cut.isoformat()} — nothing to archive.")
    settings = dict(data.get("settings") or {})
    kept = {**data, "trips": keep}
    archived = {"trips": old, "settings": {**settings, "onboarded": True}}
    return kept, archived
