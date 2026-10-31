"""The trip's actions — the AI's (and the UI's) hands.

Deterministic for (data, args, ctx.now): ids come from the inputs (a slug
plus a counter), never from randomness, so the AI's writes replay cleanly
on a newer state. Money arguments are in **major units** ("cost": 1234.5)
and stored as minor units; times are local wall times with an IANA zone.
"""
from __future__ import annotations

import copy
import dataclasses
import functools
import hashlib
import re
from contextvars import ContextVar
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, create_model

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext, SafeUrl

from . import logic, trips
from .airports import airport
from .models import (
    MAX_TRIPS,
    BookingStatus,
    BookingType,
    Category,
    DocStatus,
    DocType,
    PlanStatus,
    PlanType,
    Priority,
    SplitMode,
    Trip,
    TripStatus,
    normalize_local,
    valid_zone,
)
from .packing import TEMPLATE_NAMES, TEMPLATES
from .timeutil import booking_duration, exponent, fmt_duration, fmt_money, in_gap, rate_for, to_home, to_minor

# ------------------------------------------------------------------ helpers

# The Promptly user an action runs for: "me" / "I" is *their* traveller,
# not the file owner's (a shared trip has one "me" per companion).
_ACTING: ContextVar[str | None] = ContextVar("trip_acting_user", default=None)


def _acting(fn):  # noqa: ANN001, ANN202
    @functools.wraps(fn)
    def run(ctx: ItemContext, data: dict, p):  # noqa: ANN001
        uid = getattr(getattr(ctx, "user", None), "id", None)
        token = _ACTING.set(str(uid) if uid else None)
        try:
            return fn(ctx, data, p)
        finally:
            _ACTING.reset(token)

    return run


def _me(data: dict) -> str | None:
    return logic.me_id(data, _ACTING.get())



def _slug(text: str, n: int = 18) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:n].strip("-")
    return s or "x"


def _new_id(prefix: str, seed: str, taken: set[str]) -> str:
    base = f"{prefix}-{_slug(seed)}"
    cid, n = base, 2
    while cid in taken:
        cid, n = f"{base}-{n}", n + 1
    taken.add(cid)
    return cid


def _all_item_ids(data: dict) -> set[str]:
    return {i["id"] for d in data["days"] for i in d["items"]}


def _day(v: str | None, ctx: ItemContext, data: dict | None = None) -> str:
    """A calendar day from "2027-04-02", "today", "tomorrow" or "day 3"."""
    s = (v or "").strip().lower()
    if not s or s == "today":
        return ctx.today.isoformat()
    if s == "tomorrow":
        from datetime import timedelta

        return (ctx.today + timedelta(days=1)).isoformat()
    m = re.fullmatch(r"day\s*(\d{1,3})", s)
    if m and data is not None and data.get("start"):
        from datetime import timedelta

        return (date.fromisoformat(data["start"]) + timedelta(days=int(m.group(1)) - 1)).isoformat()
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError as e:
        raise ActionError(f"{v!r} isn't a date — use YYYY-MM-DD.") from e


def _who(data: dict, ref: str | None, *, allow_none: bool = True) -> str | None:
    """A traveller id from an id or a (first) name."""
    if ref is None or str(ref).strip() == "":
        if allow_none:
            return None
        raise ActionError("Say which traveller.")
    r = str(ref).strip().lower()
    ts = data["travellers"]
    if r in ("me", "i", "myself", "mine"):
        mine = _me(data)
        if mine:
            return mine
        names = ", ".join(t["name"] for t in ts) or "none yet"
        raise ActionError(f"I don't know which traveller you are on this trip (travellers: {names}). "
                          "Ask, then call set_trip_details with i_am=<their name>.")
    for t in ts:
        if t["id"].lower() == r:
            return t["id"]
    for t in ts:
        if t["name"].lower() == r:
            return t["id"]
    hits = [t for t in ts if t["name"].lower().split()[0] == r or t["name"].lower().startswith(r)]
    if len(hits) == 1:
        return hits[0]["id"]
    names = ", ".join(t["name"] for t in ts) or "none yet"
    raise ActionError(f"No traveller called {ref!r} (travellers: {names}). Add them with set_trip_details first.")


def _cur(data: dict, code: str | None) -> str:
    home = data["settings"]["home_currency"]
    c = (code or home).strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", c):
        raise ActionError(f"{code!r} isn't a currency code — use ISO codes like JPY.")
    return c


def _local(value: str | None, tz: str | None) -> str | None:
    """A local wall time from the model. If it carries an offset and the zone
    is known, it's converted into that zone first."""
    if value is None or str(value).strip() == "":
        return None
    s = str(value).strip().replace(" ", "T")
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise ActionError(f"{value!r} isn't a date-time — use YYYY-MM-DDTHH:MM (local time).") from e
    if dt.tzinfo is not None and tz:
        dt = dt.astimezone(ZoneInfo(tz))
    return normalize_local(dt)


def _zone(v: str | None) -> str:
    try:
        return valid_zone(v)
    except ValueError as e:
        raise ActionError(str(e)) from e


def _hhmm(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in ("", "anytime", "any", "none", "-"):
        return None
    m = re.fullmatch(r"(\d{1,2})(?::|\.|h)?(\d{2})?\s*(am|pm)?", s)
    if not m:
        raise ActionError(f"{v!r} isn't a time — use HH:MM.")
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    if h > 23 or mi > 59:
        raise ActionError(f"{v!r} isn't a time — use HH:MM.")
    return f"{h:02d}:{mi:02d}"


def _money(data: dict, amount: float | None, currency: str | None) -> tuple[int | None, str | None]:
    if amount is None:
        return None, None
    cur = _cur(data, currency)
    return to_minor(amount, cur), (None if cur == data["settings"]["home_currency"] and currency is None else cur)


def _find_booking(data: dict, bid: str) -> dict:
    b = next((b for b in data["bookings"] if b["id"] == bid), None)
    if b is None:
        raise ActionError(f"No booking with id {bid!r}.")
    return b


def _find_item(data: dict, iid: str) -> tuple[dict, dict]:
    for d in data["days"]:
        for it in d["items"]:
            if it["id"] == iid:
                return d, it
    raise ActionError(f"No itinerary item with id {iid!r}.")


def _ensure_day(data: dict, day: str) -> dict:
    for d in data["days"]:
        if d["date"] == day:
            return d
    d = {"date": day, "title": "", "notes": "", "tz": "", "items": []}
    data["days"].append(d)
    data["days"].sort(key=lambda x: x["date"])
    return d


def _insert_by_time(items: list[dict], item: dict, index: int | None = None) -> None:
    if index is not None:
        items.insert(max(0, min(index, len(items))), item)
        return
    t = item.get("time")
    if t:
        for i, other in enumerate(items):
            if other.get("time") and other["time"] > t:
                items.insert(i, item)
                return
    items.append(item)


def _check_day_room(d: dict, adding: int = 1) -> None:
    if len(d["items"]) + adding > 40:
        raise ActionError(f"{d['date']} can hold 40 items at most.")


def _outside(data: dict, day: str) -> bool:
    s, e = data.get("start"), data.get("end") or data.get("start")
    return bool(s) and (day < s or day > e)


# ------------------------------------------------------- set_trip_details


class DestinationIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, description="City or region")
    country: str = Field(default="", max_length=60)
    tz: str = Field(default="", description="IANA time zone, e.g. Asia/Tokyo — always set it")
    start: str | None = Field(default=None, description="Arrive (YYYY-MM-DD)")
    end: str | None = Field(default=None, description="Leave (YYYY-MM-DD)")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    notes: str = Field(default="", max_length=2000)


class TravellerIn(BaseModel):
    id: str | None = Field(default=None, max_length=48, description="Existing traveller id (keeps their expenses when renaming)")
    name: str = Field(min_length=1, max_length=60)
    is_me: bool = Field(default=False, description="This traveller is the person you're talking with")
    age_group: Literal["adult", "child", "infant"] = "adult"
    passport_country: str = Field(default="", max_length=60)


class RenameIn(BaseModel):
    traveller: str = Field(description="Current name or id")
    name: str = Field(min_length=1, max_length=60, description="New name")


class SetTripDetails(BaseModel):
    title: str | None = Field(default=None, max_length=120, description="Display title (the file name is used when blank)")
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, description="Hex cover colour like #2C9CC8")
    start: str | None = Field(default=None, description="First day YYYY-MM-DD")
    end: str | None = Field(default=None, description="Last day (the day you get home) YYYY-MM-DD")
    status: TripStatus | None = None
    notes: str | None = Field(default=None, max_length=5000, description="Replaces the trip notes")
    home_currency: str | None = Field(default=None, description="ISO code; exchange rates are re-based")
    passport_months: int | None = Field(default=None, ge=0, le=12, description="Passport validity needed beyond return")
    destinations: list[DestinationIn] | None = Field(default=None, max_length=40, description="Replaces the whole list (matched by name, ids kept)")
    add_destinations: list[DestinationIn] | None = Field(default=None, max_length=40)
    travellers: list[TravellerIn] | None = Field(
        default=None, max_length=20,
        description="Replaces the whole list (matched by id, then name; ids kept). Anyone left out is removed; "
                    "if they have expenses or repayments, give reassign_to",
    )
    add_travellers: list[TravellerIn] | None = Field(default=None, max_length=20)
    rename_travellers: list[RenameIn] | None = Field(default=None, max_length=20, description="Rename people, keeping their expenses")
    remove_travellers: list[str] | None = Field(default=None, max_length=20, description="Names or ids to take off the trip")
    reassign_to: str | None = Field(default=None, description="Who takes over removed travellers' expenses and repayments (name or id)")
    i_am: str | None = Field(default=None, description="Which traveller the person you're talking with is (name or id); sets their 'me'")


def _dest_dict(ctx: ItemContext, data: dict, d: DestinationIn, taken: set[str], keep: dict | None) -> dict:
    out = {
        "id": keep["id"] if keep else _new_id("d", d.name, taken),
        "name": d.name.strip(), "country": d.country.strip(), "tz": _zone(d.tz),
        "start": _day(d.start, ctx, data) if d.start else None,
        "end": _day(d.end, ctx, data) if d.end else None,
        "lat": d.lat, "lng": d.lng, "notes": d.notes,
    }
    if keep:
        for k in ("lat", "lng", "notes", "tz", "country"):
            if not out[k] and keep.get(k):
                out[k] = keep[k]
    return out


