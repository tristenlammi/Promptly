"""Medication schedules: which doses are due when, adherence, supply.

A medication's schedule is ``daily`` (times every day), ``days`` (times on
some weekdays), ``interval`` (every N days from its anchor day) or
``as_needed``. A *slot* is one scheduled (day, time). A dose record marks a
slot taken / late / skipped; a past slot with no record (after a grace
period) counts as missed.

Plans change over time (a new time, a higher dose, a taper): the plan in
effect on a day comes from ``schedule_history`` (earlier steps, each with
the last day it applied) and then the medicine's own schedule. Changing a
plan from a day never rewrites the days before it, and stopping a medicine
only ends the days after ``end`` / ``stopped_at`` — the history stays.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

GRACE = timedelta(hours=3)  # a slot isn't "missed" until this long after it
LATE_AFTER = timedelta(hours=1)  # taken more than this after the slot = late
FOLLOW_UP = timedelta(minutes=30)  # a second nudge when a dose is still unlogged

PLAN_KEYS = ("schedule", "dose", "per_dose")


def _d(s: str | None) -> date | None:
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def _moment(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


# ------------------------------------------------------------------ plans


def own_plan(med: dict) -> dict[str, Any]:
    return {
        "schedule": med.get("schedule") or {},
        "dose": med.get("dose", ""),
        "per_dose": float(med.get("per_dose") or 1),
        "stopped": False,
    }


def plan_on(med: dict, day: date) -> dict[str, Any]:
    """The plan (schedule, dose, per_dose, stopped) in effect on ``day``."""
    iso = day.isoformat()
    for st in sorted(med.get("schedule_history") or [], key=lambda s: s["until"]):
        if iso <= st["until"]:
            return {
                "schedule": st.get("schedule") or {},
                "dose": st.get("dose", ""),
                "per_dose": float(st.get("per_dose") or 1),
                "stopped": bool(st.get("stopped")),
            }
    return own_plan(med)


def _same_plan(a: dict, b: dict) -> bool:
    def norm(p: dict) -> tuple:
        s = p.get("schedule") or {}
        return (
            s.get("type", "daily"), tuple(sorted(set(s.get("times") or []))), tuple(sorted(set(s.get("weekdays") or []))),
            int(s.get("every_days") or 1), s.get("anchor") if s.get("type") == "interval" else None,
            tuple(sorted((k, (v or {}).get("dose", ""), (v or {}).get("per_dose")) for k, v in (s.get("slot_doses") or {}).items())),
            p.get("dose", ""), float(p.get("per_dose") or 1), bool(p.get("stopped")),
        )

    return norm(a) == norm(b)


def _step(plan: dict, until: date) -> dict:
    return {
        "until": until.isoformat(), "schedule": plan["schedule"], "dose": plan.get("dose", ""),
        "per_dose": float(plan.get("per_dose") or 1), "stopped": bool(plan.get("stopped")),
    }


def change_plan(med: dict, from_day: date, new: dict) -> bool:
    """Make ``new`` (schedule / dose / per_dose) the plan from ``from_day`` on:
    the days before keep the plan they had (pushed into the history), any
    later steps are replaced. Returns False when nothing changed."""
    sch = dict(new.get("schedule") or med.get("schedule") or {})
    if sch.get("type") == "interval" and not sch.get("anchor"):
        sch["anchor"] = from_day.isoformat() if (med.get("start") or "") < from_day.isoformat() else med.get("start")
    target = {
        "schedule": sch,
        "dose": new.get("dose", med.get("dose", "")),
        "per_dose": float(new.get("per_dose") or med.get("per_dose") or 1),
        "stopped": False,
    }
    hist = sorted(med.get("schedule_history") or [], key=lambda s: s["until"])
    future_steps = [s for s in hist if s["until"] >= from_day.isoformat()]
    if _same_plan(plan_on(med, from_day), target) and not future_steps and _same_plan(own_plan(med), target):
        return False
    start = _d(med.get("start"))
    prev = from_day - timedelta(days=1)
    kept = [s for s in hist if s["until"] < from_day.isoformat()]
    if start is None or prev >= start:
        before = plan_on(med, prev)
        last_until = kept[-1]["until"] if kept else None
        if (last_until is None or last_until < prev.isoformat()) and not _same_plan(before, target):
            kept.append(_step(before, prev))
    else:
        kept = []  # the change reaches back past the start: it is the whole plan
    med["schedule_history"] = kept[-120:]
    med["schedule"] = target["schedule"]
    med["dose"] = target["dose"]
    med["per_dose"] = target["per_dose"]
    return True


def stop(med: dict, now: datetime) -> None:
    """Stop from now on: today's later slots and every later day stop being due."""
    med["active"] = False
    med["end"] = now.date().isoformat()
    med["stopped_at"] = now.isoformat(timespec="seconds")


