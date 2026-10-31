"""The file as text (search, Drive AI, chat) and its reminders."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from app.items.kinds.mealplan import foods, grocery, units
from app.items.kinds.mealplan.actions import js_weekday
from app.items.spec import ItemContext, Reminder, text_now

MAX_TEXT = 20_000
WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def _recipe_line(r: dict) -> str:
    bits = [r["title"]]
    meta = []
    if r.get("total_min"):
        meta.append(f"{r['total_min']} min")
    meta.append(f"serves {units.fmt_number(r.get('servings') or 4)}")
    if r.get("cuisine"):
        meta.append(r["cuisine"])
    if r.get("rating"):
        meta.append("★" * r["rating"])
    if r.get("times_cooked"):
        meta.append(f"cooked {r['times_cooked']}×")
    if r.get("tags"):
        meta.append("#" + " #".join(r["tags"][:6]))
    bits.append(f"({', '.join(meta)})")
    return " ".join(bits) + f" [id {r['id']}]"


def to_text(data: dict) -> str:
    prefs = data.get("preferences", {})
    recipes = {r["id"]: r for r in data.get("recipes", [])}
    out: list[str] = []

    p = [f"household of {prefs.get('household_size', 2)}"]
    for label, key in (("diets", "diets"), ("allergies", "allergies"), ("dislikes", "dislikes"), ("likes", "cuisines")):
        if prefs.get(key):
            p.append(f"{label}: {', '.join(prefs[key])}")
    if prefs.get("weeknight_minutes"):
        p.append(f"weeknights ≤ {prefs['weeknight_minutes']} min")
    p.append(f"plans {', '.join(prefs.get('slots', ['dinner']))}")
    p.append(f"{prefs.get('budget', 'medium')} budget, {prefs.get('skill', 'intermediate')} cook, {prefs.get('units', 'metric')}")
    out.append("Preferences: " + "; ".join(p))

    today = text_now().date()
    out.insert(0, f"Today: {WEEKDAYS[js_weekday(today)]} {today.isoformat()}")
    allergies = prefs.get("allergies", [])
    flagged: dict[str, str] = {}

    def day_lines(entries: list[dict]) -> list[str]:
        by_day: dict[str, list[str]] = {}
        for e in entries:
            r = recipes.get(e.get("recipe_id") or "")
            name = e.get("title") or (r["title"] if r else "")
            tag = " (leftovers)" if e.get("leftovers_of") else ""
            done = " ✓" if e.get("cooked") else ""
            warn = ""
            if r and allergies:
                if r["id"] not in flagged:
                    rep = foods.allergen_report(r.get("ingredients", []), allergies)
                    flagged[r["id"]] = ", ".join(rep)
                if flagged[r["id"]]:
                    warn = f" ⚠ contains {flagged[r['id']]}"
            by_day.setdefault(e["date"], []).append(f"{e['slot']}: {name}{tag}{done}{warn}")
        lines = []
        for d, meals in by_day.items():
            try:
                wd = WEEKDAYS[js_weekday(date.fromisoformat(d))][:3]
            except ValueError:
                wd = ""
            lines.append(f"- {wd} {d}: " + "; ".join(meals))
        return lines

    plan = data.get("plan", [])
    t_iso = today.isoformat()
    upcoming = sorted((e for e in plan if e["date"] >= t_iso), key=lambda e: e["date"])[:60]
    past = sorted((e for e in plan if e["date"] < t_iso), key=lambda e: e["date"], reverse=True)[:40]
    if upcoming:
        out.append("\nMeal plan, today onwards:")
        out.extend(day_lines(upcoming))
    if past:
        out.append("\nEarlier meals (newest first):")
        out.extend(day_lines(past))

    g = data.get("grocery", {})
    open_items = [i for i in g.get("items", []) if not i.get("checked")]
    if g.get("items"):
        rng = f" for {g['start']} – {g['end']}" if g.get("start") else ""
        out.append(f"\nGrocery list{rng}: {len(open_items)} to buy, {len(g['items']) - len(open_items)} checked")
        by_aisle: dict[str, list[str]] = {}
        for i in open_items:
            amt = grocery.amounts_text(i.get("amounts", []))
            by_aisle.setdefault(i.get("aisle", "other"), []).append(i["name"] + (f" {amt}" if amt else ""))
        for a in prefs.get("aisle_order") or foods.AISLE_ORDER:
            if a in by_aisle:
                out.append(f"- {foods.AISLES.get(a, a)}: " + ", ".join(by_aisle[a]))

    if data.get("pantry"):
        out.append("\nPantry: " + ", ".join(
            x["name"] + (f" ({units.fmt_qty(x['qty'], x.get('unit') or '')})" if x.get("qty") is not None else "")
            for x in data["pantry"][:150]
        ))

    rs = data.get("recipes", [])
    if rs:
        out.append(f"\nRecipe box ({len(rs)} recipes):")
        newest = sorted(rs, key=lambda r: (r.get("last_cooked") or r.get("added") or ""), reverse=True)
        for r in newest:
            out.append("- " + _recipe_line(r))
        out.append("\nRecipes in detail:")
        for r in newest:
            ing = "; ".join(units.ingredient_text(i) for i in r.get("ingredients", [])[:40])
            block = f"## {r['title']}\nIngredients: {ing}"
            if r.get("prep_ahead"):
                block += f"\nAhead: {r['prep_ahead']}"
            if r.get("steps"):
                block += "\nSteps: " + " ".join(f"{n}. {s}" for n, s in enumerate(r["steps"][:12], 1))[:1200]
            if sum(len(x) for x in out) + len(block) > MAX_TEXT:
                break
            out.append(block)
    text = "\n".join(out)
    return text[:MAX_TEXT]


# ---------------------------------------------------------------- reminders


def _at(d: date, hhmm: str, ctx: ItemContext) -> datetime:
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except ValueError:
        h, m = 19, 0
    return datetime.combine(d, time(h, m), tzinfo=ctx.tz)


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    prefs = data.get("preferences", {})
    out: list[Reminder] = []
    today = ctx.today
    if prefs.get("prep_reminders", True):
        recipes = {r["id"]: r for r in data.get("recipes", [])}
        by_day: dict[str, list[tuple[str, str]]] = {}
        horizon = (today + timedelta(days=9)).isoformat()
        for e in data.get("plan", []):
            if not (today.isoformat() < e["date"] <= horizon) or e.get("cooked") or e.get("leftovers_of"):
                continue
            r = recipes.get(e.get("recipe_id") or "")
            if r and r.get("prep_ahead"):
                by_day.setdefault(e["date"], []).append((r["title"], r["prep_ahead"]))
        for d, items in by_day.items():
            due = _at(date.fromisoformat(d) - timedelta(days=1), prefs.get("prep_reminder_time", "19:00"), ctx)
            if due <= ctx.now:
                continue
            names = ", ".join(t for t, _ in items)
            body = " ".join(f"{t}: {a}" for t, a in items) if len(items) > 1 else items[0][1]
            out.append(Reminder(key=f"prep:{d}", due_at=due, title=f"Prep for tomorrow — {names}"[:200], body=body[:1000]))
    if prefs.get("shopping_reminder"):
        n_open = sum(1 for i in data.get("grocery", {}).get("items", []) if not i.get("checked"))
        for k in range(0, 9):
            d = today + timedelta(days=k)
            if js_weekday(d) != prefs.get("shopping_day", 6):
                continue
            due = _at(d, prefs.get("shopping_time", "09:00"), ctx)
            if due <= ctx.now:
                continue
            body = (f"{n_open} item{'s' if n_open != 1 else ''} on your grocery list." if n_open
                    else "Your list is empty — generate it from this week's plan.")
            out.append(Reminder(key=f"shop:{d.isoformat()}", due_at=due, title="Shopping day", body=body))
    return out