def _traveller_dict(t: TravellerIn, taken: set[str], keep: dict | None) -> dict:
    return {
        "id": keep["id"] if keep else _new_id("t", t.name, taken),
        "name": t.name.strip(), "is_me": bool(keep and keep.get("is_me")),
        "user_id": (keep or {}).get("user_id", ""),
        "age_group": t.age_group, "passport_country": t.passport_country or (keep or {}).get("passport_country", ""),
    }


def _drop_travellers(data: dict, gone: list[str], reassign: str | None) -> None:
    """Remove travellers; refuse (changing nothing) when one still has money
    history and there's no one to hand it to."""
    names = logic.traveller_names(data)
    if reassign and reassign in gone:
        raise ActionError(f"Can't hand {names.get(reassign, reassign)}'s expenses to someone who's being removed.")
    if not reassign:
        busy = []
        for tid in gone:
            r = logic.traveller_refs(data, tid)
            if r["expenses"] or r["settlements"]:
                busy.append(f"{names.get(tid, tid)} ({r['expenses']} expense{'s' if r['expenses'] != 1 else ''}, "
                            f"{r['settlements']} repayment{'s' if r['settlements'] != 1 else ''})")
        if busy:
            raise ActionError(f"Removing {', '.join(busy)} would lose who paid what. Give reassign_to (who takes them over), "
                              "or rename them instead.")
    for tid in gone:
        logic.remove_traveller(data, tid, reassign)


def set_trip_details(ctx: ItemContext, data: dict, p: SetTripDetails) -> ActionOutcome:
    changed = []
    for k in ("title", "emoji", "notes", "status"):
        v = getattr(p, k)
        if v is not None:
            data[k] = v
            changed.append(k)
    if p.color is not None:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", p.color.strip()):
            raise ActionError("Colour must be a hex like #2C9CC8.")
        data["color"] = p.color.strip().upper()
        changed.append("colour")
    if p.start is not None:
        data["start"] = _day(p.start, ctx, data)
        changed.append("start")
    if p.end is not None:
        data["end"] = _day(p.end, ctx, data)
        changed.append("end")
    if data.get("start") and data.get("end") and data["end"] < data["start"]:
        raise ActionError("The trip ends before it starts.")
    if p.passport_months is not None:
        data["settings"]["passport_months"] = p.passport_months
    if p.home_currency is not None:
        new = _cur(data, p.home_currency)
        if new != data["settings"]["home_currency"]:
            refusal = logic.rebase_home(data, new, ctx.today.isoformat())
            if refusal:
                raise ActionError(refusal)
            changed.append("home currency")
    if p.destinations is not None:
        taken = {x["id"] for x in data["destinations"]}
        by_name = {d["name"].lower(): d for d in data["destinations"]}
        data["destinations"] = [_dest_dict(ctx, data, d, taken, by_name.get(d.name.lower())) for d in p.destinations]
        changed.append("destinations")
    if p.add_destinations:
        taken = {d["id"] for d in data["destinations"]}
        for d in p.add_destinations:
            same = next((x for x in data["destinations"] if x["name"].lower() == d.name.lower()), None)
            new = _dest_dict(ctx, data, d, taken, same)
            if same:
                same.update(new)
            else:
                data["destinations"].append(new)
        changed.append("destinations")
    claim: str | None = None
    if p.rename_travellers:
        for rn in p.rename_travellers:
            tid = _who(data, rn.traveller, allow_none=False)
            if any(t["name"].lower() == rn.name.strip().lower() and t["id"] != tid for t in data["travellers"]):
                raise ActionError(f"There's already a traveller called {rn.name.strip()!r}.")
            next(t for t in data["travellers"] if t["id"] == tid)["name"] = rn.name.strip()
        changed.append("travellers")
    if p.travellers is not None:
        if not p.travellers:
            raise ActionError("A trip needs at least one traveller.")
        by_id = {t["id"]: t for t in data["travellers"]}
        by_name = {t["name"].lower(): t for t in data["travellers"]}
        taken = set(by_id)
        new_list, used = [], set()
        for t in p.travellers:
            keep = by_id.get(t.id or "") or by_name.get(t.name.strip().lower())
            if keep is not None and keep["id"] in used:
                keep = None
            row = _traveller_dict(t, taken, keep)
            used.add(row["id"])
            new_list.append(row)
            if t.is_me:
                claim = row["id"]
        # New people first (so expenses can move to them), then the removals.
        data["travellers"] = [*data["travellers"], *(r for r in new_list if r["id"] not in by_id)]
        reassign = _who(data, p.reassign_to) if p.reassign_to else None
        if reassign and reassign not in used:
            raise ActionError("reassign_to must be someone staying on the trip.")
        _drop_travellers(data, [tid for tid in by_id if tid not in used], reassign)
        data["travellers"] = new_list
        changed.append("travellers")
    if p.add_travellers:
        taken = {t["id"] for t in data["travellers"]}
        for t in p.add_travellers:
            same = next((x for x in data["travellers"] if x["name"].lower() == t.name.strip().lower()), None)
            if same is None:
                same = _traveller_dict(t, taken, None)
                data["travellers"].append(same)
            if t.is_me:
                claim = same["id"]
        changed.append("travellers")
    if p.remove_travellers:
        gone = list(dict.fromkeys(_who(data, r, allow_none=False) for r in p.remove_travellers))
        if len(gone) >= len(data["travellers"]):
            raise ActionError("A trip needs at least one traveller.")
        _drop_travellers(data, gone, _who(data, p.reassign_to) if p.reassign_to else None)  # type: ignore[arg-type]
        changed.append("travellers")
    if p.i_am:
        claim = _who(data, p.i_am, allow_none=False)
    if claim:
        uid = _ACTING.get()
        if not uid:
            raise ActionError("Can't tell who you are here.")
        logic.claim_me(data, uid, claim)
        changed.append("you")
    if len(data["travellers"]) > 20 or len(data["destinations"]) > 40:
        raise ActionError("That's more travellers or destinations than a trip can hold.")
    data["settings"]["onboarded"] = True
    if not changed:
        raise ActionError("Nothing to change.")
    return ActionOutcome(summary=f"Updated the trip ({', '.join(dict.fromkeys(changed))})",
                         result={"destinations": [{"id": d["id"], "name": d["name"]} for d in data["destinations"]],
                                 "travellers": [{"id": t["id"], "name": t["name"]} for t in data["travellers"]]})


# ---------------------------------------------------------------- bookings


class AttachmentIn(BaseModel):
    file_id: str = Field(min_length=1, max_length=64, description="Drive file id from find_my_files")
    name: str = Field(default="", max_length=200)


class BookingFields(BaseModel):
    type: BookingType | None = None
    title: str | None = Field(default=None, max_length=160, description="Hotel name, tour name… (flights can leave it blank)")
    status: BookingStatus | None = None
    start: str | None = Field(default=None, description="Departure / check-in / pick-up, LOCAL wall time at that place: YYYY-MM-DDTHH:MM")
    start_tz: str | None = Field(default=None, description="IANA zone of the start place (Australia/Sydney). Filled from from_code for known airports")
    end: str | None = Field(default=None, description="Arrival / check-out / drop-off, LOCAL wall time at that place")
    end_tz: str | None = Field(default=None, description="IANA zone of the end place (Asia/Tokyo)")
    provider: str | None = Field(default=None, max_length=80, description="Airline, hotel brand, rental company, operator")
    number: str | None = Field(default=None, max_length=24, description="Flight / train number, e.g. QF25")
    from_code: str | None = Field(default=None, max_length=4, description="Departure airport IATA code")
    to_code: str | None = Field(default=None, max_length=4, description="Arrival airport IATA code")
    from_place: str | None = Field(default=None, max_length=120, description="Departure airport/station/pick-up name")
    to_place: str | None = Field(default=None, max_length=120)
    terminal_from: str | None = Field(default=None, max_length=20)
    terminal_to: str | None = Field(default=None, max_length=20)
    seat: str | None = Field(default=None, max_length=40)
    cabin: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=240)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    confirmation: str | None = Field(default=None, max_length=60, description="Booking reference / PNR")
    cost: float | None = Field(default=None, ge=0, description="Total cost in major units (1234.50)")
    currency: str | None = Field(default=None, description="ISO code of the cost; default the home currency")
    paid: bool | None = None
    travellers: list[str] | None = Field(default=None, max_length=20, description="Traveller names or ids; empty = everyone")
    attachments: list[AttachmentIn] | None = Field(default=None, max_length=20)
    link: SafeUrl | None = Field(default=None, max_length=520)
    phone: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=4000)


class BookingIn(BookingFields):
    type: BookingType = Field(description="flight, stay, car, train, bus, ferry, tour, ticket, insurance, other")


class AddBookings(BaseModel):
    bookings: list[BookingIn] = Field(min_length=1, max_length=30, description="One entry per flight leg / stay / ticket")


_PLAIN = ("title", "status", "provider", "number", "from_place", "to_place", "terminal_from", "terminal_to", "seat",
          "cabin", "address", "lat", "lng", "confirmation", "paid", "link", "phone", "notes", "type")