def resume(med: dict, today: date, data: dict | None = None) -> None:
    """Take it again from today; the days it was stopped stay a break (the
    stop day too, unless a dose was logged on it)."""
    end = _d(med.get("end"))
    if not med.get("active", True) and end is not None and end < today:
        logged_end = any(
            d["med_id"] == med["id"] and d["day"] == end.isoformat() for d in (data or {}).get("doses", [])
        )
        last_full = end if logged_end else end - timedelta(days=1)
        start = _d(med.get("start"))
        hist = sorted(med.get("schedule_history") or [], key=lambda s: s["until"])
        kept = [s for s in hist if s["until"] <= last_full.isoformat()]
        later = [s for s in hist if s["until"] >= today.isoformat()]
        if (start is None or last_full >= start) and (not kept or kept[-1]["until"] < last_full.isoformat()):
            kept.append(_step(plan_on(med, last_full), last_full))
        kept.append(_step({**plan_on(med, end), "stopped": True}, today - timedelta(days=1)))
        med["schedule_history"] = (kept + later)[-120:]
    med["active"] = True
    med["end"] = None
    med["stopped_at"] = None


# --------------------------------------------------------------- schedule


def is_active_on(med: dict, day: date) -> bool:
    start, end = _d(med.get("start")), _d(med.get("end"))
    if not med.get("active", True) and end is None:
        return False
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True


def times_on(med: dict, day: date) -> list[str]:
    """The scheduled HH:MM times of ``med`` on ``day`` (empty when not due)."""
    if not is_active_on(med, day):
        return []
    plan = plan_on(med, day)
    if plan["stopped"]:
        return []
    sch = plan["schedule"]
    kind = sch.get("type", "daily")
    if kind == "as_needed":
        return []
    if kind == "days" and day.weekday() not in (sch.get("weekdays") or []):
        return []
    if kind == "interval":
        anchor = _d(sch.get("anchor")) or _d(med.get("start"))
        every = max(1, int(sch.get("every_days") or 1))
        if anchor is None or (day - anchor).days % every != 0:
            return []  # (an interval always has an anchor — the model fills it from the start)
    return sorted(set(sch.get("times") or []))


def is_as_needed_on(med: dict, day: date) -> bool:
    return (plan_on(med, day)["schedule"] or {}).get("type") == "as_needed"


def slot_units(med: dict, day: date, slot: str | None) -> float:
    """Units one dose uses at ``slot`` on ``day`` (the per-time amount if set)."""
    plan = plan_on(med, day)
    sd = ((plan["schedule"] or {}).get("slot_doses") or {}).get(slot or "") or {}
    return float(sd.get("per_dose") or plan["per_dose"] or 1)


def slot_dose(med: dict, day: date, slot: str | None) -> str:
    """The dose text at ``slot`` on ``day`` ("1000 mg")."""
    plan = plan_on(med, day)
    sd = ((plan["schedule"] or {}).get("slot_doses") or {}).get(slot or "") or {}
    return sd.get("dose") or plan.get("dose") or ""


def slot_moment(day: date, hhmm: str, tz: ZoneInfo) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(h, m), tzinfo=tz)


def _after_stop(med: dict, at: datetime) -> bool:
    stopped = _moment(med.get("stopped_at"))
    return stopped is not None and not med.get("active", True) and at > stopped


def doses_by_slot(data: dict) -> dict[tuple[str, str, str | None], dict]:
    """(med_id, day, slot) → the latest dose record for it."""
    out: dict[tuple[str, str, str | None], dict] = {}
    for d in data.get("doses", []):
        out[(d["med_id"], d["day"], d.get("slot"))] = d
    return out


def per_day_usage(med: dict, day: date | None = None) -> float:
    """Average units used per day on the plan in effect ``day`` (0 for as-needed)."""
    day = day or date.today()
    plan = plan_on(med, day)
    sch = plan["schedule"] or {}
    kind = sch.get("type", "daily")
    times = sorted(set(sch.get("times") or []))
    if kind == "as_needed" or not times or plan["stopped"]:
        return 0.0
    sds = sch.get("slot_doses") or {}
    per_day = sum(float((sds.get(t) or {}).get("per_dose") or plan["per_dose"] or 1) for t in times)
    if kind == "days":
        return per_day * len(set(sch.get("weekdays") or [])) / 7
    if kind == "interval":
        return per_day / max(1, int(sch.get("every_days") or 1))
    return per_day


def supply(med: dict, today: date) -> dict | None:
    """Days of supply left and the estimated run-out day, when tracked."""
    rem = med.get("remaining")
    if rem is None:
        return None
    use = per_day_usage(med, today)
    if use <= 0:
        return {"remaining": rem, "days_left": None, "runs_out": None}
    days_left = rem / use
    return {
        "remaining": rem,
        "days_left": round(days_left, 1),
        "runs_out": (today + timedelta(days=int(days_left))).isoformat(),
    }


