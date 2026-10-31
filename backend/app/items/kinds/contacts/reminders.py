"""Contacts — reminders and the file as text.

Reminders (recomputed on every save and hourly, kept for the next 8 days):

* **Birthdays** on the day at the person's reminder time, and optionally
  N days before.
* **Important dates** (anniversaries and the like) on the day.
* **Keep in touch** — one weekly digest on the chosen weekday listing who's
  due, never one nudge per person.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from app.items.spec import ItemContext, Reminder, text_now

from . import logic as L

_GRACE = timedelta(hours=2)  # a reminder this recently due is still sent (hourly recompute)


def _at(day: date, hhmm: str, ctx: ItemContext) -> datetime:
    h, m = (int(x) for x in (hhmm or "09:00").split(":"))
    return datetime.combine(day, time(h, m), tzinfo=ctx.tz)


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    s = data.get("settings", {})
    today = ctx.today
    hhmm = s.get("reminder_time", "09:00")
    out: list[Reminder] = []
    before = int(s.get("birthday_days_before", 0) or 0)
    upcoming = L.upcoming_dates(data, today, 9 + before)
    for e in upcoming:
        day = date.fromisoformat(e["date"])
        first = e["name"].split(" ")[0] if e["name"] else e["name"]
        if e["kind"] == "birthday":
            if not s.get("birthday_reminders", True):
                continue
            turns = f" — {first} turns {e['turns']}" if e.get("turns") else ""
            out.append(
                Reminder(
                    key=f"bday:{e['contact_id']}:{day.year}",
                    due_at=_at(day, hhmm, ctx),
                    title=f"{e['name']}'s birthday is today",
                    body=f"Send {first} a note{turns}." if turns else f"Send {first} a note — open Contacts for ideas.",
                )
            )
            if before:
                pre = day - timedelta(days=before)
                when = "tomorrow" if before == 1 else f"in {before} days"
                out.append(
                    Reminder(
                        key=f"bday-pre:{e['contact_id']}:{day.year}:{before}",
                        due_at=_at(pre, hhmm, ctx),
                        title=f"{e['name']}'s birthday is {when}",
                        body="Time to plan a card, a call or a gift." + (f" They turn {e['turns']}." if e.get("turns") else ""),
                    )
                )
        else:
            if not s.get("date_reminders", True) or not e.get("remind", True):
                continue
            years = e.get("years")
            what = e["label"]
            extra = f" ({_ordinal(years)})" if years else ""
            out.append(
                Reminder(
                    key=f"date:{e['contact_id']}:{e['date_id']}:{day.year}",
                    due_at=_at(day, hhmm, ctx),
                    title=f"{e['name']}: {what}{extra} today",
                    body="A good day to reach out.",
                )
            )
    if s.get("reconnect_digest", True):
        wd = int(s.get("digest_weekday", 0) or 0)
        for offset in range(8):
            day = today + timedelta(days=offset)
            if day.weekday() != wd:
                continue
            due = L.reconnect_list(data, day, 0)
            if due:
                names = [d["name"] for d in due[:5]]
                more = f" and {len(due) - 5} more" if len(due) > 5 else ""
                out.append(
                    Reminder(
                        key=f"digest:{day.isoformat()}",
                        due_at=_at(day, hhmm, ctx),
                        title=f"Time to catch up with {len(due)} {'person' if len(due) == 1 else 'people'}",
                        body=", ".join(names) + more + ".",
                    )
                )
    floor = ctx.now - _GRACE
    out = [r for r in out if r.due_at >= floor]
    out.sort(key=lambda r: r.due_at)
    return out


# ------------------------------------------------------------------- text

MAX_TEXT = 20_000


def _contact_line(c: dict, data: dict, by_id: dict, groups: dict, today: date) -> str:
    order = data.get("settings", {}).get("name_order", "first_last")
    bits = [L.display_name(c, order)]
    if c.get("nickname"):
        bits[0] += f' ("{c["nickname"]}")'
    if c.get("favorite"):
        bits[0] += " ★"
    work = " at ".join(x for x in (c.get("title"), c.get("company")) if x)
    if work:
        bits.append(work)
    bits += [e["value"] for e in c.get("emails", [])[:2]]
    bits += [p["value"] for p in c.get("phones", [])[:2]]
    if c.get("addresses"):
        a = c["addresses"][0]
        place = ", ".join(x for x in (a.get("city"), a.get("country")) if x)
        if place:
            bits.append(place)
    if c.get("birthday"):
        bits.append(f"birthday {c['birthday']}")
    for d in c.get("dates", [])[:3]:
        bits.append(f"{d['label'] or d['kind']} {d['date']}")
    rels = []
    for r in c.get("relationships", [])[:6]:
        other = by_id.get(r.get("contact_id") or "")
        rels.append(f"{r.get('label') or r['type']}: {L.display_name(other, order) if other else r.get('name', '')}")
    if rels:
        bits.append("; ".join(rels))
    tg = c.get("tags", []) + [groups[g] for g in c.get("groups", []) if g in groups]
    if tg:
        bits.append("tags: " + ", ".join(tg))
    if c.get("met_how") or c.get("met_where"):
        bits.append("met: " + " ".join(x for x in (c.get("met_how"), c.get("met_where")) if x))
    last = L.last_contacted(c)
    if last:
        bits.append(f"last contacted {last}")
    if c.get("cadence_days"):
        bits.append(f"keep in touch every {c['cadence_days']} d")
    rem = [n["text"] for n in c.get("remember", [])[:4]]
    if rem:
        bits.append("remember: " + "; ".join(rem))
    open_topics = [n["text"] for n in c.get("topics", []) if not n["done"]][:3]
    if open_topics:
        bits.append("follow up: " + "; ".join(open_topics))
    if c.get("notes"):
        bits.append("notes: " + " ".join(c["notes"].split())[:160])
    return "- " + " · ".join(bits)


def to_text(data: dict) -> str:
    today = text_now().date()
    contacts = data.get("contacts", [])
    groups = {g["id"]: g["name"] for g in data.get("groups", [])}
    by_id = {c["id"]: c for c in contacts}
    lines = [f"Address book: {len(contacts)} people ({sum(1 for c in contacts if c.get('favorite'))} favourites)."]
    if groups:
        counts = {gid: 0 for gid in groups}
        for c in contacts:
            for g in c.get("groups", []):
                if g in counts:
                    counts[g] += 1
        lines.append("Groups: " + ", ".join(f"{groups[g]} ({n})" for g, n in counts.items()) + ".")
    due = L.reconnect_list(data, today, 0)
    if due:
        lines.append(
            "Due to reconnect: "
            + "; ".join(
                f"{d['name']} (every {d['every_days']} d, last {d['last_contacted'] or 'never'})" for d in due[:15]
            )
            + (f"; +{len(due) - 15} more" if len(due) > 15 else "")
        )
    soon = L.upcoming_dates(data, today, 30)
    if soon:
        lines.append(
            "Coming up (30 days): "
            + "; ".join(
                f"{e['date']} {e['name']} {e['label'].lower()}" + (f" (turns {e['turns']})" if e.get("turns") else "")
                for e in soon[:15]
            )
        )
    recent = sorted(
        ((i["date"], c, i) for c in contacts for i in c.get("interactions", [])[:3]), key=lambda x: x[0], reverse=True
    )[:10]
    if recent:
        lines.append(
            "Recent interactions: "
            + "; ".join(f"{d} {i['type']} with {L.display_name(c)}" + (f" — {i['notes'][:60]}" if i.get("notes") else "") for d, c, i in recent)
        )
    lines.append("People:")
    order = sorted(contacts, key=lambda c: (not c.get("favorite"), L.display_name(c).casefold()))
    used = sum(len(x) + 1 for x in lines)
    for n, c in enumerate(order):
        line = _contact_line(c, data, by_id, groups, today)
        if used + len(line) > MAX_TEXT:
            lines.append(f"… and {len(order) - n} more.")
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)