def _apply_booking(data: dict, b: dict, f: BookingFields, warnings: list[str]) -> None:
    given = f.model_fields_set
    for k in _PLAIN:
        if k in given and getattr(f, k) is not None:
            b[k] = getattr(f, k)
    for k in ("from_code", "to_code"):
        if k in given and getattr(f, k) is not None:
            b[k] = getattr(f, k).strip().upper()
    # Zones: given, else from the airport, else what's there.
    for edge, code_key, place_key in (("start", "from_code", "from_place"), ("end", "to_code", "to_place")):
        tz_key = f"{edge}_tz"
        if f"{edge}_tz" in given and getattr(f, tz_key) is not None:
            b[tz_key] = _zone(getattr(f, tz_key))
        ap = airport(b.get(code_key))
        if ap:
            if not b.get(tz_key):
                b[tz_key] = ap[2]
            if not b.get(place_key):
                b[place_key] = ap[0]
    if b["type"] == "stay":
        b["end_tz"] = b.get("end_tz") or b.get("start_tz") or ""
        b["start_tz"] = b.get("start_tz") or b.get("end_tz") or ""
    elif b["type"] not in ("flight",) and not b.get("end_tz") and b.get("start_tz"):
        b["end_tz"] = b["start_tz"]
    for edge in ("start", "end"):
        if edge in given:
            b[edge] = _local(getattr(f, edge), b.get(f"{edge}_tz"))
    if not b.get("start_tz") and b.get("start"):
        guess = logic.day_zone(data, b["start"][:10])
        if guess and b["type"] != "flight":
            b["start_tz"] = guess
            b["end_tz"] = b.get("end_tz") or guess
    if "cost" in given or "currency" in given:
        if f.cost is not None:
            cur = _cur(data, f.currency or b.get("currency"))
            b["cost_minor"] = to_minor(f.cost, cur)
            b["currency"] = cur
        elif f.currency is not None:
            b["currency"] = _cur(data, f.currency)
    if "travellers" in given and f.travellers is not None:
        b["traveller_ids"] = [x for x in (_who(data, r) for r in f.travellers) if x]
    if "attachments" in given and f.attachments is not None:
        have = {a["file_id"] for a in b.get("attachments", [])}
        for a in f.attachments:
            if a.file_id not in have:
                b.setdefault("attachments", []).append({"file_id": a.file_id, "name": a.name})
                have.add(a.file_id)
    label = logic.booking_label(b)
    if b["type"] == "flight" and b.get("start") and not (b.get("start_tz") and (b.get("end_tz") or not b.get("end"))):
        warnings.append(f"{label}: time zone unknown — set start_tz/end_tz (IANA).")
    for edge in ("start", "end"):
        if b.get(edge) and b.get(f"{edge}_tz") and in_gap(b[edge], b[f"{edge}_tz"]):
            warnings.append(f"{label}: {b[edge]} doesn't exist in {b[f'{edge}_tz']} (clock change) — check the time.")
    if b.get("start") and b.get("end"):
        d = booking_duration(b)
        if d is not None and d.total_seconds() < 0:
            warnings.append(f"{label}: ends before it starts — check dates/zones.")


def _booking_view(b: dict) -> dict:
    out = {"id": b["id"], "label": logic.booking_label(b), "start": b.get("start"), "start_tz": b.get("start_tz"),
           "end": b.get("end"), "end_tz": b.get("end_tz")}
    d = booking_duration(b)
    if d is not None and b["type"] in ("flight", "train", "bus", "ferry"):
        out["duration"] = fmt_duration(d)
    return out


def add_bookings(ctx: ItemContext, data: dict, p: AddBookings) -> ActionOutcome:
    taken = {b["id"] for b in data["bookings"]}
    added, updated, warnings = [], [], []
    for f in p.bookings:
        start_norm = None
        try:
            start_norm = _local(f.start, f.start_tz or (airport(f.from_code)[2] if airport(f.from_code) else None)) if f.start else None
        except ActionError:
            start_norm = None
        same = None
        for b in data["bookings"]:
            if b["type"] != f.type or not start_norm or b.get("start") != start_norm:
                continue
            if (f.confirmation and b.get("confirmation") == f.confirmation) or (f.number and b.get("number") == f.number.strip()) or (
                f.title and b.get("title") == f.title
            ):
                same = b
                break
        if same is not None:
            _apply_booking(data, same, f, warnings)
            updated.append(_booking_view(same))
            continue
        if len(data["bookings"]) >= 300:
            raise ActionError("This trip already holds 300 bookings.")
        seed = " ".join(x for x in (f.number or "", f.from_code or "", f.to_code or "") if x) or f.title or f.provider or f.type
        b = {"id": _new_id("b", seed, taken), "type": f.type, "title": "", "status": "confirmed", "start": None, "start_tz": "",
             "end": None, "end_tz": "", "provider": "", "number": "", "from_code": "", "to_code": "", "from_place": "",
             "to_place": "", "terminal_from": "", "terminal_to": "", "seat": "", "cabin": "", "address": "", "lat": None,
             "lng": None, "confirmation": "", "cost_minor": None, "currency": None, "paid": True, "traveller_ids": [],
             "attachments": [], "link": "", "phone": "", "notes": ""}
        _apply_booking(data, b, f, warnings)
        data["bookings"].append(b)
        added.append(_booking_view(b))
    data["bookings"].sort(key=lambda b: (b.get("start") or "9999", b["id"]))
    bits = []
    if added:
        bits.append(f"Added {len(added)} booking{'s' if len(added) != 1 else ''}")
    if updated:
        bits.append(f"updated {len(updated)} already there")
    summary = ", ".join(bits) or "No bookings changed"
    return ActionOutcome(summary=summary[0].upper() + summary[1:], result={"added": added, "updated": updated, "warnings": warnings})


class UpdateBooking(BookingFields):
    id: str = Field(description="Booking id")


def update_booking(ctx: ItemContext, data: dict, p: UpdateBooking) -> ActionOutcome:
    b = _find_booking(data, p.id)
    warnings: list[str] = []
    fields = BookingFields.model_validate(p.model_dump(exclude={"id", "trip"}, exclude_unset=True))
    if not fields.model_fields_set:
        raise ActionError("Nothing to change.")
    _apply_booking(data, b, fields, warnings)
    data["bookings"].sort(key=lambda x: (x.get("start") or "9999", x["id"]))
    return ActionOutcome(summary=f"Updated {logic.booking_label(b)}", result={**_booking_view(b), "warnings": warnings})