def slots_between(data: dict, start: date, end: date, tz: ZoneInfo, med_id: str | None = None):
    """Every scheduled slot in [start, end]: (med, day, hhmm, moment)."""
    meds = [m for m in data.get("medications", []) if med_id is None or m["id"] == med_id]
    day = start
    while day <= end:
        for m in meds:
            for t in times_on(m, day):
                at = slot_moment(day, t, tz)
                if _after_stop(m, at):
                    continue
                yield m, day, t, at
        day += timedelta(days=1)


def adherence(data: dict, now: datetime, days: int, med_id: str | None = None) -> dict:
    """Per medication and overall: due slots, taken (on time / late),
    skipped, missed and the adherence % (taken + late) / counted, where
    counted = slots whose grace period is over, plus earlier-logged ones.
    Each day is judged by the plan in effect that day."""
    tz = now.tzinfo if isinstance(now.tzinfo, ZoneInfo) else ZoneInfo("UTC")
    end = now.date()
    start = end - timedelta(days=days - 1)
    log = doses_by_slot(data)
    per: dict[str, dict] = {}
    for m, day, t, at in slots_between(data, start, end, tz, med_id):
        rec = log.get((m["id"], day.isoformat(), t))
        row = per.setdefault(
            m["id"], {"med_id": m["id"], "name": m["name"], "due": 0, "taken": 0, "late": 0, "skipped": 0, "missed": 0, "pending": 0}
        )
        if rec is None:
            if at + GRACE <= now:
                row["due"] += 1
                row["missed"] += 1
            elif at <= now:
                row["pending"] += 1
            continue
        row["due"] += 1
        row[rec["status"]] += 1
    prn: dict[str, int] = {}
    for d in data.get("doses", []):
        if d.get("slot") is None and d["status"] != "skipped" and start.isoformat() <= d["day"] <= end.isoformat():
            if med_id is None or d["med_id"] == med_id:
                prn[d["med_id"]] = prn.get(d["med_id"], 0) + 1
    rows = list(per.values())
    for r in rows:
        r["adherence_pct"] = round(100 * (r["taken"] + r["late"]) / r["due"]) if r["due"] else None
        r["on_time_pct"] = round(100 * r["taken"] / r["due"]) if r["due"] else None
    due = sum(r["due"] for r in rows)
    ok = sum(r["taken"] + r["late"] for r in rows)
    names = {m["id"]: m["name"] for m in data.get("medications", [])}
    return {
        "days": days,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "overall_pct": round(100 * ok / due) if due else None,
        "medications": rows,
        "as_needed_taken": [{"med_id": k, "name": names.get(k, k), "count": v} for k, v in prn.items()],
    }


def due_today(data: dict, now: datetime) -> list[dict]:
    """Today's slots with their state: taken / late / skipped / due (time
    has come) / upcoming."""
    tz = now.tzinfo if isinstance(now.tzinfo, ZoneInfo) else ZoneInfo("UTC")
    day = now.date()
    log = doses_by_slot(data)
    out = []
    for m, _day, t, at in slots_between(data, day, day, tz):
        rec = log.get((m["id"], day.isoformat(), t))
        state = rec["status"] if rec else ("due" if at <= now else "upcoming")
        out.append({"med_id": m["id"], "name": m["name"], "dose": slot_dose(m, day, t), "time": t, "state": state})
    out.sort(key=lambda r: (r["time"], r["name"]))
    return out


def limit_warnings(data: dict, med: dict, at: datetime, extra_today: int = 0) -> list[str]:
    """Warnings for taking ``med`` at ``at``: more than its max a day, or
    sooner than its minimum gap after the last dose. Never a refusal — the
    person may have instructions we don't know about."""
    out: list[str] = []
    taken = [d for d in data.get("doses", []) if d["med_id"] == med["id"] and d["status"] != "skipped"]
    max_day = med.get("max_per_day")
    if max_day:
        n = sum(1 for d in taken if d["day"] == at.date().isoformat()) + extra_today
        if n + 1 > max_day:
            out.append(f"{med['name']}: this is dose {n + 1} today — more than the {max_day} a day on your plan. "
                       "Check the label or with your pharmacist before taking more.")
    gap = med.get("min_hours_between")
    if gap:
        moments = [m for m in (_moment(d.get("at")) for d in taken) if m is not None and m <= at]
        if moments:
            last = max(moments)
            hours = (at - last).total_seconds() / 3600
            if hours < gap:
                out.append(f"{med['name']}: only {hours:.1f} h since the last dose (your plan says at least {gap:g} h apart).")
    return out
