"""The file as text (search, Drive AI, chat) and its reminders."""
from __future__ import annotations

from datetime import datetime, time, timedelta

from app.items.kinds.meals import science
from app.items.kinds.meals.models import hydrate
from app.items.spec import ItemContext, Reminder, text_now

MAX_CHARS = 20_000


def _f(n: float | None) -> str:
    return "–" if n is None else f"{round(float(n)):,}"


def to_text(data: dict) -> str:
    today = text_now().date().isoformat()
    data = _recent_full(data, keep=70)
    prof = data.get("profile") or {}
    t = data.get("targets") or {}
    s = data.get("settings") or {}
    all_slots = s.get("meal_slots") or []
    slots = {x["id"]: x["name"] for x in all_slots if not x.get("hidden")}
    slots.update({x["id"]: f"{x['name']} (removed meal)" for x in all_slots if x.get("hidden")})
    lines: list[str] = []
    goal = prof.get("goal") or "maintain"
    rate = f" at {prof.get('rate_pct')}% body weight/week" if goal != "maintain" and prof.get("rate_pct") else ""
    bits = [f"Goal: {goal}{rate}"]
    if prof.get("weight_kg"):
        bits.append(f"weight {prof['weight_kg']} kg")
    if prof.get("goal_weight_kg"):
        bits.append(f"goal weight {prof['goal_weight_kg']} kg")
    if prof.get("activity"):
        bits.append(f"activity {prof['activity'].replace('_', ' ')}")
    if prof.get("diet_style") and prof["diet_style"] != "balanced":
        bits.append(f"diet {prof['diet_style'].replace('_', ' ')}")
    if prof.get("diet_tags"):
        bits.append(", ".join(prof["diet_tags"]))
    if prof.get("allergies"):
        bits.append(f"allergies: {prof['allergies']}")
    lines.append("; ".join(bits) + ".")
    lines.append(
        f"Daily targets ({t.get('mode', 'auto')}): {_f(t.get('kcal'))} kcal, protein {_f(t.get('protein'))} g, carbs {_f(t.get('carbs'))} g, "
        f"fat {_f(t.get('fat'))} g, fibre {_f(t.get('fibre'))} g, water {_f(t.get('water_ml'))} ml."
    )
    for wd, over in (t.get("weekday") or {}).items():
        lines.append(f"  {wd.title()}: " + ", ".join(f"{k} {_f(v)}" for k, v in over.items() if v is not None))
    days = data.get("days") or {}
    tday = days.get(today) or {}
    ttot = science.total(tday.get("entries", []))
    ttgt = science.targets_for(t, today)
    lines.append(
        f"Today is {today}: eaten {_f(ttot['kcal'])} of {_f(ttgt['kcal'])} kcal, "
        f"{_f((ttgt['kcal'] or 0) - ttot['kcal'])} kcal and {_f((ttgt['protein'] or 0) - ttot['protein'])} g protein left"
        + (" (day marked complete)." if tday.get("complete") else ".")
    )
    logged = [d for d in sorted(days, reverse=True) if d <= today and (days[d].get("entries") or days[d].get("water_ml"))]
    planned = [d for d in sorted(days) if d > today and days[d].get("entries")]
    if planned:
        lines.append("Planned ahead: " + ", ".join(f"{d} ({_f(science.total(days[d]['entries'])['kcal'])} kcal)" for d in planned[:7]))
    if logged:
        lines.append("")
        lines.append("Diary (newest first):")
    for d in logged[:60]:
        day = days[d]
        tot = science.total(day.get("entries", []))
        tgt = science.targets_for(t, d)
        head = (
            f"{d}: {_f(tot['kcal'])} / {_f(tgt['kcal'])} kcal · P {_f(tot['protein'])} g · C {_f(tot['carbs'])} g · F {_f(tot['fat'])} g · fibre {_f(tot['fibre'])} g"
            + (f" · water {day['water_ml']} ml" if day.get("water_ml") else "")
            + (" · complete" if day.get("complete") else "")
        )
        lines.append(head)
        if len("\n".join(lines)) < MAX_CHARS * 0.75:
            groups = list(slots.items()) + [(sid, "Other") for sid in sorted({e["slot"] for e in day.get("entries", [])} - set(slots))]
            for sid, name in groups:
                es = [e for e in day.get("entries", []) if e["slot"] == sid]
                if es:
                    items = ", ".join(
                        f"{e['name']} ({e['amount']:g} {e.get('serving_label') or e['unit']}, {'~' if e.get('estimate') else ''}{_f(e['n']['kcal'])} kcal)"
                        for e in es
                    )
                    lines.append(f"  {name}: {items}")
            if day.get("note"):
                lines.append(f"  Note: {day['note'][:200]}")
        if len("\n".join(lines)) > MAX_CHARS * 0.85:
            break
    w = data.get("weighins") or []
    if w:
        lines.append("")
        lines.append("Weigh-ins: " + ", ".join(f"{x['date']} {x['kg']} kg" for x in reversed(w[-12:])))
    meals = data.get("meals") or []
    if meals:
        lines.append("")
        lines.append("Saved meals: " + "; ".join(f"{m['name']} ({_f(sum(i['n']['kcal'] for i in m['items']))} kcal)" for m in meals[:40]))
    foods = data.get("foods") or []
    if foods:
        lines.append("")
        lines.append(
            "My foods: "
            + "; ".join(f"{f['name']}{' (' + f['brand'] + ')' if f.get('brand') else ''} {_f(f['per100']['kcal'])} kcal/100 g" for f in foods[:150])
        )
    return "\n".join(lines)[:MAX_CHARS]


