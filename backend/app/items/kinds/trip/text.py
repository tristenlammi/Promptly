"""All the trips as plain text — what chat, search and Drive AI read:
trips happening now and upcoming in full, past ones in a line or two."""
from __future__ import annotations

from datetime import date

from app.items.spec import text_now

from . import logic, trips
from .timeutil import booking_duration, date_range, fmt_duration, fmt_money, zone_abbr

LIMIT = 20_000


def _when(local: str | None, tz: str | None) -> str:
    if not local:
        return "?"
    abbr = zone_abbr(local, tz) if tz else ""
    return f"{local[:10]} {local[11:16]}{(' ' + abbr) if abbr else ''}"


def booking_line(data: dict, b: dict) -> str:
    label = logic.booking_label(b)
    bits = [f"[{b['type']}] {label}"]
    if b.get("status") != "confirmed":
        bits.append(f"({b['status']})")
    if b["type"] in ("flight", "train", "bus", "ferry"):
        d = booking_duration(b)
        bits.append(f"{_when(b.get('start'), b.get('start_tz'))} → {_when(b.get('end'), b.get('end_tz'))}")
        if d is not None:
            bits.append(f"({fmt_duration(d)})")
    elif b.get("start") or b.get("end"):
        bits.append(f"{_when(b.get('start'), b.get('start_tz'))} – {_when(b.get('end'), b.get('end_tz'))}")
    for k, word in (("terminal_from", "terminal"), ("seat", "seat"), ("confirmation", "ref"), ("address", "at")):
        if b.get(k):
            bits.append(f"{word} {b[k]}")
    if b.get("cost_minor"):
        bits.append(fmt_money(b["cost_minor"], b.get("currency") or data["settings"]["home_currency"]))
    return " ".join(bits)


def _head(data: dict) -> str:
    head = f"{data.get('emoji') or ''} {trips.title_of(data)}".strip()
    dates = date_range(data.get("start"), data.get("end"))
    if dates:
        head += f" — {dates[0]} to {dates[-1]} ({len(dates)} days, {len(dates) - 1} nights)"
    return head


