"""The rest of the Today hub, on top of ``core.build``: medication, health
numbers, macros, money, the next trip, cards to study, the journal, people,
automations — then what they all add up to: a schedule for the day, what
needs you now, the week ahead, and how far through the day you are.

Each section reuses its app's own logic (so Today can't disagree with the
app), reads only the person's own file for that app, and is left out when
they don't use it. One app failing costs that card, never the page. The
morning push doesn't call this; it stays on ``core.build``.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .core import _primary, events_on, item_url, local_clock

logger = logging.getLogger("promptly.today.hub")

COMING_DAYS = 7
BILL_DAYS = 7
TRIP_SOON_DAYS = 60
WEIGHT_TREND_DAYS = 30
TREND_DAYS = 14
PEOPLE_DAYS = 14
MAX_COMING = 16

# Apps a person could add for more on this page, in the order worth suggesting.
DISCOVER = (
    ("tasks", "Tasks & Reminders", "Tasks due today, ticked off here"),
    ("health", "Body & Health", "Medication reminders, weight and more"),
    ("habits", "Habits", "Today's habits and streaks"),
    ("meals", "Meals & Macros", "Calories, macros and water at a glance"),
    ("workout", "Workout", "Today's session"),
    ("budget", "Budget", "What's left this month, bills coming up"),
    ("mealplan", "Meal Planner", "What's for dinner"),
    ("contacts", "Contacts", "Birthdays and who to catch up with"),
    ("journal", "Journal", "Today's entry and your streak"),
    ("trip", "Trip Planner", "Countdown and what's next on your trip"),
    ("flashcards", "Flashcards", "Cards to review today"),
)


# ------------------------------------------------------------------ health


def health_section(file_id: uuid.UUID, data: dict, now: datetime) -> dict | None:
    from app.items.kinds.health import meds as M
    from app.items.kinds.health import science as S

    day = now.date().isoformat()
    doses = M.due_today(data, now)
    numbers = []
    for mid in (data.get("settings") or {}).get("today_tiles") or []:
        info = S.metric_info(data, mid)
        if info is None:
            continue
        label = (info.get("label") or mid.replace("_", " ").capitalize())
        if mid == "bp":
            rows = [r for r in data.get("readings", []) if r["metric"] == "bp" and r["at"][:10] == day]
            value = f"{rows[-1]['sys']}/{rows[-1]['dia']}" if rows else None
        else:
            s = S.daily(data, mid, day, day)
            value = S.fmt_value(data, mid, s[day]) if s.get(day) is not None else None
        numbers.append({"metric": mid, "label": label, "value": value})
    weights = sorted((r for r in data.get("readings", []) if r["metric"] == "weight" and r.get("value") is not None), key=lambda r: r["at"])
    goals = []
    for g in data.get("goals", []):
        if g.get("direction") == "daily" and g.get("target"):
            v = S.daily(data, g["metric"], day, day).get(day, 0)
            info = S.metric_info(data, g["metric"])
            goals.append(
                {
                    "metric": g["metric"],
                    "label": ((info or {}).get("label") or g["metric"].capitalize()),
                    "today": S.fmt_value(data, g["metric"], v),
                    "target": S.fmt_value(data, g["metric"], g["target"]),
                    "pct": min(100, round((v or 0) / g["target"] * 100)),
                    "met": (v or 0) >= g["target"],
                }
            )
    appts = []
    for a in data.get("appointments", []):
        if a.get("done"):
            continue
        try:
            at = datetime.fromisoformat(a["at"])
        except ValueError:
            continue
        at = at.replace(tzinfo=now.tzinfo) if at.tzinfo is None else at.astimezone(now.tzinfo)
        if at.date() >= now.date():
            appts.append(
                {"id": a["id"], "title": a.get("title") or "Appointment", "who": a.get("who") or "", "location": a.get("location") or "",
                 "date": at.date().isoformat(), "time": at.strftime("%H:%M")}
            )
    appts.sort(key=lambda a: (a["date"], a["time"]))
    first = (now.date() - timedelta(days=WEIGHT_TREND_DAYS - 1)).isoformat()
    by_day = S.daily(data, "weight", first, day)
    weight_series = [round(by_day[d], 2) for d in sorted(by_day)]
    weight_change = None
    if len(weight_series) >= 2:
        delta = weight_series[-1] - weight_series[0]
        if abs(delta) >= 0.05:
            weight_change = ("+" if delta > 0 else "−") + S.fmt_value(data, "weight", abs(delta))

    def recent(mid: str) -> list[float | None]:
        start = now.date() - timedelta(days=TREND_DAYS - 1)
        vals = S.daily(data, mid, start.isoformat(), day)
        return [vals.get((start + timedelta(days=i)).isoformat()) for i in range(TREND_DAYS)]

    for row in numbers:
        if row["metric"] != "bp":
            row["series"] = recent(row["metric"])
    for g in goals:
        g["series"] = recent(g["metric"])
    used = doses or numbers or weights or goals or appts
    if not used:
        return None
    taken = sum(1 for d in doses if d["state"] in ("taken", "late"))
    return {
        "file_id": str(file_id),
        "url": item_url("health", file_id),
        "doses": doses,
        "doses_due": sum(1 for d in doses if d["state"] == "due"),
        "doses_taken": taken,
        "numbers": numbers,
        "goals": goals,
        "weight": S.fmt_value(data, "weight", weights[-1]["value"]) if weights else None,
        "weight_day": weights[-1]["at"][:10] if weights else None,
        "weight_unit": (data.get("settings") or {}).get("weight_unit", "kg"),
        "weight_series": weight_series,
        "weight_change": weight_change,
        "appointments": appts[:8],
    }


# ---------------------------------------------------------------- nutrition


def nutrition_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    from app.items.kinds.meals import actions as A
    from app.items.kinds.meals import science

    d = today.isoformat()
    tgt = science.targets_for(data.get("targets") or {}, d)
    day = (data.get("days") or {}).get(d) or {}
    entries = day.get("entries", [])
    if not tgt.get("kcal") and not entries and not day.get("water_ml"):
        return None
    t = A._day_totals(data, d)
    logged = {e.get("slot") for e in entries}
    # The last two weeks, gaps where nothing was logged (not a false zero).
    kcal_series: list[float | None] = []
    protein_series: list[float | None] = []
    for i in range(TREND_DAYS - 1, -1, -1):
        past = (today - timedelta(days=i)).isoformat()
        if (data.get("days") or {}).get(past, {}).get("entries"):
            totals = A._day_totals(data, past)
            kcal_series.append(round(totals["kcal"]))
            protein_series.append(round(totals["protein"]))
        else:
            kcal_series.append(None)
            protein_series.append(None)
    return {
        "file_id": str(file_id),
        "url": item_url("meals", file_id),
        "kcal_series": kcal_series,
        "protein_series": protein_series,
        "kcal": round(t["kcal"]),
        "kcal_target": tgt.get("kcal"),
        "macros": [
            {"key": k, "label": label, "value": round(t[k]), "target": tgt.get(k)}
            for k, label in (("protein", "Protein"), ("carbs", "Carbs"), ("fat", "Fat"))
        ],
        "water_ml": int(day.get("water_ml") or 0),
        "water_target": tgt.get("water_ml"),
        "entries": len(entries),
        "meals_left": [s["name"] for s in A._slots(data) if s["id"] not in logged],
    }


# ------------------------------------------------------------------ budget


def budget_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    from app.items.kinds.budget import logic, subscriptions

    if not (data.get("transactions") or data.get("subscriptions")):
        return None
    cur = (data.get("settings") or {}).get("currency") or "AUD"
    r = logic.forecast(data, today)
    t = logic.budget_table(data, r["month"])
    # From the bills themselves: the forecast only counts this budget month,
    # from tomorrow — a bill due today or just past payday matters here.
    t0, end = today.isoformat(), (today + timedelta(days=BILL_DAYS)).isoformat()
    bills = sorted(
        (
            {"name": x["name"], "date": x["next_due"], "amount": logic.fmt(x["amount_cents"], cur)}
            for x in data.get("subscriptions", [])
            if subscriptions.is_live(x) and x.get("next_due") and t0 <= x["next_due"] <= end
        ),
        key=lambda b: b["date"],
    )
    assigned = r["assigned"] or 0
    return {
        "file_id": str(file_id),
        "url": item_url("budget", file_id),
        "label": logic.month_label(r["month"], (data.get("settings") or {}).get("month_start_day", 1)),
        "spent": logic.fmt(r["spent_so_far"], cur),
        "budgeted": logic.fmt(assigned, cur) if assigned else None,
        "left": logic.fmt(assigned - r["spent_so_far"], cur) if assigned else None,
        "over": bool(assigned and r["spent_so_far"] > assigned),
        "pct": min(100, round(r["spent_so_far"] / assigned * 100)) if assigned else None,
        "days_left": r["days_left"],
        "projected_over": logic.fmt(-r["projected_vs_budget"], cur) if (r["projected_vs_budget"] or 0) < 0 else None,
        "bills": bills[:6],
        "overspent": [{"name": o["name"], "by": logic.fmt(-o["available"], cur)} for o in t["overspent"]][:4],
    }


# -------------------------------------------------------------------- trip


def trip_section(file_id: uuid.UUID, data: dict, now: datetime, tz: ZoneInfo) -> dict | None:
    from app.items.kinds.trip import logic

    today = now.date()
    best: tuple[int, dict, dict] | None = None
    for t in data.get("trips", []):
        if t.get("status") == "cancelled":
            continue
        ph = logic.phase(t, today)
        if ph["phase"] == "during":
            rank = -1
        elif ph["phase"] == "before" and ph["days_to_go"] <= TRIP_SOON_DAYS:
            rank = ph["days_to_go"]
        else:
            continue
        if best is None or rank < best[0]:
            best = (rank, t, ph)
    if best is None:
        return None
    _rank, t, ph = best
    moments = logic.next_moments(t, now, tz)
    pack = logic.packing_progress(t)
    return {
        "file_id": str(file_id),
        "url": item_url("trip", file_id),
        "id": t.get("id"),
        "title": t.get("title") or "Your trip",
        "emoji": t.get("emoji") or "",
        "start": t.get("start"),
        "end": t.get("end"),
        **ph,
        "next": [{"what": m["what"], "in": m["in"]} for m in moments],
        "packed": pack.get("packed", 0),
        "packing_total": pack.get("total", 0),
    }


# ------------------------------------------------------------------- study


def study_section(file_id: uuid.UUID, data: dict, now: datetime, ctx: Any) -> dict | None:
    from app.items.kinds.flashcards import study
    from app.items.kinds.flashcards.actions import cfg_of

    if not data.get("cards"):
        return None
    cfg = cfg_of(ctx, data)
    c = study.counts(data, now, cfg)
    streak, studied = study.streak(data, now, cfg)
    return {
        "file_id": str(file_id),
        "url": item_url("flashcards", file_id),
        "due": c["total"],
        "new": c["new"],
        "review": c["review"] + c["learning"],
        "done_today": c["done_today"],
        "streak": streak,
        "studied_today": studied,
    }


# ----------------------------------------------------------------- journal


def journal_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    from app.items.kinds.journal.logic import streaks

    entries = data.get("entries", [])
    d = today.isoformat()
    todays = [e for e in entries if e.get("date") == d]
    s = streaks(entries, today)
    moods = [e["mood"] for e in todays if e.get("mood")]
    return {
        "file_id": str(file_id),
        "url": item_url("journal", file_id),
        "wrote_today": bool(todays),
        "words_today": sum(int(e.get("word_count") or 0) for e in todays),
        "mood": moods[-1] if moods else None,
        "streak": s.get("current", 0),
        "total": len(entries),
    }


# ------------------------------------------------------------------ people


def people_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    from app.items.kinds.contacts import logic as L

    base = item_url("contacts", file_id)
    dates = [
        {"name": x["name"], "kind": x["kind"], "label": x["label"], "date": x["date"], "in_days": x["in_days"],
         "turns": x.get("turns"), "url": f"{base}?c={x['contact_id']}"}
        for x in L.upcoming_dates(data, today, PEOPLE_DAYS)
    ]
    catchup = [
        {"name": x["name"], "days_since": x["days_since"], "overdue_days": x["overdue_days"], "url": f"{base}?c={x['contact_id']}"}
        for x in L.reconnect_list(data, today, 0)
    ]
    if not dates and not catchup:
        return None
    return {"file_id": str(file_id), "url": base, "dates": dates[:5], "catchup": catchup[:3], "catchup_total": len(catchup)}


# ------------------------------------------------------------- automations


async def automations_section(db: AsyncSession, user: User, now: datetime) -> dict | None:
    from app.tasks.models import Task, TaskRun
    from app.tasks.policy import may_use_automations

    if not may_use_automations(user):
        return None
    rows = (
        await db.execute(
            select(Task).where(Task.user_id == user.id, Task.enabled.is_(True), Task.next_run_at.is_not(None)).order_by(Task.next_run_at).limit(3)
        )
    ).scalars().all()
    failed = (
        await db.scalar(
            select(func.count())
            .select_from(TaskRun)
            .join(Task, Task.id == TaskRun.task_id)
            .where(Task.user_id == user.id, TaskRun.status == "failed", TaskRun.created_at >= now - timedelta(hours=24))
        )
    ) or 0
    if not rows and not failed:
        return None
    return {
        "url": "/tasks",
        "failed_24h": int(failed),
        "next": [{"id": str(t.id), "title": t.title, "at": t.next_run_at.astimezone(now.tzinfo).isoformat()} for t in rows],
    }


# ---------------------------------------------------- what it all adds up to


def build_schedule(sec: dict, today: date, tz: ZoneInfo) -> dict:
    """Today, in time order, whichever app each thing lives in."""
    items: list[dict] = []
    all_day: list[dict] = []
    for e in (sec.get("events") or {}).get("events", []):
        if e.get("all_day"):
            all_day.append({"kind": "event", "title": e["title"], "url": e["url"], "color": e.get("color")})
        else:
            items.append({"time": local_clock(e["start"], tz), "end": local_clock(e["end"], tz) if e.get("end") else None, "kind": "event",
                          "title": e["title"], "detail": e.get("location") or "", "url": e["url"], "color": e.get("color"), "done": False})
    h = sec.get("health")
    if h:
        for d in h["doses"]:
            if d["state"] == "skipped":
                continue
            items.append({"time": d["time"], "kind": "med", "title": d["name"], "detail": d.get("dose") or "", "url": h["url"],
                          "done": d["state"] in ("taken", "late"), "due": d["state"] == "due", "med_id": d["med_id"], "file_id": h["file_id"]})
        for a in h["appointments"]:
            if a["date"] == today.isoformat():
                items.append({"time": a["time"], "kind": "appointment", "title": a["title"], "detail": " · ".join(x for x in (a["who"], a["location"]) if x),
                              "url": h["url"], "done": False})
    t = sec.get("tasks")
    if t:
        for x in t["today"]:
            if x.get("time"):
                items.append({"time": x["time"], "kind": "task", "title": x["title"], "detail": x.get("list") or "", "url": t["url"], "done": False,
                              "task_id": x["id"], "file_id": t["file_id"]})
    w = sec.get("workout")
    if w:
        for s in w["sessions"]:
            if s.get("time"):
                items.append({"time": s["time"], "kind": "workout", "title": s["name"], "detail": f"{s['exercises']} exercises" if s["exercises"] else "",
                              "url": w["url"], "done": s["status"] == "done"})
            else:
                all_day.append({"kind": "workout", "title": s["name"], "url": w["url"], "done": s["status"] == "done"})
    work = sec.get("work")
    if work:
        for s in work.get("shifts", []):
            if s.get("start"):
                items.append({"time": s["start"], "end": s.get("end"), "kind": "shift", "title": f"Shift · {s['roster']}", "detail": s.get("workspace") or "",
                              "url": s["url"], "done": False})
            else:
                all_day.append({"kind": "shift", "title": f"Shift · {s['roster']}", "url": s["url"]})
    p = sec.get("people")
    if p:
        for x in p["dates"]:
            if x["in_days"] == 0:
                what = f"{x['name']} turns {x['turns']}" if x["kind"] == "birthday" and x.get("turns") else f"{x['name']} · {x['label']}"
                all_day.append({"kind": "person", "title": what, "url": x["url"]})
    items.sort(key=lambda i: (i["time"], i["title"]))
    return {"items": items, "all_day": all_day}


def build_attention(sec: dict, today: date) -> list[dict]:
    """What needs you now, most pressing first."""
    out: list[dict] = []
    trip = (sec.get("maps") or {}).get("next")
    if trip and trip.get("soon"):
        out.append({"kind": "leave", "level": "warn", "title": f"Leave by {trip['leave_by_label']} for {trip['title']}", "detail": trip.get("warning") or f"{trip['minutes']} min drive", "url": trip["url"]})
    h = sec.get("health")
    if h and h["doses_due"]:
        names = [d["name"] for d in h["doses"] if d["state"] == "due"]
        out.append({"kind": "med", "level": "danger", "title": f"{names[0]} is due" if len(names) == 1 else f"{len(names)} doses are due",
                    "detail": ", ".join(names[:3]) if len(names) > 1 else "", "url": h["url"], "anchor": "meds"})
    t = sec.get("tasks")
    if t and t["overdue_count"]:
        n = t["overdue_count"]
        out.append({"kind": "task", "level": "danger", "title": f"{n} overdue task{'' if n == 1 else 's'}", "detail": t["overdue"][0]["title"], "url": t["url"], "anchor": "tasks"})
    if h:
        for a in h["appointments"]:
            if a["date"] == today.isoformat():
                out.append({"kind": "appointment", "level": "warn", "title": f"{a['title']} at {a['time']}", "detail": a["who"] or a["location"], "url": h["url"]})
    b = sec.get("budget")
    if b:
        soon = (today + timedelta(days=2)).isoformat()
        for bill in b["bills"]:
            if bill["date"] <= soon:
                when = "today" if bill["date"] == today.isoformat() else "soon"
                out.append({"kind": "bill", "level": "warn", "title": f"{bill['name']} due {when}", "detail": bill["amount"], "url": b["url"]})
        if b["overspent"]:
            n = len(b["overspent"])
            out.append({"kind": "budget", "level": "warn", "title": f"{b['overspent'][0]['name']} is over budget" if n == 1 else f"{n} categories over budget",
                        "detail": f"over by {b['overspent'][0]['by']}" if n == 1 else "", "url": b["url"]})
    p = sec.get("people")
    if p:
        for x in p["dates"]:
            if x["in_days"] == 0:
                out.append({"kind": "person", "level": "info", "title": f"{x['name']}'s {x['label'].lower()} today", "detail": f"turns {x['turns']}" if x.get("turns") else "", "url": x["url"]})
    r = sec.get("rooms")
    if r:
        dms = [x for x in r["rooms"] if x["dm"]]
        if dms:
            out.append({"kind": "message", "level": "info", "title": f"Message from {dms[0]['name']}" if len(dms) == 1 else f"Messages from {len(dms)} people",
                        "detail": "", "url": dms[0]["url"] if len(dms) == 1 else r["url"]})
    a = sec.get("automations")
    if a and a["failed_24h"]:
        n = a["failed_24h"]
        out.append({"kind": "automation", "level": "warn", "title": f"{n} automation run{'' if n == 1 else 's'} failed", "detail": "in the last day", "url": a["url"]})
    return out[:8]


async def build_coming(db: AsyncSession, user: User, sec: dict, tasks_data: dict | None, today: date, tz: ZoneInfo) -> list[dict]:
    """The next week across the apps: events, appointments, birthdays, bills,
    shifts, tasks and the trip, by day."""
    rows: list[dict] = []
    for i in range(1, COMING_DAYS + 1):
        day = today + timedelta(days=i)
        for e in await events_on(db, user, day, tz, limit=8):
            rows.append({"date": day.isoformat(), "time": None if e.get("all_day") else local_clock(e["start"], tz), "kind": "event", "title": e["title"], "url": e["url"], "color": e.get("color")})
    end = (today + timedelta(days=COMING_DAYS)).isoformat()
    t0 = today.isoformat()
    in_range = lambda d: d and t0 < d <= end  # noqa: E731
    h = sec.get("health")
    if h:
        rows += [{"date": a["date"], "time": a["time"], "kind": "appointment", "title": a["title"], "url": h["url"]} for a in h["appointments"] if in_range(a["date"])]
    p = sec.get("people")
    if p:
        rows += [{"date": x["date"], "time": None, "kind": "person", "title": f"{x['name']} · {x['label']}", "url": x["url"]} for x in p["dates"] if in_range(x["date"])]
    b = sec.get("budget")
    if b:
        rows += [{"date": x["date"], "time": None, "kind": "bill", "title": f"{x['name']} · {x['amount']}", "url": b["url"]} for x in b["bills"] if in_range(x["date"])]
    w = sec.get("work")
    if w:
        rows += [{"date": s["date"], "time": s.get("start"), "kind": "shift", "title": f"Shift · {s['roster']}", "url": s["url"]} for s in w.get("upcoming", []) if in_range(s["date"])]
    tr = sec.get("trip")
    if tr and in_range(tr.get("start")):
        rows.append({"date": tr["start"], "time": None, "kind": "trip", "title": f"{tr['title']} starts", "url": tr["url"]})
    ts = sec.get("tasks")
    if ts and tasks_data:
        for t in tasks_data.get("tasks", []):
            if not t.get("done") and in_range(t.get("due")):
                rows.append({"date": t["due"], "time": t.get("time"), "kind": "task", "title": t["title"], "url": ts["url"]})
    rows.sort(key=lambda r: (r["date"], r["time"] or "99:99", r["title"]))
    return rows[:MAX_COMING]


def build_progress(sec: dict, tasks_data: dict | None, today: date) -> dict | None:
    """How far through the day's to-dos you are: doses, tasks, habits, workout."""
    done = total = 0
    h = sec.get("health")
    if h:
        live = [d for d in h["doses"] if d["state"] != "skipped"]
        total += len(live)
        done += h["doses_taken"]
    t = sec.get("tasks")
    if t:
        d = today.isoformat()
        finished = sum(1 for x in (tasks_data or {}).get("tasks", []) if x.get("done") and (x.get("done_at") or "")[:10] == d)
        total += t["today_count"] + t["overdue_count"] + finished
        done += finished
    hb = sec.get("habits")
    if hb:
        total += len(hb["habits"])
        done += sum(1 for x in hb["habits"] if x["done"])
    w = sec.get("workout")
    if w:
        total += len(w["sessions"])
        done += sum(1 for s in w["sessions"] if s["status"] == "done")
    if not total:
        return None
    return {"done": done, "total": total, "pct": round(done / total * 100)}