def _recent_full(data: dict, keep: int) -> dict:
    """The file with defaults filled in, but only its newest ``keep`` days
    (to_text and reminders never look further back — no need to rebuild
    years of entries on every save)."""
    days = data.get("days") or {}
    recent = {d: days[d] for d in sorted(days)[-keep:]}
    try:
        return hydrate({**data, "days": recent})
    except Exception:  # noqa: BLE001 — text for an odd file beats no text
        return {**data, "days": recent}


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    lo, hi = ctx.today.isoformat(), (ctx.today + timedelta(days=8)).isoformat()
    days = data.get("days") or {}
    data = _recent_full({**data, "days": {d: v for d, v in days.items() if lo <= d <= hi}}, keep=10)
    s = data.get("settings") or {}
    if not s.get("reminders"):
        return []
    out: list[Reminder] = []
    days = data.get("days") or {}
    for i in range(8):
        d = ctx.today + timedelta(days=i)
        ds = d.isoformat()
        day = days.get(ds) or {}
        logged = {e["slot"] for e in day.get("entries", [])}
        for slot in s.get("meal_slots") or []:
            at = slot.get("remind_at")
            if not at or slot.get("hidden") or slot["id"] in logged:
                continue
            hh, mm = (int(x) for x in at.split(":"))
            due = datetime.combine(d, time(hh, mm), tzinfo=ctx.tz)
            if due <= ctx.now:
                continue
            out.append(
                Reminder(
                    key=f"meal:{ds}:{slot['id']}",
                    due_at=due,
                    title=f"Log your {slot['name'].lower()}",
                    body="A quick tap now keeps your day accurate.",
                )
            )
        close = s.get("close_day_at")
        if close and not day.get("complete"):
            hh, mm = (int(x) for x in close.split(":"))
            due = datetime.combine(d, time(hh, mm), tzinfo=ctx.tz)
            if due > ctx.now:
                out.append(
                    Reminder(
                        key=f"close:{ds}",
                        due_at=due,
                        title="Finish today's food log",
                        body="Add anything missing and mark the day complete — it sharpens your expenditure estimate.",
                    )
                )
    return out