def to_text(data: dict) -> str:
    now = text_now()
    rows = trips.ordered(data, now.date())
    if not rows:
        return "Trip Planner: no trips yet."
    words = {"now": "happening now", "upcoming": "upcoming", "undated": "no dates yet", "past": "past"}
    lines = [f"Trip Planner — {len(rows)} trip{'s' if len(rows) != 1 else ''}: "
             + "; ".join(f"{trips.title_of(t)} ({words[b]})" for b, t in rows[:30])]
    live = [t for b, t in rows if b != "past"]
    past = [t for b, t in rows if b == "past"]
    room = max(2500, (LIMIT - 3000) // max(1, len(live)))
    for t in live:
        lines.append("\n" + one_trip_text(trips.view(data, t))[:room])
    if past:
        lines.append("\nPast trips:")
        for t in past[:40]:
            v = trips.view(data, t)
            bits = [_head(v)]
            if v.get("destinations"):
                bits.append(", ".join(d["name"] for d in v["destinations"][:6]))
            if v.get("expenses"):
                bits.append(logic.budget_status(v)["text"])
            lines.append("- " + ". ".join(bits) + f" (trip id {t['id']})")
    return "\n".join(lines)[:LIMIT]


def one_trip_text(data: dict) -> str:
    """One trip (its view) in full."""
    home = data.get("settings", {}).get("home_currency", "AUD")
    lines: list[str] = []
    head = f"{data.get('emoji') or ''} {trips.title_of(data)}".strip()
    dates = date_range(data.get("start"), data.get("end"))
    if dates:
        head += f" — {dates[0]} to {dates[-1]} ({len(dates)} days, {len(dates) - 1} nights)"
    lines.append(f"{head}. Status: {data.get('status', 'planning')}. Home currency {home}. (trip id {data.get('id')})")
    if data.get("destinations"):
        ds = []
        for d in data["destinations"]:
            span = f" {d['start']}–{d.get('end') or d['start']}" if d.get("start") else ""
            ds.append(f"{d['name']}{', ' + d['country'] if d.get('country') else ''}{span}{' (' + d['tz'] + ')' if d.get('tz') else ''}")
        lines.append("Destinations: " + "; ".join(ds))
    if data.get("travellers"):
        lines.append("Travellers: " + ", ".join(t["name"] for t in data["travellers"]))
    if data.get("notes"):
        lines.append("Notes: " + data["notes"][:1500])

    now = text_now()
    issues = logic.conflicts(data, now.tzinfo, now.date())  # type: ignore[arg-type]
    if issues:
        lines.append("\nIssues to check:")
        lines.extend(f"- {c['message']}" for c in issues[:15])

    active = [b for b in data.get("bookings", []) if b.get("status") != "cancelled"]
    if active:
        lines.append("\nBookings:")
        lines.extend(f"- {booking_line(data, b)}" for b in active[:120])

    days = [d for d in data.get("days", []) if d["items"] or d.get("title")]
    if days:
        lines.append("\nItinerary:")
        for d in days:
            wd = date.fromisoformat(d["date"]).strftime("%a")
            lines.append(f"{wd} {d['date']}{' — ' + d['title'] if d.get('title') else ''}")
            for it in d["items"]:
                t = it.get("time") or "anytime"
                place = f" @ {it['place']}" if it.get("place") else ""
                st = f" [{it['status']}]" if it.get("status") not in ("planned", None) else ""
                lines.append(f"  {t} {it['title']}{place}{st}")
                if it.get("travel_after"):
                    lines.append(f"     ↓ {it['travel_after']}")

    if data.get("ideas"):
        lines.append(f"\nIdeas ({len(data['ideas'])}):")
        for i in sorted(data["ideas"], key=lambda x: ("must", "want", "maybe").index(x.get("priority", "want")))[:60]:
            tags = f" #{' #'.join(i['tags'])}" if i.get("tags") else ""
            area = f" ({i['area']})" if i.get("area") else ""
            lines.append(f"- {i['title']}{area} [{i.get('priority', 'want')}]{tags}")

    if data.get("documents"):
        names = logic.traveller_names(data)
        lines.append("\nDocuments:")
        for doc in data["documents"]:
            who = names.get(doc.get("traveller_id") or "", "")
            exp = f", expires {doc['expires']}" if doc.get("expires") else ""
            lines.append(f"- {doc.get('title') or doc['type']}{' (' + who + ')' if who else ''}: {doc.get('status')}{exp}")

    if data.get("packing"):
        p = logic.packing_progress(data)
        lines.append(f"\nPacking: {p['packed']}/{p['total']} packed.")
        if p["essentials_left"]:
            lines.append("Essentials not packed: " + ", ".join(p["essentials_left"][:20]))

    if data.get("expenses") or data.get("budget", {}).get("total_minor") or active:
        b = logic.budget_status(data, now.date())
        lines.append("\nMoney: " + b["text"] + ".")
        if data.get("currencies"):
            lines.append("Rates: " + ", ".join(f"1 {home} = {r['per_home']:g} {r['code']}" for r in data["currencies"]))
        if len(data.get("travellers", [])) > 1 and data.get("expenses"):
            s = logic.settle_up(data)
            if s["transfers"]:
                lines.append("Settle up: " + "; ".join(f"{t['from']} pays {t['to']} {t['amount']}" for t in s["transfers"]))
        recent = sorted(data.get("expenses", []), key=lambda e: e["date"], reverse=True)[:40]
        if recent:
            lines.append("Recent expenses:")
            lines.extend(f"- {e['date']} {e['title']} {fmt_money(e['amount_minor'], e['currency'])} ({e['category']})" for e in recent)
    return "\n".join(lines)[:LIMIT]