# ------------------------------------------------------------------- build


async def extend(db: AsyncSession, user: User, out: dict[str, Any]) -> dict[str, Any]:
    """Add the hub's sections to what ``core.build`` made."""
    from app.items import service
    from app.items.registry import get_spec

    tz = ZoneInfo(out["tz"]) if out.get("tz") else timezone.utc
    # In the real zone, not just its offset: the apps' clocks (a dose's slot,
    # say) work in the person's ZoneInfo and fall back to UTC without one.
    now = datetime.fromisoformat(out["now"]).astimezone(tz)
    today = now.date()
    sec = out["sections"]

    async def add(key: str, kind: str, make: Any) -> dict | None:
        found = await _primary(db, user, kind)
        if not found:
            return None
        try:
            value = make(found[0].id, found[1].data or {}, found)
        except Exception:  # noqa: BLE001 — one app's trouble costs its card, not the page
            logger.exception("today %s section failed", key)
            return found[1].data
        if value:
            sec[key] = value
        return found[1].data

    await add("health", "health", lambda fid, d, _f: health_section(fid, d, now))
    await add("nutrition", "meals", lambda fid, d, _f: nutrition_section(fid, d, today))
    await add("budget", "budget", lambda fid, d, _f: budget_section(fid, d, today))
    await add("trip", "trip", lambda fid, d, _f: trip_section(fid, d, now, tz))
    await add("study", "flashcards", lambda fid, d, _f: study_section(fid, d, now, service.make_context(db, user, fid, get_spec("flashcards"))))
    await add("journal", "journal", lambda fid, d, _f: journal_section(fid, d, today))
    await add("people", "contacts", lambda fid, d, _f: people_section(fid, d, today))
    try:
        from app.mail.apps import today_section

        mail = await today_section(db, user)
        if mail:
            sec["mail"] = mail
    except Exception:  # noqa: BLE001
        logger.exception("today mail section failed")
    try:
        a = await automations_section(db, user, now)
        if a:
            sec["automations"] = a
    except Exception:  # noqa: BLE001
        logger.exception("today automations section failed")

    try:
        from app.maps.today import maps_section

        m = await maps_section(db, user, sec, now)
        if m:
            sec["maps"] = m
    except Exception:  # noqa: BLE001
        logger.exception("today maps section failed")

    found = await _primary(db, user, "tasks")
    tasks_data = found[1].data if found else None
    out["schedule"] = build_schedule(sec, today, tz)
    out["attention"] = build_attention(sec, today)
    try:
        out["coming"] = await build_coming(db, user, sec, tasks_data, today, tz)
    except Exception:  # noqa: BLE001
        logger.exception("today coming-up failed")
        out["coming"] = []
    out["progress"] = build_progress(sec, tasks_data, today)
    try:
        have = await service.installed_kinds(db, user)
        off = await service.disabled_kinds(db)
        out["discover"] = [{"kind": k, "name": n, "why": w} for k, n, w in DISCOVER if k not in have and k not in off and get_spec(k)][:4]
    except Exception:  # noqa: BLE001
        logger.exception("today discover failed")
        out["discover"] = []
    return out
