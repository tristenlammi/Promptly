"""The trip's numbers and checks — everything the AI shouldn't do in its
head: what's on each day (bookings merged into the itinerary, in local
time), where you are each night, budget vs actual, who owes whom, packing
progress, document validity, and the conflicts list."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .models import CATEGORIES, TRANSPORT_TYPES
from .timeutil import (
    booking_duration,
    date_range,
    day_of,
    exponent,
    fmt_duration,
    fmt_money,
    half_up,
    in_gap,
    instant,
    rate_for,
    time_of,
    to_home,
    zone_abbr,
)

BOOKING_CATEGORY = {
    "flight": "flights", "stay": "stays", "car": "transport", "train": "transport", "bus": "transport",
    "ferry": "transport", "tour": "activities", "ticket": "activities", "insurance": "insurance", "other": "other",
}
PLAN_CATEGORY = {"activity": "activities", "food": "food", "transport": "transport", "stay": "stays", "flight": "flights", "note": "other"}
MAJOR_TYPES = ("activity",)

# ------------------------------------------------------------------ labels


def traveller_names(data: dict) -> dict[str, str]:
    return {t["id"]: t["name"] for t in data.get("travellers", [])}


def me_id(data: dict, user_id: str | None) -> str | None:
    """The traveller the Promptly user ``user_id`` is on this trip ("this is
    me", or a traveller linked to their account) — None when unknown. Not
    the file owner: every collaborator has their own "me"."""
    if not user_id:
        return None
    ids = {t["id"] for t in data.get("travellers", [])}
    tid = (data.get("me_by_user") or {}).get(user_id)
    if tid in ids:
        return tid
    return next((t["id"] for t in data.get("travellers", []) if t.get("user_id") == user_id), None)


def claim_me(data: dict, user_id: str, tid: str) -> None:
    """``user_id`` is traveller ``tid`` (one traveller per user and back)."""
    me = data.setdefault("me_by_user", {})
    for k in [k for k, v in me.items() if v == tid or k == user_id]:
        me.pop(k)
    for t in data.get("travellers", []):
        if t.get("user_id") == user_id and t["id"] != tid:
            t["user_id"] = ""
        if t["id"] == tid:
            t["user_id"] = user_id
    me[user_id] = tid


def traveller_refs(data: dict, tid: str) -> dict[str, int]:
    """How much money history points at a traveller (what a removal would orphan)."""
    exp = sum(1 for e in data.get("expenses", []) if e.get("paid_by") == tid or any(s["traveller_id"] == tid for s in e.get("shares", [])))
    st = sum(1 for s in data.get("settlements", []) if tid in (s["from_id"], s["to_id"]))
    return {"expenses": exp, "settlements": st}


def remove_traveller(data: dict, tid: str, reassign_to: str | None = None) -> None:
    """Take ``tid`` off the trip. Their expenses / settlements move to
    ``reassign_to`` (needed when they have any); packing and documents
    become shared, bookings drop them."""
    if reassign_to:
        for e in data.get("expenses", []):
            if e.get("paid_by") == tid:
                e["paid_by"] = reassign_to
            merged: dict[str, dict] = {}
            out = []
            for sh in e.get("shares", []):
                if sh["traveller_id"] == tid:
                    sh = {**sh, "traveller_id": reassign_to}
                prev = merged.get(sh["traveller_id"])
                if prev is None:
                    merged[sh["traveller_id"]] = sh
                    out.append(sh)
                else:  # both were in it: one share, added up
                    if prev.get("amount_minor") is not None or sh.get("amount_minor") is not None:
                        prev["amount_minor"] = (prev.get("amount_minor") or 0) + (sh.get("amount_minor") or 0)
                    if prev.get("weight") is not None or sh.get("weight") is not None:
                        prev["weight"] = min(1000.0, (prev.get("weight") or 0) + (sh.get("weight") or 0))
            e["shares"] = out
        keep = []
        for s in data.get("settlements", []):
            s["from_id"] = reassign_to if s["from_id"] == tid else s["from_id"]
            s["to_id"] = reassign_to if s["to_id"] == tid else s["to_id"]
            if s["from_id"] != s["to_id"]:
                keep.append(s)
        data["settlements"] = keep
    else:
        for e in data.get("expenses", []):
            if e.get("paid_by") == tid:
                e["paid_by"] = None
            e["shares"] = [sh for sh in e.get("shares", []) if sh["traveller_id"] != tid]
        data["settlements"] = [s for s in data.get("settlements", []) if tid not in (s["from_id"], s["to_id"])]
    for p in data.get("packing", []):
        if p.get("traveller_id") == tid:
            p["traveller_id"] = None
    for d in data.get("documents", []):
        if d.get("traveller_id") == tid:
            d["traveller_id"] = None
    for b in data.get("bookings", []):
        b["traveller_ids"] = [x for x in b.get("traveller_ids", []) if x != tid]
    me = data.get("me_by_user") or {}
    for k in [k for k, v in me.items() if v == tid]:
        me.pop(k)
    data["travellers"] = [t for t in data.get("travellers", []) if t["id"] != tid]


def _conv(minor: int, frm: str, to: str, pivot: float) -> int:
    """``minor`` units of ``frm`` in ``to``, at ``pivot`` units of ``to`` per 1 ``frm``."""
    return half_up(minor / 10 ** exponent(frm) * pivot * 10 ** exponent(to))


def rebase_home(data: dict, new: str, today: str) -> str | None:
    """Make ``new`` the home currency, keeping every amount's value: rates
    re-based, locked expense rates re-based, settlements / budget converted,
    costs with no currency pinned to the old home. Returns a refusal message
    (nothing changed) when there's no rate for ``new`` and something would
    need one."""
    old = data["settings"]["home_currency"]
    if new == old:
        return None
    pivot = rate_for(data, new)  # units of new per 1 old
    b = data.get("budget") or {}
    needs = bool(data.get("currencies") or data.get("expenses") or data.get("settlements")
                 or b.get("total_minor") is not None or b.get("lines")
                 or any(x.get("cost_minor") for x in data.get("bookings", []))
                 or any(i.get("cost_minor") for d in data.get("days", []) for i in d["items"])
                 or any(i.get("cost_minor") for i in data.get("ideas", [])))
    if not needs:
        data["settings"]["home_currency"] = new
        return None
    if not pivot:
        return (f"There's no exchange rate for {new} yet, so the trip's {old} amounts can't be converted. "
                f"Set a rate for {new} first (1 {old} = ? {new}), then change the home currency.")
    rates = [{"code": old, "per_home": round(1 / pivot, 8), "updated": today}]
    for r in data.get("currencies", []):
        if r["code"] != new:
            rates.append({**r, "per_home": round(r["per_home"] / pivot, 8)})
    for e in data.get("expenses", []):
        if e["currency"] == new:
            e["per_home"] = None
        elif e["currency"] == old:
            e["per_home"] = round(1 / pivot, 8)
        else:
            r = e.get("per_home") or rate_for(data, e["currency"])
            e["per_home"] = round(r / pivot, 8) if r else None
    for s in data.get("settlements", []):
        s["amount_minor"] = _conv(s["amount_minor"], old, new, pivot)
    if b.get("total_minor") is not None:
        b["total_minor"] = _conv(b["total_minor"], old, new, pivot)
    for ln in b.get("lines", []):
        ln["amount_minor"] = _conv(ln["amount_minor"], old, new, pivot)
    for x in [*data.get("bookings", []), *data.get("ideas", []), *(i for d in data.get("days", []) for i in d["items"])]:
        if x.get("cost_minor") is not None and not x.get("currency"):
            x["currency"] = old
        if x.get("currency") == new:
            x["currency"] = None
    data["currencies"] = rates[:24]
    data["settings"]["home_currency"] = new
    return None


def booking_label(b: dict) -> str:
    t = b.get("type")
    if b.get("title"):
        return b["title"]
    if t == "flight":
        route = f"{b.get('from_code') or b.get('from_place') or '?'} → {b.get('to_code') or b.get('to_place') or '?'}"
        num = " ".join(x for x in (b.get("provider"), b.get("number")) if x)
        return f"{num} {route}".strip()
    if t in ("train", "bus", "ferry"):
        route = " → ".join(x for x in (b.get("from_place"), b.get("to_place")) if x)
        return " ".join(x for x in (b.get("provider"), b.get("number"), route) if x) or t.title()
    return b.get("provider") or t.title()


def when_text(local: str | None, tz: str | None) -> str:
    if not local:
        return "time not set"
    abbr = zone_abbr(local, tz) if tz else ""
    return f"{local[:10]} {time_of(local)}{(' ' + abbr) if abbr else ''}"


# ------------------------------------------------------------ where you are


def _active(b: dict) -> bool:
    return b.get("status") != "cancelled"


def day_zone(data: dict, day: str) -> str:
    """The IANA zone you're in on ``day``: the day's own, a destination
    covering it, the stay you sleep in, where your last trip leg landed,
    else the first destination's."""
    for d in data.get("days", []):
        if d["date"] == day and d.get("tz"):
            return d["tz"]
    for dest in data.get("destinations", []):
        if dest.get("tz") and dest.get("start") and dest["start"] <= day <= (dest.get("end") or dest["start"]):
            return dest["tz"]
    for b in data.get("bookings", []):
        if b.get("type") == "stay" and _active(b) and b.get("start") and (b.get("start_tz") or b.get("end_tz")):
            s, e = day_of(b["start"]), day_of(b.get("end")) or day_of(b["start"])
            if s <= day <= e:
                return b.get("start_tz") or b.get("end_tz")
    best: tuple[str, str] | None = None
    for b in data.get("bookings", []):
        if b.get("type") in TRANSPORT_TYPES and _active(b) and b.get("end") and b.get("end_tz"):
            arr = day_of(b["end"])
            if arr <= day and (best is None or b["end"] > best[0]):
                best = (b["end"], b["end_tz"])
    if best:
        return best[1]
    for dest in data.get("destinations", []):
        if dest.get("tz"):
            return dest["tz"]
    return ""


def item_instant(data: dict, day: str, hhmm: str | None, fallback: ZoneInfo) -> datetime | None:
    if not hhmm:
        return None
    return instant(f"{day}T{hhmm}", day_zone(data, day), fallback)


# ------------------------------------------------------------ booking events

_EVENT_WORDS = {
    "flight": ("Depart", "Arrive"), "train": ("Depart", "Arrive"), "bus": ("Depart", "Arrive"),
    "ferry": ("Depart", "Arrive"), "stay": ("Check in", "Check out"), "car": ("Pick up", "Drop off"),
    "tour": ("Starts", "Ends"), "ticket": ("Starts", "Ends"), "insurance": ("Cover starts", "Cover ends"),
    "other": ("Starts", "Ends"),
}


def booking_events(data: dict, fallback: ZoneInfo) -> list[dict]:
    """Each booking's moments as local-day events (a flight's departure on
    its departure day, its arrival on the arrival day…)."""
    out = []
    for b in data.get("bookings", []):
        if not _active(b):
            continue
        start_w, end_w = _EVENT_WORDS.get(b.get("type", "other"), ("Starts", "Ends"))
        label = booking_label(b)
        same_day_trip = b.get("type") in TRANSPORT_TYPES + ("tour", "ticket") and day_of(b.get("start")) == day_of(b.get("end"))
        if b.get("start"):
            out.append({
                "date": day_of(b["start"]), "time": time_of(b["start"]), "edge": "start", "word": start_w,
                "booking_id": b["id"], "type": b["type"], "title": label,
                "at": instant(b["start"], b.get("start_tz"), fallback),
                "until": time_of(b.get("end")) if same_day_trip else "",
            })
        if b.get("end") and not same_day_trip and b.get("type") not in ("insurance",):
            out.append({
                "date": day_of(b["end"]), "time": time_of(b["end"]), "edge": "end", "word": end_w,
                "booking_id": b["id"], "type": b["type"], "title": label,
                "at": instant(b["end"], b.get("end_tz"), fallback), "until": "",
            })
    out.sort(key=lambda e: (e["date"], e["time"]))
    return out


def itinerary_for(data: dict, day: str, fallback: ZoneInfo) -> dict:
    """One day: plan items in their order with the day's booking moments
    slotted in by time."""
    entry = next((d for d in data.get("days", []) if d["date"] == day), None)
    items = list(entry["items"]) if entry else []
    linked = {i.get("booking_id") for i in items if i.get("booking_id")}
    events = [e for e in booking_events(data, fallback) if e["date"] == day and e["booking_id"] not in linked]
    rows: list[dict] = []
    pending = list(events)
    for it in items:
        if it.get("time"):
            while pending and pending[0]["time"] and pending[0]["time"] <= it["time"]:
                rows.append(_event_row(pending.pop(0)))
        rows.append(_item_row(it))
    rows.extend(_event_row(e) for e in pending)
    tz = day_zone(data, day)
    return {
        "date": day,
        "weekday": date.fromisoformat(day).strftime("%A"),
        "title": entry.get("title", "") if entry else "",
        "notes": entry.get("notes", "") if entry else "",
        "time_zone": tz or str(fallback),
        "entries": rows,
    }


def _event_row(e: dict) -> dict:
    return {
        "kind": "booking", "booking_id": e["booking_id"], "time": e["time"] or None,
        "until": e.get("until") or None, "title": f"{e['word']}: {e['title']}", "type": e["type"],
    }


def _item_row(it: dict) -> dict:
    row = {"kind": "item", "id": it["id"], "time": it.get("time"), "type": it.get("type"), "title": it["title"],
           "status": it.get("status")}
    for k in ("duration_min", "place", "area", "travel_after", "booking_id"):
        if it.get(k):
            row[k] = it[k]
    return row


# ---------------------------------------------------------------- money


def allocate(total: int, weights: list[float]) -> list[int]:
    """Split ``total`` (an integer) by ``weights`` so the parts sum exactly
    (largest remainder; ties go to the earliest)."""
    if not weights:
        return []
    s = sum(weights)
    if s <= 0:
        weights = [1.0] * len(weights)
        s = float(len(weights))
    raw = [total * w / s for w in weights]
    parts = [int(r // 1) if total >= 0 else -int((-r) // 1) for r in raw]
    left = total - sum(parts)
    order = sorted(range(len(raw)), key=lambda i: (-(raw[i] - parts[i]), i))
    step = 1 if left > 0 else -1
    for i in order[: abs(left)]:
        parts[i] += step
    return parts


def expense_split(data: dict, e: dict) -> dict[str, int]:
    """Who owes what of one expense, in the expense's own minor units (sums
    to the amount). Unknown travellers are left out."""
    ids = [t["id"] for t in data.get("travellers", [])]
    known = set(ids)
    shares = [s for s in e.get("shares", []) if s["traveller_id"] in known]
    amount = int(e.get("amount_minor") or 0)
    mode = e.get("split", "equal")
    if mode == "exact" and shares:
        fixed = {s["traveller_id"]: int(s.get("amount_minor") or 0) for s in shares}
        diff = amount - sum(fixed.values())
        if diff:  # doesn't add up: spread the difference evenly
            people = list(fixed)
            for tid, extra in zip(people, allocate(diff, [1.0] * len(people)), strict=True):
                fixed[tid] += extra
        return fixed
    if mode == "shares" and shares:
        people = [s["traveller_id"] for s in shares]
        parts = allocate(amount, [float(s.get("weight") if s.get("weight") is not None else 1.0) for s in shares])
        return dict(zip(people, parts, strict=True))
    people = [s["traveller_id"] for s in shares] or ids
    if not people:
        return {}
    return dict(zip(people, allocate(amount, [1.0] * len(people)), strict=True))


def missing_rates(data: dict) -> list[str]:
    home = data.get("settings", {}).get("home_currency", "AUD")
    need: set[str] = set()
    for e in data.get("expenses", []):
        if e["currency"] != home and not e.get("per_home") and rate_for(data, e["currency"]) is None:
            need.add(e["currency"])
    for b in data.get("bookings", []):
        if b.get("cost_minor") and b.get("currency") and rate_for(data, b["currency"]) is None:
            need.add(b["currency"])
    for d in data.get("days", []):
        for it in d["items"]:
            if it.get("cost_minor") and it.get("currency") and rate_for(data, it["currency"]) is None:
                need.add(it["currency"])
    return sorted(need)


def settle_up(data: dict) -> dict:
    """Balances (home currency, minor units: + is owed money) and the
    transfers that square everyone up (see :func:`minimal_transfers`)."""
    home = data.get("settings", {}).get("home_currency", "AUD")
    names = traveller_names(data)
    order = list(names)
    paid = dict.fromkeys(order, 0)
    owed = dict.fromkeys(order, 0)
    skipped: list[str] = []
    for e in data.get("expenses", []):
        payer = e.get("paid_by")
        if payer not in names:
            payer = order[0] if len(order) == 1 else None
        total = to_home(data, e.get("amount_minor"), e.get("currency"), e.get("per_home"))
        split = expense_split(data, e)
        if payer is None or total is None or not split:
            skipped.append(e["id"])
            continue
        people = list(split)
        parts = allocate(total, [float(split[p]) for p in people]) if sum(split.values()) else allocate(total, [1.0] * len(people))
        paid[payer] += total
        for p, part in zip(people, parts, strict=True):
            owed[p] += part
    bal = {t: paid[t] - owed[t] for t in order}
    for s in data.get("settlements", []):
        if s["from_id"] in bal and s["to_id"] in bal:
            bal[s["from_id"]] += s["amount_minor"]
            bal[s["to_id"]] -= s["amount_minor"]
    transfers = minimal_transfers(bal, order)
    return {
        "currency": home,
        "balances": [
            {"traveller_id": t, "name": names[t], "paid_minor": paid[t], "share_minor": owed[t], "balance_minor": bal[t],
             "balance": fmt_money(bal[t], home)}
            for t in order
        ],
        "transfers": [
            {**tr, "from": names[tr["from_id"]], "to": names[tr["to_id"]], "amount": fmt_money(tr["amount_minor"], home)}
            for tr in transfers
        ],
        "skipped_expense_ids": skipped,
        "settled": not transfers,
    }


# Exact minimisation is a search over subsets; past this many people with a
# non-zero balance the simple greedy settle-up is used instead.
EXACT_MAX = 10


def _greedy(balances: dict[str, int], rank: dict[str, int]) -> list[dict]:
    """The biggest debtor pays the biggest creditor until everyone's at
    zero — at most n−1 transfers for n people, exact in minor units."""
    cred = [[t, v] for t, v in balances.items() if v > 0]
    debt = [[t, -v] for t, v in balances.items() if v < 0]
    out = []
    while cred and debt:
        cred.sort(key=lambda x: (-x[1], rank.get(x[0], 0)))
        debt.sort(key=lambda x: (-x[1], rank.get(x[0], 0)))
        c, d = cred[0], debt[0]
        amt = min(c[1], d[1])
        out.append({"from_id": d[0], "to_id": c[0], "amount_minor": amt})
        c[1] -= amt
        d[1] -= amt
        cred = [x for x in cred if x[1] > 0]
        debt = [x for x in debt if x[1] > 0]
    return out


def zero_sum_groups(people: list[str], balances: dict[str, int]) -> list[list[str]] | None:
    """Split ``people`` into the most groups that each sum to zero (then
    each group squares up on its own in size−1 transfers, so the total is
    the fewest possible). None when the balances don't add up to zero."""
    n = len(people)
    vals = [balances[p] for p in people]
    full = (1 << n) - 1
    sums = [0] * (1 << n)
    for m in range(1, full + 1):
        low = m & -m
        sums[m] = sums[m ^ low] + vals[low.bit_length() - 1]
    if sums[full] != 0:
        return None
    dp = [0] * (1 << n)
    for m in range(1, full + 1):
        best = 0
        for i in range(n):
            if m >> i & 1 and dp[m ^ (1 << i)] > best:
                best = dp[m ^ (1 << i)]
        dp[m] = best + (1 if sums[m] == 0 else 0)
    chain = [full]
    m = full
    while m:
        want = dp[m] - (1 if sums[m] == 0 else 0)
        i = next(i for i in range(n) if m >> i & 1 and dp[m ^ (1 << i)] == want)
        m ^= 1 << i
        if m and sums[m] == 0:
            chain.append(m)
    chain.append(0)
    groups = []
    for a, b in zip(chain, chain[1:]):
        diff = a & ~b
        groups.append([people[i] for i in range(n) if diff >> i & 1])
    return groups


def minimal_transfers(balances: dict[str, int], order: list[str]) -> list[dict]:
    """Who pays whom to square up. Up to :data:`EXACT_MAX` people with a
    balance it's the provably fewest transfers (zero-sum groups); beyond
    that a simple greedy (at most n−1). Leftover "rounding dust" of a few
    minor units (from converting currencies) isn't worth a transfer."""
    rank = {t: i for i, t in enumerate(order)}
    people = [t for t in order if balances.get(t)]
    groups = zero_sum_groups(people, balances) if 0 < len(people) <= EXACT_MAX else None
    if groups is None:
        groups = [people]
    out: list[dict] = []
    for g in groups:
        out.extend(_greedy({t: balances[t] for t in g}, rank))
    dust = len(order)
    return [t for t in out if t["amount_minor"] > dust]


def trip_length(data: dict) -> int:
    return len(date_range(data.get("start"), data.get("end"))) if data.get("start") else 0


def budget_status(data: dict, today: date | None = None) -> dict:
    home = data.get("settings", {}).get("home_currency", "AUD")
    lines = {ln["category"]: ln["amount_minor"] for ln in data.get("budget", {}).get("lines", [])}
    booked = dict.fromkeys(CATEGORIES, 0)
    spent = dict.fromkeys(CATEGORIES, 0)
    planned = dict.fromkeys(CATEGORIES, 0)
    linked = {e.get("booking_id") for e in data.get("expenses", []) if e.get("booking_id")}
    for b in data.get("bookings", []):
        if not _active(b) or not b.get("cost_minor") or b["id"] in linked:
            continue
        v = to_home(data, b["cost_minor"], b.get("currency"))
        if v is not None:
            booked[BOOKING_CATEGORY.get(b["type"], "other")] += v
    for e in data.get("expenses", []):
        v = to_home(data, e.get("amount_minor"), e.get("currency"), e.get("per_home"))
        if v is not None:
            spent[e.get("category", "other")] += v
    for d in data.get("days", []):
        for it in d["items"]:
            if it.get("cost_minor") and it.get("status") != "done" and not it.get("booking_id"):
                v = to_home(data, it["cost_minor"], it.get("currency"))
                if v is not None:
                    planned[PLAN_CATEGORY.get(it.get("type", "activity"), "other")] += v
    total_budget = data.get("budget", {}).get("total_minor")
    if total_budget is None and lines:
        total_budget = sum(lines.values())
    rows = []
    for c in CATEGORIES:
        actual = booked[c] + spent[c]
        if not (lines.get(c) or actual or planned[c]):
            continue
        b = lines.get(c)
        rows.append({
            "category": c, "budget_minor": b, "booked_minor": booked[c], "spent_minor": spent[c],
            "actual_minor": actual, "planned_minor": planned[c],
            "remaining_minor": (b - actual) if b is not None else None,
            "over": b is not None and actual > b,
        })
    actual_total = sum(booked.values()) + sum(spent.values())
    out = {
        "currency": home,
        "budget_minor": total_budget,
        "booked_minor": sum(booked.values()),
        "spent_minor": sum(spent.values()),
        "actual_minor": actual_total,
        "planned_minor": sum(planned.values()),
        "remaining_minor": (total_budget - actual_total) if total_budget is not None else None,
        "categories": rows,
        "missing_rates": missing_rates(data),
    }
    n = trip_length(data)
    if n and today is not None and data.get("start"):
        start = date.fromisoformat(data["start"])
        elapsed = max(0, min(n, (today - start).days + 1))
        left = n - elapsed
        out["days"] = n
        out["days_elapsed"] = elapsed
        if elapsed:
            out["spent_per_day_minor"] = half_up(out["spent_minor"] / elapsed)
        if total_budget is not None and left > 0:
            out["left_per_day_minor"] = half_up((total_budget - actual_total) / left)
    out["text"] = _budget_text(out)
    return out


def _budget_text(s: dict) -> str:
    cur = s["currency"]
    parts = [f"Actual {fmt_money(s['actual_minor'], cur)} (booked {fmt_money(s['booked_minor'], cur)}, spent {fmt_money(s['spent_minor'], cur)})"]
    if s["budget_minor"] is not None:
        parts.append(f"budget {fmt_money(s['budget_minor'], cur)}, remaining {fmt_money(s['remaining_minor'], cur)}")
    if s["planned_minor"]:
        parts.append(f"planned extras {fmt_money(s['planned_minor'], cur)}")
    if s["missing_rates"]:
        parts.append(f"no exchange rate for {', '.join(s['missing_rates'])} (not counted)")
    return "; ".join(parts)


# -------------------------------------------------------------- packing


def packing_progress(data: dict) -> dict:
    names = traveller_names(data)
    items = data.get("packing", [])
    total = len(items)
    done = sum(1 for i in items if i.get("checked"))
    by_cat: dict[str, list[int]] = {}
    by_who: dict[str, list[int]] = {}
    for i in items:
        c = by_cat.setdefault(i.get("category") or "Other", [0, 0])
        c[1] += 1
        c[0] += 1 if i.get("checked") else 0
        who = names.get(i.get("traveller_id") or "", "Shared")
        w = by_who.setdefault(who, [0, 0])
        w[1] += 1
        w[0] += 1 if i.get("checked") else 0
    return {
        "packed": done,
        "total": total,
        "percent": round(100 * done / total) if total else 0,
        "by_category": [{"category": k, "packed": v[0], "total": v[1]} for k, v in by_cat.items()],
        "by_traveller": [{"traveller": k, "packed": v[0], "total": v[1]} for k, v in by_who.items()],
        "essentials_left": [i["name"] for i in items if i.get("essential") and not i.get("checked")][:40],
    }


# ------------------------------------------------------------ documents


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    import calendar

    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def document_issues(data: dict, today: date) -> list[dict]:
    """Passport validity (``passport_months`` beyond the return date),
    documents expiring before you're home, and ones still to get."""
    out = []
    names = traveller_names(data)
    end = data.get("end") or data.get("start")
    start = data.get("start")
    months = int(data.get("settings", {}).get("passport_months", 6))
    passports_for: set[str | None] = set()
    for doc in data.get("documents", []):
        who = names.get(doc.get("traveller_id") or "", "")
        label = doc.get("title") or doc["type"].replace("_", " ").title()
        name = f"{label}{f' ({who})' if who else ''}"
        if doc["type"] == "passport":
            passports_for.add(doc.get("traveller_id"))
        exp = doc.get("expires")
        if exp and end:
            if exp < end:
                out.append({"severity": "error", "kind": "document_expires", "document_id": doc["id"],
                            "message": f"{name} expires {exp}, before the trip ends ({end})."})
            elif doc["type"] == "passport" and months and date.fromisoformat(exp) < add_months(date.fromisoformat(end), months):
                out.append({"severity": "error", "kind": "passport_validity", "document_id": doc["id"],
                            "message": f"{name} expires {exp} — less than {months} months after you return ({end}). "
                                       "Many countries refuse entry; check the official rules and renew early."})
        elif exp and exp < today.isoformat():
            out.append({"severity": "warning", "kind": "document_expired", "document_id": doc["id"],
                        "message": f"{name} expired on {exp}."})
        if doc.get("status") == "todo" and start:
            left = (date.fromisoformat(start) - today).days
            if left <= 45:
                sev = "error" if left <= 14 else "warning"
                out.append({"severity": sev, "kind": "document_todo", "document_id": doc["id"],
                            "message": f"{name} is still to do and the trip starts in {max(0, left)} days."})
    travellers = data.get("travellers", [])
    if any(p for p in passports_for):
        # Some travellers have a passport on the list: flag the ones who don't.
        for t in travellers:
            if t["id"] not in passports_for:
                out.append({"severity": "warning", "kind": "passport_missing", "traveller_id": t["id"],
                            "message": f"No passport on the checklist for {t['name']} — add it so its expiry is checked."})
    if start and travellers and not any(d["type"] == "passport" for d in data.get("documents", [])):
        intl = any(b.get("type") == "flight" for b in data.get("bookings", []))
        if intl:
            out.append({"severity": "info", "kind": "no_passports",
                        "message": "No passports on the documents checklist — add them so expiry is checked."})
    return out


# ------------------------------------------------------------- conflicts


def _interval(b: dict, fallback: ZoneInfo) -> tuple[datetime, datetime] | None:
    a = instant(b.get("start"), b.get("start_tz"), fallback)
    if a is None:
        return None
    z = instant(b.get("end"), b.get("end_tz") or b.get("start_tz"), fallback) if b.get("end") else None
    if z is None:
        z = a + timedelta(hours=1)
    return a.astimezone(timezone.utc), z.astimezone(timezone.utc)


def _share_people(a: dict, b: dict) -> bool:
    x, y = set(a.get("traveller_ids") or []), set(b.get("traveller_ids") or [])
    return not x or not y or bool(x & y)


def _ranges(days: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for d in days:
        if out and (date.fromisoformat(d) - date.fromisoformat(out[-1][1])).days == 1:
            out[-1] = (out[-1][0], d)
        else:
            out.append((d, d))
    return out


def nights_without_stay(data: dict) -> list[str]:
    """Nights of the trip (each date you go to sleep, start … end−1) with no
    stay booked and no overnight journey."""
    nights = date_range(data.get("start"), data.get("end"))[:-1]
    if not nights:
        return []
    covered: set[str] = set()
    for b in data.get("bookings", []):
        if not _active(b) or not b.get("start"):
            continue
        s = day_of(b["start"])
        e = day_of(b.get("end")) or s
        if b["type"] == "stay":
            covered.update(d for d in date_range(s, e)[:-1] if d >= s)
        elif b["type"] in TRANSPORT_TYPES + ("other", "tour") and e > s:
            covered.update(date_range(s, e)[:-1])
    for d in data.get("days", []):
        if any(i.get("type") == "stay" for i in d["items"]):
            covered.add(d["date"])
    return [n for n in nights if n not in covered]


def conflicts(data: dict, fallback: ZoneInfo, today: date) -> list[dict]:
    out: list[dict] = []
    bookings = [b for b in data.get("bookings", []) if _active(b)]
    start, end = data.get("start"), data.get("end") or data.get("start")

    for b in bookings:
        label = booking_label(b)
        if b["type"] in TRANSPORT_TYPES and b.get("start") and b.get("end"):
            d = booking_duration(b, fallback)
            if d is not None and d < timedelta(0):
                out.append({"severity": "error", "kind": "arrives_before_departs", "booking_ids": [b["id"]],
                            "message": f"{label} arrives before it departs ({fmt_duration(d)}) — check the dates and time zones."})
            elif d is not None and b["type"] == "flight" and d > timedelta(hours=21):
                out.append({"severity": "warning", "kind": "implausible_duration", "booking_ids": [b["id"]],
                            "message": f"{label} takes {fmt_duration(d)} — that's longer than any non-stop flight; check the time zones."})
        if b["type"] == "flight" and b.get("start") and (not b.get("start_tz") or (b.get("end") and not b.get("end_tz"))):
            out.append({"severity": "warning", "kind": "missing_time_zone", "booking_ids": [b["id"]],
                        "message": f"{label} has no time zone for an endpoint, so its duration and reminders may be off."})
        for edge in ("start", "end"):
            if b.get(edge) and b.get(f"{edge}_tz") and in_gap(b[edge], b[f"{edge}_tz"]):
                out.append({"severity": "warning", "kind": "nonexistent_time", "booking_ids": [b["id"]],
                            "message": f"{label}: {b[edge][11:16]} on {b[edge][:10]} doesn't exist in {b[f'{edge}_tz']} (clocks change that night)."})
        if start and b.get("start") and b["type"] != "insurance":
            d0 = day_of(b["start"])
            if d0 < (date.fromisoformat(start) - timedelta(days=1)).isoformat() or (end and d0 > end):
                out.append({"severity": "info", "kind": "outside_trip", "booking_ids": [b["id"]],
                            "message": f"{label} is on {d0}, outside the trip dates ({start} – {end})."})

    # Overlaps: journeys / timed tickets at the same time, double-booked stays.
    moving = [b for b in bookings if b["type"] in TRANSPORT_TYPES + ("tour", "ticket", "car") and b.get("start")]
    spans = [(b, _interval(b, fallback)) for b in moving]
    spans = [(b, s) for b, s in spans if s]
    for i in range(len(spans)):
        for j in range(i + 1, len(spans)):
            (a, sa), (b, sb) = spans[i], spans[j]
            if "car" in (a["type"], b["type"]):
                continue  # a hire car runs for days alongside everything
            if sa[0] < sb[1] and sb[0] < sa[1] and _share_people(a, b):
                out.append({"severity": "error", "kind": "overlap", "booking_ids": [a["id"], b["id"]],
                            "message": f"{booking_label(a)} and {booking_label(b)} overlap in time."})
    stays = [b for b in bookings if b["type"] == "stay" and b.get("start") and b.get("end")]
    for i in range(len(stays)):
        for j in range(i + 1, len(stays)):
            a, b = stays[i], stays[j]
            a0, a1, b0, b1 = day_of(a["start"]), day_of(a["end"]), day_of(b["start"]), day_of(b["end"])
            if a0 < b1 and b0 < a1 and _share_people(a, b):
                out.append({"severity": "warning", "kind": "double_stay", "booking_ids": [a["id"], b["id"]],
                            "message": f"{booking_label(a)} and {booking_label(b)} are both booked for the night of {max(a0, b0)}."})

    # Connections between consecutive journeys.
    legs = sorted(
        [(b, _interval(b, fallback)) for b in bookings if b["type"] in TRANSPORT_TYPES and b.get("start") and b.get("end")],
        key=lambda x: x[1][0] if x[1] else datetime.max.replace(tzinfo=timezone.utc),
    )
    legs = [(b, s) for b, s in legs if s]
    for (a, sa), (b, sb) in zip(legs, legs[1:]):
        if not _share_people(a, b):
            continue
        gap = sb[0] - sa[1]
        if gap < timedelta(0) or gap > timedelta(hours=12):
            continue  # an overlap is reported above; a long gap isn't a connection
        la, lb = booking_label(a), booking_label(b)
        if a["type"] == "flight" and b["type"] == "flight":
            same = a.get("to_code") and a.get("to_code") == b.get("from_code")
            other = a.get("to_code") and b.get("from_code") and a["to_code"] != b["from_code"]
            if other and gap < timedelta(hours=3):
                out.append({"severity": "error", "kind": "airport_change", "booking_ids": [a["id"], b["id"]],
                            "message": f"{la} lands at {a['to_code']} but {lb} leaves from {b['from_code']} only "
                                       f"{fmt_duration(gap)} later — you'd have to change airports."})
            elif same and gap < timedelta(minutes=45):
                out.append({"severity": "error", "kind": "tight_connection", "booking_ids": [a["id"], b["id"]],
                            "message": f"Only {fmt_duration(gap)} between {la} and {lb} at {a['to_code']} — likely too tight "
                                       "(international transfers usually need 1.5–2h; check the airport's minimum connection time)."})
            elif same and gap < timedelta(minutes=75):
                out.append({"severity": "warning", "kind": "tight_connection", "booking_ids": [a["id"], b["id"]],
                            "message": f"{fmt_duration(gap)} to connect from {la} to {lb} at {a['to_code']} — tight if you change terminals or have bags to recheck."})
        elif a["type"] == "flight" and gap < timedelta(minutes=60):
            out.append({"severity": "warning", "kind": "tight_connection", "booking_ids": [a["id"], b["id"]],
                        "message": f"{fmt_duration(gap)} from landing ({la}) to {lb} — immigration and bags often take longer."})
        elif gap < timedelta(minutes=10):
            out.append({"severity": "warning", "kind": "tight_connection", "booking_ids": [a["id"], b["id"]],
                        "message": f"Only {fmt_duration(gap)} between {la} and {lb}."})

    # Nights with nowhere to sleep.
    for a, z in _ranges(nights_without_stay(data)):
        what = f"the night of {a}" if a == z else f"the nights of {a} to {z}"
        out.append({"severity": "warning", "kind": "missing_stay", "dates": [a, z],
                    "message": f"No stay booked for {what}."})

    # The itinerary itself.
    journeys = [(b, s) for b, s in spans if b["type"] in TRANSPORT_TYPES]
    for d in data.get("days", []):
        day = d["date"]
        if start and (day < start or (end and day > end)) and d["items"]:
            out.append({"severity": "info", "kind": "plan_outside_trip", "dates": [day, day],
                        "message": f"{len(d['items'])} plan item(s) on {day}, outside the trip dates."})
        timed = []
        for it in d["items"]:
            at = item_instant(data, day, it.get("time"), fallback)
            if at is None:
                continue
            until = at + timedelta(minutes=it.get("duration_min") or 0)
            timed.append((it, at.astimezone(timezone.utc), until.astimezone(timezone.utc)))
            for b, (b0, b1) in journeys:
                if at.astimezone(timezone.utc) < b1 and b0 < until.astimezone(timezone.utc) and it.get("booking_id") != b["id"] and it.get("type") not in ("flight", "transport", "note"):
                    out.append({"severity": "warning", "kind": "plan_during_journey", "item_ids": [it["id"]], "booking_ids": [b["id"]],
                                "message": f"“{it['title']}” ({day} {it['time']}) is while you're on {booking_label(b)}."})
        timed.sort(key=lambda x: x[1])
        for (x, x0, x1), (y, y0, _y1) in zip(timed, timed[1:]):
            if x.get("duration_min") and y0 < x1:
                out.append({"severity": "warning", "kind": "plan_overlap", "item_ids": [x["id"], y["id"]], "dates": [day, day],
                            "message": f"On {day}, “{x['title']}” runs into “{y['title']}”."})
        major = sum(1 for it in d["items"] if it.get("type") in MAJOR_TYPES)
        if major > 4:
            out.append({"severity": "info", "kind": "busy_day", "dates": [day, day],
                        "message": f"{day} has {major} activities — more than 3–4 a day usually means rushing; consider moving some."})

    out.extend(document_issues(data, today))
    for code in missing_rates(data):
        out.append({"severity": "warning", "kind": "missing_rate",
                    "message": f"No exchange rate for {code} — set one so its costs count in the budget."})
    rank = {"error": 0, "warning": 1, "info": 2}
    out.sort(key=lambda c: rank[c["severity"]])
    return out


# --------------------------------------------------------------- summary


def phase(data: dict, today: date) -> dict:
    start, end = data.get("start"), data.get("end") or data.get("start")
    if not start:
        return {"phase": "undated"}
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if today < s:
        return {"phase": "before", "days_to_go": (s - today).days}
    if today > e:
        return {"phase": "after", "days_since": (today - e).days}
    return {"phase": "during", "day": (today - s).days + 1, "of": (e - s).days + 1}


def next_moments(data: dict, now: datetime, fallback: ZoneInfo, limit: int = 3) -> list[dict]:
    """What's next from ``now``: booking moments and timed plan items."""
    cands: list[tuple[datetime, str]] = []
    for e in booking_events(data, fallback):
        if e["at"] is not None and e["at"] >= now:
            cands.append((e["at"], f"{e['word']}: {e['title']} ({e['date']} {e['time']} local)"))
    for d in data.get("days", []):
        for it in d["items"]:
            at = item_instant(data, d["date"], it.get("time"), fallback)
            if at is not None and at >= now and it.get("status") != "done":
                cands.append((at, f"{it['title']} ({d['date']} {it['time']} local)"))
    cands.sort(key=lambda x: x[0])
    out = []
    for at, text in cands[:limit]:
        mins = int((at - now).total_seconds() // 60)
        out.append({"what": text, "in": fmt_duration(timedelta(minutes=mins)), "at": at.isoformat()})
    return out


def trip_summary(data: dict, now: datetime, fallback: ZoneInfo) -> dict:
    today = now.date()
    by_type: dict[str, int] = {}
    for b in data.get("bookings", []):
        if _active(b):
            by_type[b["type"]] = by_type.get(b["type"], 0) + 1
    dates = date_range(data.get("start"), data.get("end"))
    planned_days = {d["date"] for d in data.get("days", []) if d["items"]}
    issues = conflicts(data, fallback, today)
    bstat = budget_status(data, today)
    pack = packing_progress(data)
    return {
        "title": data.get("title") or "",
        "status": data.get("status"),
        "dates": {"start": data.get("start"), "end": data.get("end"), "days": len(dates), "nights": max(0, len(dates) - 1)},
        **phase(data, today),
        "destinations": [f"{d['name']}{', ' + d['country'] if d.get('country') else ''}" for d in data.get("destinations", [])],
        "travellers": [t["name"] for t in data.get("travellers", [])],
        "bookings": by_type,
        "next_up": next_moments(data, now, fallback),
        "days_planned": len(planned_days & set(dates)),
        "days_unplanned": [d for d in dates if d not in planned_days][:40],
        "ideas": len(data.get("ideas", [])),
        "packing": f"{pack['packed']}/{pack['total']} packed",
        "budget": bstat["text"],
        "issues": [c["message"] for c in issues[:12]],
        "issue_count": len(issues),
    }