class Ids(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


def delete_bookings(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    gone = [b for b in data["bookings"] if b["id"] in p.ids]
    if not gone:
        raise ActionError("None of those bookings exist.")
    ids = {b["id"] for b in gone}
    data["bookings"] = [b for b in data["bookings"] if b["id"] not in ids]
    for d in data["days"]:
        for it in d["items"]:
            if it.get("booking_id") in ids:
                it["booking_id"] = None
    for e in data["expenses"]:
        if e.get("booking_id") in ids:
            e["booking_id"] = None
    names = ", ".join(logic.booking_label(b) for b in gone[:3])
    return ActionOutcome(summary=f"Deleted {names}{'…' if len(gone) > 3 else ''}", result={"deleted": sorted(ids)})


# --------------------------------------------------------------- itinerary


class PlanItemIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    time: str | None = Field(default=None, description="Local HH:MM, or omit / 'anytime'")
    duration_min: int | None = Field(default=None, ge=0, le=4320)
    type: PlanType = "activity"
    place: str = Field(default="", max_length=120)
    address: str = Field(default="", max_length=240)
    area: str = Field(default="", max_length=80, description="Neighbourhood, e.g. Higashiyama")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    cost: float | None = Field(default=None, ge=0, description="Per-group cost estimate, major units")
    currency: str | None = None
    link: SafeUrl = Field(default="", max_length=520)
    status: PlanStatus = "planned"
    notes: str = Field(default="", max_length=2000, description="Tips: opening hours, book ahead, what to order…")
    booking_id: str | None = Field(default=None, description="Link to a booking")
    travel_after: str = Field(default="", max_length=120, description="Getting to the next item, e.g. '15 min walk'")


class DayPlan(BaseModel):
    date: str = Field(description="YYYY-MM-DD (or 'day 3')")
    title: str | None = Field(default=None, max_length=120, description="Theme, e.g. 'Kyoto temples'")
    notes: str | None = Field(default=None, max_length=2000)
    tz: str | None = Field(default=None, description="IANA zone you're in that day, if not clear from destinations/stays")
    replace: bool = Field(default=False, description="Drop the day's idea/planned items first (booked/done stay)")
    items: list[PlanItemIn] = Field(default_factory=list, max_length=25)


class PlanDays(BaseModel):
    days: list[DayPlan] = Field(min_length=1, max_length=45)


def _plan_item(data: dict, it: PlanItemIn, taken: set[str], day: str) -> dict:
    cost, cur = _money(data, it.cost, it.currency)
    if it.booking_id and not any(b["id"] == it.booking_id for b in data["bookings"]):
        raise ActionError(f"No booking with id {it.booking_id!r}.")
    return {
        "id": _new_id("i", f"{day[5:]} {it.title}", taken), "time": _hhmm(it.time), "duration_min": it.duration_min,
        "type": it.type, "title": it.title.strip(), "place": it.place, "address": it.address, "area": it.area,
        "lat": it.lat, "lng": it.lng, "cost_minor": cost, "currency": cur, "link": it.link, "status": it.status,
        "notes": it.notes, "booking_id": it.booking_id, "travel_after": it.travel_after,
    }


def plan_days(ctx: ItemContext, data: dict, p: PlanDays) -> ActionOutcome:
    taken = _all_item_ids(data)
    added, warnings, touched = 0, [], []
    for dp in p.days:
        day = _day(dp.date, ctx, data)
        d = _ensure_day(data, day)
        if dp.title is not None:
            d["title"] = dp.title
        if dp.notes is not None:
            d["notes"] = dp.notes
        if dp.tz is not None:
            d["tz"] = _zone(dp.tz)
        if dp.replace:
            d["items"] = [i for i in d["items"] if i.get("status") in ("booked", "done")]
        _check_day_room(d, len(dp.items))
        for it in dp.items:
            _insert_by_time(d["items"], _plan_item(data, it, taken, day))
            added += 1
        if _outside(data, day):
            warnings.append(f"{day} is outside the trip dates.")
        touched.append(day)
    n = len(touched)
    return ActionOutcome(
        summary=f"Planned {added} item{'s' if added != 1 else ''} across {n} day{'s' if n != 1 else ''}",
        result={"days": [logic.itinerary_for(data, d, ctx.tz) for d in touched[:10]], "warnings": warnings},
    )


class PlanItemPatch(BaseModel):
    id: str
    title: str | None = Field(default=None, max_length=160)
    time: str | None = Field(default=None, description="HH:MM or 'anytime'")
    duration_min: int | None = Field(default=None, ge=0, le=4320)
    type: PlanType | None = None
    place: str | None = Field(default=None, max_length=120)
    address: str | None = Field(default=None, max_length=240)
    area: str | None = Field(default=None, max_length=80)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    cost: float | None = Field(default=None, ge=0)
    currency: str | None = None
    link: SafeUrl | None = Field(default=None, max_length=520)
    status: PlanStatus | None = None
    notes: str | None = Field(default=None, max_length=2000)
    booking_id: str | None = None
    travel_after: str | None = Field(default=None, max_length=120)


class UpdatePlanItems(BaseModel):
    items: list[PlanItemPatch] = Field(min_length=1, max_length=60)


def update_plan_items(ctx: ItemContext, data: dict, p: UpdatePlanItems) -> ActionOutcome:
    for patch in p.items:
        _d, it = _find_item(data, patch.id)
        given = patch.model_fields_set - {"id"}
        for k in given:
            v = getattr(patch, k)
            if k == "time":
                it["time"] = _hhmm(v)
            elif k in ("cost", "currency"):
                continue
            elif v is not None or k in ("booking_id", "lat", "lng", "duration_min"):
                it[k] = v
        if "cost" in given:
            if patch.cost is None:
                it["cost_minor"], it["currency"] = None, None
            else:
                cur = _cur(data, patch.currency or it.get("currency"))
                it["cost_minor"], it["currency"] = to_minor(patch.cost, cur), cur
        elif "currency" in given and patch.currency:
            it["currency"] = _cur(data, patch.currency)
    n = len(p.items)
    return ActionOutcome(summary=f"Updated {n} itinerary item{'s' if n != 1 else ''}")


class Move(BaseModel):
    item_id: str
    to_date: str = Field(description="YYYY-MM-DD")
    index: int | None = Field(default=None, ge=0, le=40, description="Position in that day (0 = first); default by time")
    time: str | None = Field(default=None, description="New HH:MM, or 'anytime'; omit to keep")


class MoveItems(BaseModel):
    moves: list[Move] = Field(min_length=1, max_length=60)


def move_items(ctx: ItemContext, data: dict, p: MoveItems) -> ActionOutcome:
    for m in p.moves:
        src, it = _find_item(data, m.item_id)
        src["items"].remove(it)
        if "time" in m.model_fields_set:
            it["time"] = _hhmm(m.time)
        dst = _ensure_day(data, _day(m.to_date, ctx, data))
        _check_day_room(dst)
        _insert_by_time(dst["items"], it, m.index)
    n = len(p.moves)
    return ActionOutcome(summary=f"Moved {n} item{'s' if n != 1 else ''}")


class ReorderDay(BaseModel):
    date: str
    item_ids: list[str] = Field(min_length=1, max_length=40, description="The new order (unlisted items follow)")
    sort_by_time: bool = Field(default=False, description="Ignore item_ids order and sort timed items by time")


def reorder_day(ctx: ItemContext, data: dict, p: ReorderDay) -> ActionOutcome:
    day = _day(p.date, ctx, data)
    d = next((x for x in data["days"] if x["date"] == day), None)
    if d is None:
        raise ActionError(f"Nothing is planned on {day}.")
    if p.sort_by_time:
        timed = sorted((i for i in d["items"] if i.get("time")), key=lambda i: i["time"])
        rest = [i for i in d["items"] if not i.get("time")]
        d["items"] = timed + rest
    else:
        pos = {iid: n for n, iid in enumerate(p.item_ids)}
        unknown = [i for i in p.item_ids if not any(x["id"] == i for x in d["items"])]
        if unknown:
            raise ActionError(f"Not on {day}: {', '.join(unknown)}.")
        orig = {i["id"]: n for n, i in enumerate(d["items"])}
        d["items"] = sorted(d["items"], key=lambda i: pos.get(i["id"], 1000 + orig[i["id"]]))
    return ActionOutcome(summary=f"Reordered {day}")


class RemovePlanItems(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)
    to_ideas: bool = Field(default=False, description="Move them back to the Ideas list instead of deleting")


def remove_plan_items(ctx: ItemContext, data: dict, p: RemovePlanItems) -> ActionOutcome:
    taken = {i["id"] for i in data["ideas"]}
    n = 0
    for iid in p.ids:
        d, it = _find_item(data, iid)
        d["items"].remove(it)
        n += 1
        if p.to_ideas:
            data["ideas"].append(_idea_from_item(it, taken))
    data["days"] = [d for d in data["days"] if d["items"] or d.get("title") or d.get("notes") or d.get("tz")]
    verb = "Moved" if p.to_ideas else "Removed"
    return ActionOutcome(summary=f"{verb} {n} item{'s' if n != 1 else ''}{' to Ideas' if p.to_ideas else ''}")


def _idea_from_item(it: dict, taken: set[str]) -> dict:
    return {
        "id": _new_id("idea", it["title"], taken), "title": it["title"], "type": it.get("type", "activity"),
        "place": it.get("place", ""), "address": it.get("address", ""), "area": it.get("area", ""),
        "lat": it.get("lat"), "lng": it.get("lng"), "tags": [], "priority": "want",
        "duration_min": it.get("duration_min"), "cost_minor": it.get("cost_minor"), "currency": it.get("currency"),
        "hours": "", "book_ahead": False, "link": it.get("link", ""), "notes": it.get("notes", ""),
    }


# ------------------------------------------------------------------- ideas


class IdeaIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    type: PlanType = "activity"
    place: str = Field(default="", max_length=120)
    address: str = Field(default="", max_length=240)
    area: str = Field(default="", max_length=80, description="Neighbourhood or city — ideas are grouped by it")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    tags: list[str] = Field(default_factory=list, max_length=12)
    priority: Priority = "want"
    duration_min: int | None = Field(default=None, ge=0, le=4320)
    cost: float | None = Field(default=None, ge=0)
    currency: str | None = None
    hours: str = Field(default="", max_length=200, description="Opening hours / days closed")
    book_ahead: bool = False
    link: SafeUrl = Field(default="", max_length=520)
    notes: str = Field(default="", max_length=2000)


class AddIdeas(BaseModel):
    ideas: list[IdeaIn] = Field(min_length=1, max_length=40)


def add_ideas(ctx: ItemContext, data: dict, p: AddIdeas) -> ActionOutcome:
    taken = {i["id"] for i in data["ideas"]}
    added, updated, ids = 0, 0, []
    for it in p.ideas:
        cost, cur = _money(data, it.cost, it.currency)
        fields = {
            "title": it.title.strip(), "type": it.type, "place": it.place, "address": it.address, "area": it.area.strip(),
            "lat": it.lat, "lng": it.lng, "tags": [t.strip()[:30] for t in it.tags if t.strip()][:12], "priority": it.priority,
            "duration_min": it.duration_min, "cost_minor": cost, "currency": cur, "hours": it.hours,
            "book_ahead": it.book_ahead, "link": it.link, "notes": it.notes,
        }
        same = next((x for x in data["ideas"] if x["title"].lower() == it.title.strip().lower()), None)
        if same:
            given = it.model_fields_set
            for k, v in fields.items():
                src = {"cost_minor": "cost"}.get(k, k)
                if k == "currency":
                    src = "cost" if "cost" in given else "currency"
                if src in given and k != "title":
                    same[k] = v
            updated += 1
            ids.append(same["id"])
            continue
        if len(data["ideas"]) >= 500:
            raise ActionError("The ideas list is full (500).")
        data["ideas"].append({"id": _new_id("idea", it.title, taken), **fields})
        ids.append(data["ideas"][-1]["id"])
        added += 1
    msg = f"Added {added} idea{'s' if added != 1 else ''}" + (f", updated {updated}" if updated else "")
    return ActionOutcome(summary=msg, result={"ids": ids})


class ScheduleOne(BaseModel):
    idea_id: str
    date: str = Field(description="YYYY-MM-DD (or 'day 3')")
    time: str | None = Field(default=None, description="HH:MM or omit for anytime")
    index: int | None = Field(default=None, ge=0, le=40)
    duration_min: int | None = Field(default=None, ge=0, le=4320)


class ScheduleIdeas(BaseModel):
    ideas: list[ScheduleOne] = Field(min_length=1, max_length=60)


def schedule_ideas(ctx: ItemContext, data: dict, p: ScheduleIdeas) -> ActionOutcome:
    taken = _all_item_ids(data)
    done = []
    for s in p.ideas:
        idea = next((i for i in data["ideas"] if i["id"] == s.idea_id), None)
        if idea is None:
            raise ActionError(f"No idea with id {s.idea_id!r}.")
        day = _day(s.date, ctx, data)
        d = _ensure_day(data, day)
        _check_day_room(d)
        notes = idea.get("notes", "")
        extra = "; ".join(x for x in (f"Hours: {idea['hours']}" if idea.get("hours") else "",
                                      "Book ahead" if idea.get("book_ahead") else "") if x)
        if extra:
            notes = f"{notes}\n{extra}".strip()
        item = {
            "id": _new_id("i", f"{day[5:]} {idea['title']}", taken), "time": _hhmm(s.time),
            "duration_min": s.duration_min if s.duration_min is not None else idea.get("duration_min"),
            "type": idea.get("type", "activity"), "title": idea["title"], "place": idea.get("place", ""),
            "address": idea.get("address", ""), "area": idea.get("area", ""), "lat": idea.get("lat"), "lng": idea.get("lng"),
            "cost_minor": idea.get("cost_minor"), "currency": idea.get("currency"), "link": idea.get("link", ""),
            "status": "planned", "notes": notes[:2000], "booking_id": None, "travel_after": "",
        }
        _insert_by_time(d["items"], item, s.index)
        data["ideas"].remove(idea)
        done.append({"idea": idea["title"], "date": day, "item_id": item["id"]})
    first = done[0]
    summary = f"Scheduled {first['idea']} on {first['date']}" if len(done) == 1 else f"Scheduled {len(done)} ideas"
    return ActionOutcome(summary=summary, result=done)


def delete_ideas(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    before = len(data["ideas"])
    data["ideas"] = [i for i in data["ideas"] if i["id"] not in p.ids]
    n = before - len(data["ideas"])
    if not n:
        raise ActionError("None of those ideas exist.")
    return ActionOutcome(summary=f"Removed {n} idea{'s' if n != 1 else ''}")


# ----------------------------------------------------------------- packing


class PackingIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(default="Other", max_length=40, description="Documents, Clothes, Toiletries, Health, Tech, Gear, Kids, Money…")
    traveller: str | None = Field(default=None, description="Name or id; omit for shared")
    qty: int = Field(default=1, ge=1, le=99)
    essential: bool = False
    notes: str = Field(default="", max_length=200)


class AddPackingItems(BaseModel):
    items: list[PackingIn] = Field(default_factory=list, max_length=150)
    template: Literal[TEMPLATE_NAMES] | None = Field(  # type: ignore[valid-type]
        default=None, description=f"Add a ready-made list: {', '.join(TEMPLATE_NAMES)}"
    )
    for_travellers: list[str] | None = Field(default=None, max_length=20, description="Template per-person items for these travellers (default all)")


def add_packing_items(ctx: ItemContext, data: dict, p: AddPackingItems) -> ActionOutcome:
    if not p.items and not p.template:
        raise ActionError("Give items or a template.")
    taken = {i["id"] for i in data["packing"]}
    have = {(i["name"].lower(), i.get("traveller_id")) for i in data["packing"]}
    rows: list[tuple[str, str, str | None, int, bool, str]] = []
    if p.template:
        people = [_who(data, r, allow_none=False) for r in p.for_travellers] if p.for_travellers else [t["id"] for t in data["travellers"]]
        for name, cat, per, qty, ess in TEMPLATES[p.template][1]:
            if per and people:
                rows.extend((name, cat, tid, qty, ess, "") for tid in people)
            else:
                rows.append((name, cat, None, qty, ess, ""))
    for it in p.items:
        rows.append((it.name.strip(), it.category.strip() or "Other", _who(data, it.traveller), it.qty, it.essential, it.notes))
    added = 0
    for name, cat, tid, qty, ess, notes in rows:
        if (name.lower(), tid) in have:
            continue
        if len(data["packing"]) >= 800:
            raise ActionError("The packing list is full (800 items).")
        have.add((name.lower(), tid))
        data["packing"].append({"id": _new_id("p", f"{name} {tid or ''}", taken), "name": name, "category": cat,
                                "traveller_id": tid, "qty": qty, "checked": False, "essential": ess, "notes": notes})
        added += 1
    label = f" from the {TEMPLATES[p.template][0]} template" if p.template else ""
    return ActionOutcome(summary=f"Added {added} packing item{'s' if added != 1 else ''}{label}",
                         result={"added": added, "skipped_existing": len(rows) - added, "progress": logic.packing_progress(data)})


class CheckPacking(BaseModel):
    ids: list[str] | None = Field(default=None, max_length=400)
    names: list[str] | None = Field(default=None, max_length=200, description="Item names (case-insensitive), any traveller")
    all: bool = Field(default=False, description="Every item (e.g. uncheck all for the trip home)")
    checked: bool = True


def check_packing(ctx: ItemContext, data: dict, p: CheckPacking) -> ActionOutcome:
    names = {n.lower().strip() for n in (p.names or [])}
    ids = set(p.ids or [])
    n = 0
    for i in data["packing"]:
        if p.all or i["id"] in ids or i["name"].lower() in names:
            i["checked"] = p.checked
            n += 1
    if not n:
        raise ActionError("No packing items matched.")
    return ActionOutcome(summary=f"{'Packed' if p.checked else 'Unpacked'} {n} item{'s' if n != 1 else ''}",
                         result=logic.packing_progress(data))


def remove_packing_items(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    before = len(data["packing"])
    data["packing"] = [i for i in data["packing"] if i["id"] not in p.ids]
    n = before - len(data["packing"])
    if not n:
        raise ActionError("None of those packing items exist.")
    return ActionOutcome(summary=f"Removed {n} packing item{'s' if n != 1 else ''}")


# ----------------------------------------------------------------- money


class ShareIn(BaseModel):
    traveller: str = Field(description="Name or id")
    amount: float | None = Field(default=None, ge=0, description="Exact split: their part, in the expense currency")
    weight: float | None = Field(default=None, ge=0, le=1000, description="Shares split: their number of shares")


class ExpenseIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    amount: float = Field(ge=0, le=1e11, description="Major units, e.g. 3200 (yen) or 45.50")
    currency: str | None = Field(default=None, description="ISO code it was paid in; default home currency")
    date: str | None = Field(default=None, description="YYYY-MM-DD; default today")
    category: Category = "other"
    paid_by: str | None = Field(default=None, description="Traveller name or id (default: the only traveller / 'me')")
    split: SplitMode = "equal"
    split_between: list[str] | None = Field(default=None, max_length=20, description="Equal split: who shares it (default everyone)")
    shares: list[ShareIn] | None = Field(default=None, max_length=20, description="For exact or shares splits")
    booking_id: str | None = Field(default=None, description="The booking this pays for (its cost then isn't counted twice)")
    rate_per_home: float | None = Field(default=None, gt=0, description="Lock a rate for this expense: units per 1 home unit")
    notes: str = Field(default="", max_length=500)


class AddExpenses(BaseModel):
    expenses: list[ExpenseIn] = Field(min_length=1, max_length=60)


def _seed(*parts: object) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:4]


def _locked_rate(data: dict, cur: str, given: float | None) -> float | None:
    """The rate an expense keeps: the one given, else the trip's rate *now*
    (so later rate changes don't re-value settled spending). None for the
    home currency, or while there's no rate yet (then it follows the trip
    rate once one is set)."""
    if cur == data["settings"]["home_currency"]:
        return None
    if given:
        return round(given, 8)
    return rate_for(data, cur)


def _shares(data: dict, title: str, split: str, between: list[str] | None, given: list[ShareIn] | None,
            amount: int, cur: str) -> list[dict]:
    if split == "equal":
        return [{"traveller_id": _who(data, r, allow_none=False), "amount_minor": None, "weight": None} for r in (between or [])]
    if not given:
        raise ActionError(f"“{title}”: an {split} split needs shares.")
    out = []
    for s in given:
        tid = _who(data, s.traveller, allow_none=False)
        if split == "exact":
            if s.amount is None:
                raise ActionError(f"“{title}”: give each person's amount for an exact split.")
            out.append({"traveller_id": tid, "amount_minor": to_minor(s.amount, cur), "weight": None})
        else:
            out.append({"traveller_id": tid, "amount_minor": None, "weight": s.weight if s.weight is not None else 1.0})
    if split == "exact":
        diff = amount - sum(s["amount_minor"] for s in out)
        if abs(diff) > len(out):  # a cent each of rounding is fine
            raise ActionError(f"“{title}”: the exact parts add up to {fmt_money(amount - diff, cur)}, not {fmt_money(amount, cur)}.")
    return out


def add_expenses(ctx: ItemContext, data: dict, p: AddExpenses) -> ActionOutcome:
    taken = {e["id"] for e in data["expenses"]}
    ids, warnings = [], []
    total_home = 0
    for x in p.expenses:
        cur = _cur(data, x.currency)
        amount = to_minor(x.amount, cur)
        payer = _who(data, x.paid_by)
        if payer is None:
            payer = _me(data) or (data["travellers"][0]["id"] if len(data["travellers"]) == 1 else None)
        shares = _shares(data, x.title, x.split, x.split_between, x.shares, amount, cur)
        if x.booking_id and not any(b["id"] == x.booking_id for b in data["bookings"]):
            raise ActionError(f"No booking with id {x.booking_id!r}.")
        if len(data["expenses"]) >= 3000:
            raise ActionError("This trip already holds 3000 expenses.")
        day = _day(x.date, ctx, data)
        rate = _locked_rate(data, cur, x.rate_per_home)
        e = {"id": _new_id("x", f"{x.title} {_seed(day, x.amount, cur, len(data['expenses']))}", taken), "date": day,
             "title": x.title.strip(), "amount_minor": amount, "currency": cur, "category": x.category, "paid_by": payer,
             "split": x.split, "shares": shares, "per_home": rate, "booking_id": x.booking_id, "notes": x.notes}
        data["expenses"].append(e)
        ids.append(e["id"])
        h = to_home(data, amount, cur, rate)
        if h is None:
            warnings.append(f"No exchange rate for {cur} — set one with set_exchange_rates.")
        else:
            total_home += h
        if payer is None and len(data["travellers"]) > 1:
            warnings.append(f"“{x.title}”: no payer, so it's left out of settle-up.")
    data["expenses"].sort(key=lambda e: (e["date"], e["id"]))
    home = data["settings"]["home_currency"]
    n = len(ids)
    first = p.expenses[0]
    summary = (f"Logged {first.title}: {fmt_money(to_minor(first.amount, _cur(data, first.currency)), _cur(data, first.currency))}"
               if n == 1 else f"Logged {n} expenses ({fmt_money(total_home, home)})")
    return ActionOutcome(summary=summary, result={"ids": ids, "total_home": fmt_money(total_home, home), "warnings": sorted(set(warnings))})


class UpdateExpense(BaseModel):
    id: str = Field(description="Expense id")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    amount: float | None = Field(default=None, ge=0, le=1e11, description="Major units, in the expense's currency")
    currency: str | None = Field(default=None, description="Changing it takes the trip's current rate for the new currency")
    date: str | None = None
    category: Category | None = None
    paid_by: str | None = Field(default=None, description="Traveller name or id")
    split: SplitMode | None = None
    split_between: list[str] | None = Field(default=None, max_length=20, description="Equal split: who shares it (empty = everyone)")
    shares: list[ShareIn] | None = Field(default=None, max_length=20, description="For exact or shares splits")
    booking_id: str | None = Field(default=None, description="'' to unlink")
    rate_per_home: float | None = Field(default=None, gt=0, description="Re-lock this expense's rate (units per 1 home unit)")
    notes: str | None = Field(default=None, max_length=500)


def update_expense(ctx: ItemContext, data: dict, p: UpdateExpense) -> ActionOutcome:
    e = next((x for x in data["expenses"] if x["id"] == p.id), None)
    if e is None:
        raise ActionError(f"No expense with id {p.id!r}.")
    given = p.model_fields_set - {"id", "trip"}
    if not given:
        raise ActionError("Nothing to change.")
    if "title" in given and p.title:
        e["title"] = p.title.strip()
    if "category" in given and p.category:
        e["category"] = p.category
    if "notes" in given and p.notes is not None:
        e["notes"] = p.notes
    if "date" in given and p.date:
        e["date"] = _day(p.date, ctx, data)
    if "paid_by" in given:
        e["paid_by"] = _who(data, p.paid_by)
    if "booking_id" in given:
        if p.booking_id and not any(b["id"] == p.booking_id for b in data["bookings"]):
            raise ActionError(f"No booking with id {p.booking_id!r}.")
        e["booking_id"] = p.booking_id or None
    old_cur = e["currency"]
    if "currency" in given and p.currency:
        cur = _cur(data, p.currency)
        if cur != old_cur:
            e["currency"] = cur
            # A different currency needs its own rate; the old lock meant nothing for it.
            e["per_home"] = _locked_rate(data, cur, None)
            if "amount" not in given:
                raise ActionError("Give the amount in the new currency too.")
    if "amount" in given and p.amount is not None:
        e["amount_minor"] = to_minor(p.amount, e["currency"])
    if "rate_per_home" in given and p.rate_per_home:
        e["per_home"] = _locked_rate(data, e["currency"], p.rate_per_home)
    if given & {"split", "split_between", "shares"} or ("amount" in given and e["split"] == "exact"):
        split = p.split or e["split"]
        if split == "equal":
            between = p.split_between if "split_between" in given else None
            shares = (_shares(data, e["title"], "equal", between, None, e["amount_minor"], e["currency"])
                      if between is not None else ([] if split != e["split"] else e["shares"]))
        else:
            if p.shares is None:
                if split != e["split"]:
                    raise ActionError(f"An {split} split needs shares.")
                given_shares = [ShareIn(traveller=s["traveller_id"],
                                        amount=None if s.get("amount_minor") is None else s["amount_minor"] / 10 ** exponent(e["currency"]),
                                        weight=s.get("weight")) for s in e["shares"]]
            else:
                given_shares = p.shares
            shares = _shares(data, e["title"], split, None, given_shares, e["amount_minor"], e["currency"])
        e["split"], e["shares"] = split, shares
    data["expenses"].sort(key=lambda x: (x["date"], x["id"]))
    home = data["settings"]["home_currency"]
    h = to_home(data, e["amount_minor"], e["currency"], e.get("per_home"))
    return ActionOutcome(summary=f"Updated {e['title']}: {fmt_money(e['amount_minor'], e['currency'])}",
                         result={"id": e["id"], "home": fmt_money(h, home) if h is not None else None,
                                 "rate_locked": e.get("per_home")})


def delete_expenses(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    before = len(data["expenses"])
    data["expenses"] = [e for e in data["expenses"] if e["id"] not in p.ids]
    n = before - len(data["expenses"])
    if not n:
        raise ActionError("None of those expenses exist.")
    return ActionOutcome(summary=f"Deleted {n} expense{'s' if n != 1 else ''}")


class RecordSettlement(BaseModel):
    from_traveller: str = Field(description="Who paid (name or id)")
    to_traveller: str = Field(description="Who received it")
    amount: float = Field(gt=0, description="Home currency, major units")
    date: str | None = None
    note: str = Field(default="", max_length=200)


def record_settlement(ctx: ItemContext, data: dict, p: RecordSettlement) -> ActionOutcome:
    a, b = _who(data, p.from_traveller, allow_none=False), _who(data, p.to_traveller, allow_none=False)
    if a == b:
        raise ActionError("Someone can't pay themselves.")
    if len(data["settlements"]) >= 300:
        raise ActionError("Too many settlements on this trip.")
    home = data["settings"]["home_currency"]
    amt = to_minor(p.amount, home)
    day = _day(p.date, ctx, data)
    taken = {s["id"] for s in data["settlements"]}
    data["settlements"].append({"id": _new_id("s", f"{a} {b} {_seed(day, amt, len(taken))}", taken), "date": day,
                                "from_id": a, "to_id": b, "amount_minor": amt, "note": p.note})
    names = logic.traveller_names(data)
    return ActionOutcome(summary=f"{names[a]} paid {names[b]} {fmt_money(amt, home)}", result=logic.settle_up(data))


class RateIn(BaseModel):
    code: str = Field(description="ISO currency code, e.g. JPY")
    per_home: float | None = Field(default=None, gt=0, description="Units of this currency per 1 home unit (1 AUD = 97.5 JPY → 97.5)")
    home_per_unit: float | None = Field(default=None, gt=0, description="Or: home units per 1 of this currency (1 JPY = 0.0103 AUD)")


class SetExchangeRates(BaseModel):
    rates: list[RateIn] = Field(default_factory=list, max_length=24)
    remove: list[str] = Field(default_factory=list, max_length=24, description="Currency codes to drop")
    revalue_existing: bool = Field(
        default=False,
        description="Also re-value expenses already logged in these currencies at the new rate. Default: no — each "
                    "expense keeps the rate it was logged at, so settled-up spending stays settled",
    )


def set_exchange_rates(ctx: ItemContext, data: dict, p: SetExchangeRates) -> ActionOutcome:
    home = data["settings"]["home_currency"]
    drop = {c.strip().upper() for c in p.remove}
    data["currencies"] = [r for r in data["currencies"] if r["code"] not in drop]
    done = []
    revalued = 0
    for r in p.rates:
        code = _cur(data, r.code)
        if code == home:
            continue
        if r.per_home is None and r.home_per_unit is None:
            raise ActionError(f"Give a rate for {code}.")
        per_home = r.per_home if r.per_home is not None else 1 / r.home_per_unit  # type: ignore[operator]
        per_home = round(per_home, 8)
        row = next((x for x in data["currencies"] if x["code"] == code), None)
        if row:
            row.update(per_home=per_home, updated=ctx.today.isoformat())
        else:
            if len(data["currencies"]) >= 24:
                raise ActionError("A trip holds up to 24 currencies.")
            data["currencies"].append({"code": code, "per_home": per_home, "updated": ctx.today.isoformat()})
        done.append(f"1 {home} = {per_home:g} {code}")
        if p.revalue_existing:
            for e in data["expenses"]:
                if e["currency"] == code:
                    e["per_home"] = per_home
                    revalued += 1
    if not done and not drop:
        raise ActionError("Nothing to change.")
    note = f" (re-valued {revalued} expense{'s' if revalued != 1 else ''})" if revalued else ""
    return ActionOutcome(summary="Rates: " + ("; ".join(done) if done else f"removed {', '.join(sorted(drop))}") + note,
                         result={"rates": data["currencies"], "home": home, "revalued_expenses": revalued,
                                 "note": "Expenses already logged keep their own rate unless revalue_existing=true."})


class BudgetLineIn(BaseModel):
    category: Category
    amount: float = Field(ge=0, description="Home currency, major units")


class SetBudget(BaseModel):
    total: float | None = Field(default=None, ge=0, description="Whole-trip budget, home currency major units")
    categories: list[BudgetLineIn] | None = Field(default=None, max_length=9, description="Per-category budgets (replace those given)")
    clear: bool = Field(default=False, description="Remove all budgets first")


def set_budget(ctx: ItemContext, data: dict, p: SetBudget) -> ActionOutcome:
    home = data["settings"]["home_currency"]
    if p.clear:
        data["budget"] = {"total_minor": None, "lines": []}
    if p.total is not None:
        data["budget"]["total_minor"] = to_minor(p.total, home)
    for ln in p.categories or []:
        row = next((x for x in data["budget"]["lines"] if x["category"] == ln.category), None)
        amt = to_minor(ln.amount, home)
        if row:
            row["amount_minor"] = amt
        else:
            data["budget"]["lines"].append({"category": ln.category, "amount_minor": amt})
    if not (p.clear or p.total is not None or p.categories):
        raise ActionError("Give a total or category budgets.")
    status = logic.budget_status(data, ctx.today)
    total = data["budget"]["total_minor"]
    return ActionOutcome(summary=f"Budget set{': ' + fmt_money(total, home) if total is not None else ''}", result=status["text"])


# --------------------------------------------------------------- documents


class DocumentFields(BaseModel):
    type: DocType | None = None
    traveller: str | None = Field(default=None, description="Name or id")
    title: str | None = Field(default=None, max_length=120, description="e.g. 'Japan eVisa', 'Travel insurance — Cover-More'")
    country: str | None = Field(default=None, max_length=60, description="Issuing country, or the country it's for")
    reference: str | None = Field(default=None, max_length=40, description="Only the last 4 characters of a document number")
    issued: str | None = None
    expires: str | None = Field(default=None, description="YYYY-MM-DD")
    status: DocStatus | None = Field(default=None, description="todo = still to get, applied, done = have it")
    remind_on: str | None = Field(default=None, description="YYYY-MM-DD to be reminded (e.g. apply by)")
    attachments: list[AttachmentIn] | None = Field(default=None, max_length=10)
    link: SafeUrl | None = Field(default=None, max_length=520, description="Official application page (https)")
    notes: str | None = Field(default=None, max_length=1000)


class DocumentIn(DocumentFields):
    type: DocType


class AddDocuments(BaseModel):
    documents: list[DocumentIn] = Field(min_length=1, max_length=40)


def _mask(ref: str) -> str:
    ref = (ref or "").strip()
    return f"…{ref[-4:]}" if len(ref) > 6 else ref


def _apply_doc(ctx: ItemContext, data: dict, doc: dict, f: DocumentFields) -> None:
    given = f.model_fields_set
    for k in ("type", "title", "country", "status", "link", "notes"):
        if k in given and getattr(f, k) is not None:
            doc[k] = getattr(f, k)
    if "traveller" in given:
        doc["traveller_id"] = _who(data, f.traveller)
    if "reference" in given and f.reference is not None:
        doc["reference"] = _mask(f.reference)
    for k in ("issued", "expires", "remind_on"):
        if k in given:
            v = getattr(f, k)
            doc[k] = _day(v, ctx, data) if v else None
    if "attachments" in given and f.attachments is not None:
        have = {a["file_id"] for a in doc.get("attachments", [])}
        for a in f.attachments:
            if a.file_id not in have:
                doc.setdefault("attachments", []).append({"file_id": a.file_id, "name": a.name})


def add_documents(ctx: ItemContext, data: dict, p: AddDocuments) -> ActionOutcome:
    taken = {d["id"] for d in data["documents"]}
    ids = []
    for f in p.documents:
        tid = _who(data, f.traveller)
        same = next((d for d in data["documents"] if d["type"] == f.type and d.get("traveller_id") == tid
                     and (d.get("country") or "").lower() == (f.country or "").lower()
                     and (f.type not in ("other", "vaccination") or (d.get("title") or "").lower() == (f.title or "").lower())), None)
        if same is None:
            if len(data["documents"]) >= 120:
                raise ActionError("The documents checklist is full.")
            same = {"id": _new_id("doc", f"{f.type} {tid or ''} {f.country or ''}", taken), "type": f.type, "traveller_id": tid,
                    "title": "", "country": "", "reference": "", "issued": None, "expires": None, "status": "todo",
                    "remind_on": None, "attachments": [], "link": "", "notes": ""}
            data["documents"].append(same)
        _apply_doc(ctx, data, same, f)
        ids.append(same["id"])
    issues = logic.document_issues(data, ctx.today)
    return ActionOutcome(summary=f"Documents checklist: {len(ids)} added or updated",
                         result={"ids": ids, "issues": [i["message"] for i in issues]})


class UpdateDocument(DocumentFields):
    id: str


def update_document(ctx: ItemContext, data: dict, p: UpdateDocument) -> ActionOutcome:
    doc = next((d for d in data["documents"] if d["id"] == p.id), None)
    if doc is None:
        raise ActionError(f"No document with id {p.id!r}.")
    fields = DocumentFields.model_validate(p.model_dump(exclude={"id", "trip"}, exclude_unset=True))
    _apply_doc(ctx, data, doc, fields)
    return ActionOutcome(summary=f"Updated {doc.get('title') or doc['type'].replace('_', ' ')}")


def remove_documents(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    before = len(data["documents"])
    data["documents"] = [d for d in data["documents"] if d["id"] not in p.ids]
    n = before - len(data["documents"])
    if not n:
        raise ActionError("None of those documents exist.")
    return ActionOutcome(summary=f"Removed {n} document{'s' if n != 1 else ''}")


# --------------------------------------------------------------- read-only


class DayArg(BaseModel):
    date: str | None = Field(default=None, description="YYYY-MM-DD, 'today', 'tomorrow' or 'day 3'; default today")


class NoArgs(BaseModel):
    pass


def itinerary_for(ctx: ItemContext, data: dict, p: DayArg) -> ActionOutcome:
    day = _day(p.date, ctx, data)
    return ActionOutcome(summary="", result=logic.itinerary_for(data, day, ctx.tz))


def trip_summary(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    return ActionOutcome(summary="", result=logic.trip_summary(data, ctx.now, ctx.tz))


def budget_status(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    return ActionOutcome(summary="", result=logic.budget_status(data, ctx.today))


def settle_up(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    return ActionOutcome(summary="", result=logic.settle_up(data))


def packing_progress(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    return ActionOutcome(summary="", result=logic.packing_progress(data))


def conflicts(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    found = logic.conflicts(data, ctx.tz, ctx.today)
    return ActionOutcome(summary="", result={"count": len(found), "issues": found} if found else "No conflicts found.")


_TRIP_ACTIONS = [
    ItemAction("set_trip_details", "Set the trip's basics: title, emoji, colour, dates, status, notes, home currency (all amounts "
               "are converted; needs a rate for the new currency), passport rule, destinations (with IANA time zones) and "
               "travellers (add_travellers / rename_travellers / remove_travellers + reassign_to keep expenses intact; "
               "i_am = which traveller the person you're talking with is).",
               SetTripDetails, set_trip_details),
    ItemAction("add_bookings", "Add flights (one per leg), stays, car hire, trains/buses/ferries, tours/tickets, insurance. Times are LOCAL "
               "wall times at each end with that place's IANA zone (filled from the airport code when known). Re-adding the same "
               "booking (same type + start + confirmation/number/title) updates it instead of duplicating.",
               AddBookings, add_bookings),
    ItemAction("update_booking", "Change some fields of one booking (only the fields you pass).", UpdateBooking, update_booking),
    ItemAction("delete_bookings", "Delete bookings by id.", Ids, delete_bookings),
    ItemAction("plan_days", "Add itinerary items to one or more days in one call (each with optional time, duration, place, area, "
               "cost, notes, travel to next). replace=true clears a day's idea/planned items first.", PlanDays, plan_days),
    ItemAction("update_plan_items", "Edit itinerary items (time, status done/booked, notes, travel_after…).", UpdatePlanItems, update_plan_items),
    ItemAction("move_items", "Move itinerary items to another day and/or position/time.", MoveItems, move_items),
    ItemAction("reorder_day", "Set the order of a day's items (or sort them by time).", ReorderDay, reorder_day),
    ItemAction("remove_plan_items", "Delete itinerary items, or move them back to Ideas (to_ideas=true).", RemovePlanItems, remove_plan_items),
    ItemAction("add_ideas", "Add places/things to maybe do (the Ideas list), with area, tags, priority, hours, book-ahead.", AddIdeas, add_ideas),
    ItemAction("schedule_ideas", "Move ideas into days of the itinerary (optionally at a time).", ScheduleIdeas, schedule_ideas),
    ItemAction("delete_ideas", "Remove ideas by id.", Ids, delete_ideas),
    ItemAction("add_packing_items", "Add packing items (per traveller or shared) and/or a template list "
               f"({', '.join(TEMPLATE_NAMES)}). Existing items are skipped.", AddPackingItems, add_packing_items),
    ItemAction("check_packing", "Tick (or untick) packing items by id, name, or all.", CheckPacking, check_packing),
    ItemAction("remove_packing_items", "Delete packing items by id.", Ids, remove_packing_items),
    ItemAction("add_expenses", "Log expenses (any currency), who paid and how it's split (equal / exact / shares). Each "
               "expense locks the trip's current rate for its currency. paid_by 'me' = the person you're talking with.",
               AddExpenses, add_expenses),
    ItemAction("update_expense", "Change an expense (amount, currency, date, who paid, split, category…). It keeps the exchange "
               "rate it was logged at unless you pass rate_per_home or change its currency.", UpdateExpense, update_expense),
    ItemAction("delete_expenses", "Delete expenses by id.", Ids, delete_expenses),
    ItemAction("record_settlement", "Record a repayment between travellers (after settle_up).", RecordSettlement, record_settlement),
    ItemAction("set_exchange_rates", "Set or remove the trip's manual exchange rates against the home currency. New rates apply "
               "to expenses logged from now on; revalue_existing=true re-values earlier ones too (ask first).",
               SetExchangeRates, set_exchange_rates),
    ItemAction("set_budget", "Set the whole-trip budget and/or per-category budgets (home currency).", SetBudget, set_budget),
    ItemAction("add_documents", "Add to the documents checklist: passports (with expiry), visas/ETAs, insurance, vaccinations, "
               "driving permits… with status and a reminder date.", AddDocuments, add_documents),
    ItemAction("update_document", "Change a checklist document (status, expiry, reminder…).", UpdateDocument, update_document),
    ItemAction("remove_documents", "Remove checklist documents by id.", Ids, remove_documents),
    ItemAction("itinerary_for", "One day's plan with bookings merged in, in local time.", DayArg, itinerary_for, writes=False),
    ItemAction("trip_summary", "Overview: dates, countdown / day N of M, next up, bookings, unplanned days, packing, budget, issues.",
               NoArgs, trip_summary, writes=False),
    ItemAction("budget_status", "Budget vs actual (booked + spent) by category, in the home currency.", NoArgs, budget_status, writes=False),
    ItemAction("settle_up", "Who owes whom: balances and the transfers to square up (the fewest possible for groups up to "
               "10 people).", NoArgs, settle_up, writes=False),
    ItemAction("packing_progress", "Packed / total, by category and traveller, essentials left.", NoArgs, packing_progress, writes=False),
    ItemAction("conflicts", "Check the trip: overlapping bookings, impossible/tight connections, nights without a stay, "
               "time-zone mistakes, over-packed days, passport/visa problems, missing rates.", NoArgs, conflicts, writes=False),
]


# ------------------------------------------------------------ many trips


TRIP_ARG_HELP = ("Which trip: its id or title (fuzzy). Omit for the trip happening now, or the next one when that's "
                 "clear; if it isn't, the action refuses and lists the trips — ask the person which one.")


def _tag(out: ActionOutcome, data: dict, trip: dict) -> None:
    """Say which trip an action touched (when there's a choice)."""
    if isinstance(out.result, dict):
        out.result.setdefault("trip", {"id": trip["id"], "title": trips.title_of(trip)})
    if out.summary and len(data.get("trips", [])) > 1:
        out.summary = f"{out.summary} · {trips.title_of(trip)}"


def _scoped(action: ItemAction) -> ItemAction:
    """The one-trip action ``action`` made to work on the trip a ``trip``
    argument names (or the current/next one): it sees that trip's view."""
    params = create_model(  # type: ignore[call-overload]
        action.params.__name__, __base__=action.params,
        trip=(str | None, Field(default=None, max_length=120, description=TRIP_ARG_HELP)),
    )
    inner = action.run

    def run(ctx: ItemContext, data: dict, p):  # noqa: ANN001
        trip = trips.resolve(data, getattr(p, "trip", None), ctx.today)
        v = trips.enter(data, trip)
        try:
            out = inner(ctx, v, p)
        finally:
            trips.leave(data, trip)
        _tag(out, data, trip)
        return out

    return dataclasses.replace(action, params=params, run=run)


def _blank_trip(tid: str, title: str, home: str) -> dict:
    return Trip.model_validate({"id": tid, "title": title, "home_currency": home}).model_dump(mode="json")


def _me_traveller(ctx: ItemContext, trip: dict) -> None:
    uid = _ACTING.get() or ""
    name = (getattr(ctx.user, "username", "") or "").strip()[:60] or "Me"
    taken = {t["id"] for t in trip["travellers"]}
    if any(t["name"].lower() == name.lower() for t in trip["travellers"]):
        name = f"{name} (me)"[:60]
    tid, n = f"t-{_slug(name)}", 2
    while tid in taken:
        tid, n = f"t-{_slug(name)}-{n}", n + 1
    trip["travellers"].append({"id": tid, "name": name, "is_me": True, "user_id": uid, "age_group": "adult", "passport_country": ""})
    if uid:
        trip["me_by_user"][uid] = tid


class CreateTrip(BaseModel):
    title: str = Field(min_length=1, max_length=120, description="e.g. 'Japan 2027'")
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, description="Hex cover colour like #2C9CC8")
    start: str | None = Field(default=None, description="First day YYYY-MM-DD")
    end: str | None = Field(default=None, description="Last day (home again) YYYY-MM-DD")
    status: TripStatus | None = None
    notes: str | None = Field(default=None, max_length=5000)
    home_currency: str | None = Field(default=None, description="ISO code for budgets and settle-up; default the person's usual one")
    destinations: list[DestinationIn] | None = Field(default=None, max_length=40)
    travellers: list[TravellerIn] | None = Field(default=None, max_length=19, description="Companions (the person is added automatically)")
    include_me: bool = Field(default=True, description="Add the person you're talking with as a traveller")
    copy_travellers_from: str | None = Field(default=None, description="Another trip (id or title) whose travellers come along too")


def create_trip(ctx: ItemContext, data: dict, p: CreateTrip) -> ActionOutcome:
    if len(data["trips"]) >= MAX_TRIPS:
        raise ActionError(f"This file holds {MAX_TRIPS} trips at most — archive or delete old ones first.")
    fs = trips.file_settings(data)
    home = (p.home_currency or fs["home_currency"]).strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", home):
        raise ActionError(f"{p.home_currency!r} isn't a currency code — use ISO codes like AUD.")
    tid = _new_id("trip", p.title, {t["id"] for t in data["trips"]})
    trip = _blank_trip(tid, p.title.strip(), home)
    if p.copy_travellers_from:
        src = trips.find(data, p.copy_travellers_from, ctx.today)
        trip["travellers"] = copy.deepcopy(src["travellers"])
        trip["me_by_user"] = dict(src.get("me_by_user") or {})
    if p.include_me and not logic.me_id(trip, _ACTING.get()):
        _me_traveller(ctx, trip)
    v = trips.enter(data, trip)
    try:
        set_trip_details(ctx, v, SetTripDetails(
            title=p.title.strip(), emoji=p.emoji, color=p.color, start=p.start, end=p.end, status=p.status,
            notes=p.notes, destinations=p.destinations, add_travellers=p.travellers or None,
        ))
    finally:
        trips.leave(data, trip)
    if not trip["travellers"]:
        raise ActionError("A trip needs at least one traveller — keep include_me or name the travellers.")
    data["trips"].append(trip)
    return ActionOutcome(summary=f"Created the trip {trips.title_of(trip)}",
                         result={"id": tid, "title": trips.title_of(trip), "start": trip["start"], "end": trip["end"],
                                 "travellers": [{"id": t["id"], "name": t["name"]} for t in trip["travellers"]]})


class DeleteTrip(BaseModel):
    trip: str = Field(description="The trip's id or title")
    confirm: bool = Field(default=False, description="Needed when the trip has expenses or repayments (they're lost)")


def delete_trip(ctx: ItemContext, data: dict, p: DeleteTrip) -> ActionOutcome:
    t = trips.find(data, p.trip, ctx.today)
    ne, ns = len(t.get("expenses", [])), len(t.get("settlements", []))
    if (ne or ns) and not p.confirm:
        raise ActionError(f"{trips.title_of(t)} has {ne} expense{'s' if ne != 1 else ''} and {ns} repayment"
                          f"{'s' if ns != 1 else ''} — deleting it loses who paid what. Check with the person, then call "
                          "again with confirm=true (or mark it done instead: it moves to Past trips).")
    data["trips"] = [x for x in data["trips"] if x is not t]
    return ActionOutcome(summary=f"Deleted the trip {trips.title_of(t)}", result={"deleted": t["id"]})


class DuplicateTrip(BaseModel):
    trip: str | None = Field(default=None, description="The trip to copy (id or title); default the current/next one")
    title: str | None = Field(default=None, max_length=120, description="The copy's title (default '<title> (copy)')")
    start: str | None = Field(
        default=None,
        description="The copy's first day (YYYY-MM-DD): its dates and day plan shift to start then. Omit to copy "
                    "without dates — the planned items become ideas",
    )


def _shift(day: str | None, offset: timedelta) -> str | None:
    return (date.fromisoformat(day) + offset).isoformat() if day else None


def duplicate_trip(ctx: ItemContext, data: dict, p: DuplicateTrip) -> ActionOutcome:
    """A fresh copy to plan the next one from: places, travellers, plan,
    ideas, packing (unticked), budget and rates — not bookings or money."""
    if len(data["trips"]) >= MAX_TRIPS:
        raise ActionError(f"This file holds {MAX_TRIPS} trips at most — archive or delete old ones first.")
    src = trips.resolve(data, p.trip, ctx.today)
    title = (p.title or f"{trips.title_of(src)} (copy)").strip()[:120]
    tid = _new_id("trip", title, {t["id"] for t in data["trips"]})
    t = _blank_trip(tid, title, src.get("home_currency") or "AUD")
    for k in ("emoji", "color", "notes", "travellers", "me_by_user", "currencies", "budget", "ideas"):
        t[k] = copy.deepcopy(src.get(k, t[k]))
    t["packing"] = [{**copy.deepcopy(i), "checked": False} for i in src.get("packing", [])]
    t["documents"] = [copy.deepcopy(d) for d in src.get("documents", []) if d["type"] in ("passport", "id_card", "driving_permit")]
    for d in t["documents"]:
        d["remind_on"] = None
    dests = copy.deepcopy(src.get("destinations", []))
    days = copy.deepcopy(src.get("days", []))
    for d in days:
        for it in d["items"]:
            it["booking_id"] = None
            if it.get("status") in ("booked", "done"):
                it["status"] = "planned"
    if p.start:
        new_start = date.fromisoformat(_day(p.start, ctx, src))
        ref = src.get("start") or (days[0]["date"] if days else None)
        offset = new_start - date.fromisoformat(ref) if ref else timedelta(0)
        t["start"] = new_start.isoformat()
        t["end"] = _shift(src.get("end"), offset) if src.get("start") else None
        for x in dests:
            x["start"], x["end"] = _shift(x.get("start"), offset), _shift(x.get("end"), offset)
        for d in days:
            d["date"] = _shift(d["date"], offset)
        t["days"] = days
    else:
        for x in dests:
            x["start"] = x["end"] = None
        taken = {i["id"] for i in t["ideas"]}
        have = {i["title"].lower() for i in t["ideas"]}
        for d in days:
            for it in d["items"]:
                if it["title"].lower() in have or len(t["ideas"]) >= 500 or it.get("type") in ("flight", "stay", "note"):
                    continue
                have.add(it["title"].lower())
                t["ideas"].append(_idea_from_item(it, taken))
    t["destinations"] = dests
    data["trips"].append(t)
    return ActionOutcome(summary=f"Copied {trips.title_of(src)} to {title}",
                         result={"id": tid, "title": title, "start": t["start"], "end": t["end"],
                                 "note": "Bookings, expenses and visas weren't copied."})


class NoTripArgs(BaseModel):
    pass


def list_trips(ctx: ItemContext, data: dict, p: NoTripArgs) -> ActionOutcome:
    rows = []
    for b, t in trips.ordered(data, ctx.today):
        row = {"id": t["id"], "title": trips.title_of(t), "emoji": t.get("emoji"), "when": b, "status": t.get("status"),
               "start": t.get("start"), "end": t.get("end"),
               "destinations": [d["name"] for d in t.get("destinations", [])][:10],
               "travellers": [x["name"] for x in t.get("travellers", [])],
               "bookings": len(t.get("bookings", [])), "expenses": len(t.get("expenses", [])),
               "home_currency": t.get("home_currency")}
        if b == "upcoming":
            row["days_to_go"] = (date.fromisoformat(t["start"]) - ctx.today).days
        elif b == "now":
            row["day"] = (ctx.today - date.fromisoformat(t["start"])).days + 1
        rows.append(row)
    try:
        default = trips.default(data, ctx.today)["id"] if rows else None
    except ActionError:
        default = None
    note = None if default or not rows else "No obvious current trip — pass trip=<id> to the trip actions."
    return ActionOutcome(summary="", result={"count": len(rows), "trips": rows, "default_trip": default, "note": note})


ACTIONS = [
    ItemAction("list_trips", "Every trip in the file (happening now, upcoming soonest first, undated, past) with ids, dates, "
               "places and counts, and which trip the other actions use when no trip is named.", NoTripArgs, list_trips, writes=False),
    ItemAction("create_trip", "Start a new trip: title, dates, destinations (with IANA zones), companions. The person is "
               "added as a traveller ('me'). Returns its id — pass it as trip=... to the other actions.",
               CreateTrip, create_trip),
    ItemAction("duplicate_trip", "Copy a trip to plan another from it (places, travellers, plan, ideas, packing, budget, "
               "rates; not bookings, expenses or visas). With start= the dates and plan shift; without, the plan "
               "becomes ideas.", DuplicateTrip, duplicate_trip),
    ItemAction("delete_trip", "Delete a whole trip. Refused when it has expenses or repayments unless confirm=true — ask "
               "first; marking it done (set_trip_details status) keeps it under Past trips instead.", DeleteTrip, delete_trip),
    *(_scoped(a) for a in _TRIP_ACTIONS),
]

# "me" in every action is the acting user's traveller.
for _a in ACTIONS:
    _a.run = _acting(_a.run)
