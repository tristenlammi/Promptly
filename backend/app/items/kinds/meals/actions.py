"""The Meals & Macros actions — the AI's (and chat's) hands.

Deterministic for (data, args, ctx.now): new ids are hashes of the inputs
and ``ctx.now``, never random.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.items.kinds.meals import science
from app.items.kinds.meals import search as food_search
from app.items.kinds.meals.foods_db import builtin_foods
from app.items.kinds.meals.models import DAY_RE, MACRO_KEYS, MAX_VISIBLE_SLOTS, MICROS, TIME_RE, WEEKDAYS, hydrate
from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

LB = 0.45359237


# ------------------------------------------------------------------ helpers


def _mkid(prefix: str, taken: set[str], *parts: Any) -> str:
    raw = json.dumps(parts, sort_keys=True, default=str)
    base = prefix + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    out, n = base, 2
    while out in taken:
        out, n = f"{base}{n}", n + 1
    taken.add(out)
    return out


def _all_entry_ids(data: dict) -> set[str]:
    return {e["id"] for d in data["days"].values() for e in d.get("entries", [])}


def _day_str(ctx: ItemContext, d: str | None) -> str:
    if not d:
        return ctx.today.isoformat()
    d = d.strip().lower()
    if d == "today":
        return ctx.today.isoformat()
    if d == "yesterday":
        return (ctx.today - timedelta(days=1)).isoformat()
    if d == "tomorrow":
        return (ctx.today + timedelta(days=1)).isoformat()
    if not DAY_RE.match(d):
        raise ActionError(f"Dates are YYYY-MM-DD (got {d!r}).")
    try:
        date.fromisoformat(d)
    except ValueError as e:
        raise ActionError(f"{d} isn't a real date.") from e
    return d


def _day(data: dict, d: str, create: bool = True) -> dict | None:
    day = data["days"].get(d)
    if day is None and create:
        day = {"entries": [], "water_ml": 0, "note": "", "complete": False}
        data["days"][d] = day
    return day


def _slots(data: dict) -> list[dict]:
    """The meals you can log into (removed ones with history are hidden)."""
    return [s for s in data["settings"]["meal_slots"] if not s.get("hidden")]


def _slot_name(data: dict, sid: str) -> str:
    s = next((s for s in data["settings"]["meal_slots"] if s["id"] == sid), None)
    return s["name"] if s else sid.title()


def _guess_slot(data: dict, ctx: ItemContext) -> str:
    ids = [s["id"] for s in _slots(data)]
    h = ctx.now.hour + ctx.now.minute / 60
    want = "breakfast" if h < 10.5 else "lunch" if h < 15 else "snacks" if h < 17 else "dinner" if h < 21.5 else "snacks"
    if want in ids:
        return want
    return ids[-1]


def _slot(data: dict, ctx: ItemContext, given: str | None) -> str:
    if not given:
        return _guess_slot(data, ctx)
    g = given.strip().lower()
    for s in _slots(data):
        if s["id"] == g or s["name"].lower() == g:
            return s["id"]
    aliases = {"snack": "snacks", "brunch": "breakfast", "supper": "dinner", "tea": "dinner", "morning": "breakfast", "evening": "dinner"}
    a = aliases.get(g)
    if a and any(s["id"] == a for s in _slots(data)):
        return a
    for s in _slots(data):
        if g in s["name"].lower() or s["name"].lower() in g:
            return s["id"]
    raise ActionError(f"There's no meal called {given!r} — the meals are {', '.join(s['name'] for s in _slots(data))}.")


def _food_name(food: dict) -> str:
    return f"{food['name']} ({food['brand']})" if food.get("brand") else food["name"]


def _brief_n(n: dict) -> dict:
    return {k: round(float(n.get(k) or 0), 1) for k in ("kcal", "protein", "carbs", "fat", "fibre")}


def _day_totals(data: dict, d: str) -> dict:
    day = data["days"].get(d) or {}
    return science.total(day.get("entries", []))


def _remaining(data: dict, d: str) -> dict:
    t = _day_totals(data, d)
    tgt = science.targets_for(data["targets"], d)
    day = data["days"].get(d) or {}
    return {
        "kcal": round((tgt["kcal"] or 0) - t["kcal"]),
        "protein": round((tgt["protein"] or 0) - t["protein"]),
        "carbs": round((tgt["carbs"] or 0) - t["carbs"]),
        "fat": round((tgt["fat"] or 0) - t["fat"]),
        "fibre": round((tgt["fibre"] or 0) - t["fibre"]),
        "water_ml": int((tgt["water_ml"] or 0) - (day.get("water_ml") or 0)),
    }


def _sync_weight(data: dict) -> None:
    if data["weighins"]:
        data["profile"]["weight_kg"] = round(float(data["weighins"][-1]["kg"]), 1)


# ------------------------------------------------------------- food lines


class FoodLine(BaseModel):
    name: str = Field(min_length=1, max_length=120, description="What was eaten, e.g. 'Scrambled eggs'")
    food_id: str | None = Field(
        default=None,
        description="A library food id or built-in ref ('b:egg') from search_foods. When given, nutrition is "
        "computed from the food and the amount; leave the nutrient fields out.",
    )
    slot: str | None = Field(default=None, description="Meal (id or name); default the call's slot or the time of day")
    amount: float = Field(default=1, gt=0, le=100_000, description="How much, in `unit`")
    unit: Literal["g", "ml", "oz", "serving", "cup", "tbsp", "tsp", "floz"] = Field(
        default="serving", description="g / ml / oz, servings, or cup (240 ml) / tbsp / tsp / floz for drinks, milk, oils, honey…"
    )
    serving_id: str | None = Field(default=None, description="Which of the food's servings (with unit='serving')")
    portion: str | None = Field(default=None, max_length=60, description="Portion as words for free-text items: '2 large eggs', '1 slice'")
    grams: float | None = Field(default=None, ge=0, le=100_000, description="Estimated weight of the portion, if known")
    brand: str | None = Field(default=None, max_length=80)
    kcal: float | None = Field(default=None, ge=0, le=20_000, description="Energy for the WHOLE portion (free-text items)")
    protein: float | None = Field(default=None, ge=0, le=2000)
    carbs: float | None = Field(default=None, ge=0, le=2000)
    fat: float | None = Field(default=None, ge=0, le=2000)
    fibre: float | None = Field(default=None, ge=0, le=500)
    sugar: float | None = Field(default=None, ge=0, le=2000)
    sat_fat: float | None = Field(default=None, ge=0, le=2000)
    sodium_mg: float | None = Field(default=None, ge=0, le=100_000)
    estimate: bool = Field(default=True, description="True when the nutrition is your estimate (always for described food)")
    time: str | None = Field(default=None, description="HH:MM")
    note: str | None = Field(default=None, max_length=200)
    save_as_food: bool = Field(default=False, description="Also save it to the food library (needs grams)")


def _portion(data: dict, line: FoodLine) -> dict:
    """A portion dict (name, amount, n…) from a line."""
    if line.food_id:
        food = science.resolve_food(data, line.food_id)
        if food is None:
            raise ActionError(f"No food {line.food_id!r} — use search_foods to find its id, or describe it with nutrition.")
        grams, label = science.grams_for(food, line.amount, line.unit, line.serving_id)
        if grams is None:
            raise ActionError(f"{food['name']} can't be measured in {line.unit} — give g, ml, oz or servings.")
        serving = science.serving_of(food, line.serving_id) if line.unit == "serving" else None
        return {
            "name": food["name"],
            "brand": food.get("brand", ""),
            "food_ref": food["id"],
            "amount": line.amount,
            "unit": line.unit,
            "serving_id": serving["id"] if serving else None,
            "serving_label": label,
            "grams": round(grams, 1),
            "n": science.scale(food["per100"], grams),
            "estimate": False,
        }
    given = [line.kcal, line.protein, line.carbs, line.fat]
    if all(v is None for v in given):
        raise ActionError(f"“{line.name}” needs a food_id or its nutrition (at least kcal or macros).")
    p, c, f = line.protein or 0, line.carbs or 0, line.fat or 0
    kcal = line.kcal if line.kcal is not None else science.kcal_from_macros(p, c, f)
    n = {
        "kcal": kcal,
        "protein": p,
        "carbs": c,
        "fat": f,
        "fibre": line.fibre or 0,
        "sugar": line.sugar or 0,
        "sat_fat": line.sat_fat or 0,
        "sodium": line.sodium_mg or 0,
        "micros": {},
    }
    unit = line.unit
    amount = line.amount
    label = (line.portion or "").strip()
    if unit == "serving" and not label:
        label = "1 portion" if amount == 1 else "portion"
    return {
        "name": line.name.strip(),
        "brand": (line.brand or "").strip(),
        "food_ref": None,
        "amount": amount,
        "unit": unit,
        "serving_id": None,
        "serving_label": label[:60],
        "grams": round(line.grams, 1) if line.grams else _free_grams(amount, unit),
        "n": n,
        "estimate": bool(line.estimate),
    }


def _free_grams(amount: float, unit: str) -> float | None:
    if unit == "serving":
        return None
    g, _ = science.grams_for(None, amount, unit, None)
    return round(g, 1) if g is not None else None


def _food_from_portion(data: dict, ctx: ItemContext, por: dict, source: str = "ai") -> str | None:
    grams = por.get("grams")
    if not grams:
        return None
    taken = {f["id"] for f in data["foods"]}
    fid = _mkid("f", taken, por["name"], grams, ctx.now.isoformat())
    per100 = science.scale_totals(por["n"], 100.0 / grams)
    servings = []
    if por.get("serving_label") and por["unit"] == "serving":
        servings.append({"id": "s1", "label": por["serving_label"], "grams": round(grams / (por["amount"] or 1), 1)})
    data["foods"].append(
        {
            "id": fid,
            "name": por["name"],
            "brand": por.get("brand", ""),
            "barcode": None,
            "servings": servings,
            "default_serving": "s1" if servings else None,
            "per100": per100,
            "liquid": por["unit"] == "ml",
            "source": source,
            "notes": "Estimated nutrition" if por.get("estimate") else "",
            "created": ctx.now.isoformat(),
        }
    )
    return fid


# ------------------------------------------------------------------- diary


class LogFoods(BaseModel):
    date: str | None = Field(default=None, description="YYYY-MM-DD (or 'today'/'yesterday'); default today")
    slot: str | None = Field(default=None, description="Meal for every line that doesn't name one (id or name)")
    items: list[FoodLine] = Field(min_length=1, max_length=40)
    source: Literal["ai", "food", "quick", "mealplan"] = Field(default="ai", description="'mealplan' when logging a planned recipe")


def log_foods(ctx: ItemContext, data: dict, p: LogFoods) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    default_slot = _slot(data, ctx, p.slot) if p.slot else None
    taken = _all_entry_ids(data)
    portions = []
    for i, line in enumerate(p.items):
        por = _portion(data, line)
        slot = _slot(data, ctx, line.slot) if line.slot else (default_slot or _guess_slot(data, ctx))
        portions.append((line, por, slot, i))
    day = _day(data, d)
    if len(day["entries"]) + len(portions) > 80:
        raise ActionError("That's more than one day can hold (80 entries).")
    made = []
    now_hm = ctx.now.strftime("%H:%M") if d == ctx.today.isoformat() else None
    for line, por, slot, i in portions:
        eid = _mkid("e", taken, d, slot, por["name"], i, ctx.now.isoformat())
        source = p.source
        if por["food_ref"] and source == "ai":
            source = "food"
        entry = {
            **por,
            "id": eid,
            "slot": slot,
            "source": source,
            "time": line.time if line.time and TIME_RE.match(line.time) else now_hm,
            "note": (line.note or "")[:200],
        }
        day["entries"].append(entry)
        if line.save_as_food and not por["food_ref"]:
            fid = _food_from_portion(data, ctx, por)
            if fid:
                entry["food_ref"] = fid
        made.append(entry)
    kcal = sum(e["n"]["kcal"] for e in made)
    est = any(e["estimate"] for e in made)
    names = ", ".join(e["name"] for e in made[:4]) + (f" +{len(made) - 4}" if len(made) > 4 else "")
    slots = sorted({_slot_name(data, e["slot"]) for e in made})
    return ActionOutcome(
        summary=f"Logged {names} to {' & '.join(slots)} — {'~' if est else ''}{round(kcal)} kcal",
        result={
            "date": d,
            "entries": [{"id": e["id"], "name": e["name"], "slot": e["slot"], **_brief_n(e["n"]), "estimate": e["estimate"]} for e in made],
            "day_total": _brief_n(_day_totals(data, d)),
            "remaining": _remaining(data, d),
        },
    )


class EditEntry(BaseModel):
    date: str | None = Field(default=None, description="The day the entry is on; default today")
    entry_id: str
    amount: float | None = Field(default=None, gt=0, le=100_000)
    unit: Literal["g", "ml", "oz", "serving", "cup", "tbsp", "tsp", "floz"] | None = None
    serving_id: str | None = None
    slot: str | None = Field(default=None, description="Move it to another meal")
    move_to_date: str | None = Field(default=None, description="Move it to another day")
    name: str | None = Field(default=None, max_length=120)
    time: str | None = None
    note: str | None = Field(default=None, max_length=200)
    kcal: float | None = Field(default=None, ge=0, le=20_000, description="Replace the totals (free-text entries)")
    protein: float | None = Field(default=None, ge=0, le=2000)
    carbs: float | None = Field(default=None, ge=0, le=2000)
    fat: float | None = Field(default=None, ge=0, le=2000)
    fibre: float | None = Field(default=None, ge=0, le=500)


def _find_entry(data: dict, d: str, eid: str) -> tuple[str, dict, dict]:
    """(the day it's really on, that day, the entry)."""
    day = data["days"].get(d)
    e = next((e for e in (day or {}).get("entries", []) if e["id"] == eid), None)
    if e is None:
        # Be forgiving: find it on any day.
        for dd, dy in data["days"].items():
            e = next((x for x in dy.get("entries", []) if x["id"] == eid), None)
            if e is not None:
                return dd, dy, e
        raise ActionError(f"No entry {eid!r} on {d}.")
    return d, day, e  # type: ignore[return-value]


def edit_entry(ctx: ItemContext, data: dict, p: EditEntry) -> ActionOutcome:
    d, day, e = _find_entry(data, _day_str(ctx, p.date), p.entry_id)
    if p.amount is not None or p.unit is not None or p.serving_id is not None:
        amount = p.amount if p.amount is not None else e["amount"]
        unit = p.unit or (e["unit"] if e["unit"] != "kcal" else "serving")
        sid = p.serving_id if p.serving_id is not None else e.get("serving_id")
        food = science.resolve_food(data, e.get("food_ref"))
        if food is not None:
            grams, label = science.grams_for(food, amount, unit, sid)
            if grams is None:
                raise ActionError(f"{food['name']} can't be measured in {unit} — give g, ml, oz or servings.")
            e["n"] = science.scale(food["per100"], grams)
            e["grams"] = round(grams, 1)
            e["serving_label"] = label
            s = science.serving_of(food, sid) if unit == "serving" else None
            e["serving_id"] = s["id"] if s else None
        else:
            old_g = e.get("grams")
            new_g, _ = science.grams_for(None, amount, unit, None) if unit != "serving" else (None, "")
            if old_g and new_g:
                factor = new_g / old_g
                e["grams"] = round(new_g, 1)
            elif unit == e["unit"] and e["amount"]:
                factor = amount / e["amount"]
                if e.get("grams"):
                    e["grams"] = round(e["grams"] * factor, 1)
            else:
                raise ActionError("I can't convert this entry to that unit — give the new nutrition instead.")
            e["n"] = science.scale_totals(e["n"], factor)
        e["amount"] = amount
        e["unit"] = unit
    over = {"kcal": p.kcal, "protein": p.protein, "carbs": p.carbs, "fat": p.fat, "fibre": p.fibre}
    if any(v is not None for v in over.values()):
        for k, v in over.items():
            if v is not None:
                e["n"][k] = round(v, 1)
        if p.kcal is None and any(over[k] is not None for k in ("protein", "carbs", "fat")):
            e["n"]["kcal"] = science.kcal_from_macros(e["n"]["protein"], e["n"]["carbs"], e["n"]["fat"])
    if p.name:
        e["name"] = p.name.strip()
    if p.time is not None:
        e["time"] = p.time if TIME_RE.match(p.time) else None
    if p.note is not None:
        e["note"] = p.note[:200]
    if p.slot:
        e["slot"] = _slot(data, ctx, p.slot)
    where = d
    if p.move_to_date:
        to = _day_str(ctx, p.move_to_date)
        if to != d:
            day["entries"].remove(e)
            dest = _day(data, to)
            if len(dest["entries"]) >= 80:
                raise ActionError("That day is full.")
            dest["entries"].append(e)
            where = to
    return ActionOutcome(
        summary=f"Updated {e['name']} on {where} ({round(e['n']['kcal'])} kcal)",
        result={"entry": {"id": e["id"], "date": where, "slot": e["slot"], **_brief_n(e["n"])}},
    )


class DeleteEntries(BaseModel):
    date: str | None = Field(default=None, description="Default today")
    entry_ids: list[str] = Field(min_length=1, max_length=80)


def delete_entries(ctx: ItemContext, data: dict, p: DeleteEntries) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    gone = []
    for eid in p.entry_ids:
        try:
            d, day, e = _find_entry(data, d, eid)
        except ActionError:
            continue
        day["entries"].remove(e)
        gone.append(e["name"])
    if not gone:
        raise ActionError("None of those entries exist.")
    return ActionOutcome(summary=f"Removed {', '.join(gone[:4])}{'…' if len(gone) > 4 else ''}", result={"removed": len(gone), "day_total": _brief_n(_day_totals(data, d))})


class CopyDay(BaseModel):
    from_date: str = Field(description="YYYY-MM-DD or 'yesterday'")
    to_date: str | None = Field(default=None, description="Default today")
    slots: list[str] | None = Field(default=None, description="Only these meals (ids or names); default all")
    to_slot: str | None = Field(default=None, description="Put everything into this meal instead (e.g. copy lunch → dinner)")
    replace: bool = Field(default=False, description="Clear those meals on the target day first")


def copy_day(ctx: ItemContext, data: dict, p: CopyDay) -> ActionOutcome:
    src = _day_str(ctx, p.from_date)
    dst = _day_str(ctx, p.to_date)
    sday = data["days"].get(src)
    if not sday or not sday.get("entries"):
        raise ActionError(f"Nothing is logged on {src}.")
    slots = {_slot(data, ctx, s) for s in p.slots} if p.slots else None
    to_slot = _slot(data, ctx, p.to_slot) if p.to_slot else None
    pick = [e for e in sday["entries"] if slots is None or e["slot"] in slots]
    if not pick:
        raise ActionError("Nothing in those meals on that day.")
    dday = _day(data, dst)
    if p.replace:
        clear = {to_slot} if to_slot else {e["slot"] for e in pick}
        dday["entries"] = [e for e in dday["entries"] if e["slot"] not in clear]
    if len(dday["entries"]) + len(pick) > 80:
        raise ActionError("That's more than one day can hold.")
    taken = _all_entry_ids(data)
    visible = {s["id"] for s in _slots(data)}
    for i, e in enumerate(pick):
        copy = json.loads(json.dumps(e))
        copy["id"] = _mkid("e", taken, dst, e["id"], i, ctx.now.isoformat())
        copy["source"] = "copy"
        copy["time"] = None
        if to_slot:
            copy["slot"] = to_slot
        elif copy["slot"] not in visible:
            copy["slot"] = _guess_slot(data, ctx)  # from a meal that's since been removed
        dday["entries"].append(copy)
    kcal = sum(e["n"]["kcal"] for e in pick)
    return ActionOutcome(summary=f"Copied {len(pick)} item(s) from {src} to {dst} ({round(kcal)} kcal)", result={"copied": len(pick), "day_total": _brief_n(_day_totals(data, dst))})


class LogWater(BaseModel):
    date: str | None = None
    ml: int = Field(ge=-5000, le=10_000, description="Millilitres (negative to take some back)")
    mode: Literal["add", "set"] = "add"


def log_water(ctx: ItemContext, data: dict, p: LogWater) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    day = _day(data, d)
    day["water_ml"] = max(0, min(20_000, (day["water_ml"] if p.mode == "add" else 0) + p.ml))
    tgt = science.targets_for(data["targets"], d)["water_ml"] or 0
    return ActionOutcome(summary=f"Water: {day['water_ml']} ml" + (f" of {tgt}" if tgt else ""), result={"water_ml": day["water_ml"], "target_ml": tgt})


class SetDay(BaseModel):
    date: str | None = None
    complete: bool | None = Field(default=None, description="Mark the day fully logged (used by the TDEE estimate)")
    note: str | None = Field(default=None, max_length=2000)


def set_day(ctx: ItemContext, data: dict, p: SetDay) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    day = _day(data, d)
    bits = []
    if p.complete is not None:
        day["complete"] = p.complete
        bits.append("marked complete" if p.complete else "reopened")
    if p.note is not None:
        day["note"] = p.note
        bits.append("note saved")
    return ActionOutcome(summary=f"{d}: {', '.join(bits) or 'no change'}", result={"date": d, "complete": day["complete"]})


class LogWeight(BaseModel):
    date: str | None = None
    weight: float = Field(gt=0, le=900)
    unit: Literal["kg", "lb"] = "kg"


def log_weight(ctx: ItemContext, data: dict, p: LogWeight) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    kg = round(p.weight * (LB if p.unit == "lb" else 1), 2)
    if not 20 <= kg <= 400:
        raise ActionError("That weight doesn't look right.")
    data["weighins"] = [w for w in data["weighins"] if w["date"] != d] + [{"date": d, "kg": kg}]
    data["weighins"].sort(key=lambda w: w["date"])
    if len(data["weighins"]) > 4000:
        data["weighins"] = data["weighins"][-4000:]
    _sync_weight(data)
    return ActionOutcome(summary=f"Weigh-in {d}: {p.weight:g} {p.unit}", result={"date": d, "kg": kg})


# ------------------------------------------------------------------- foods


class ServingIn(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    grams: float = Field(gt=0, le=5000)


class AddFood(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=80)
    barcode: str | None = Field(default=None, max_length=20)
    per: Literal["100g", "serving"] = Field(default="100g", description="Whether the nutrient numbers are per 100 g/ml or per serving")
    serving_label: str | None = Field(default=None, max_length=60, description="e.g. '1 bar', '1 cup'")
    serving_grams: float | None = Field(default=None, gt=0, le=5000, description="Grams in that serving (needed when per='serving')")
    servings: list[ServingIn] | None = Field(default=None, max_length=12, description="Extra serving sizes")
    kcal: float = Field(ge=0, le=10_000)
    protein: float = Field(default=0, ge=0, le=1000)
    carbs: float = Field(default=0, ge=0, le=1000)
    fat: float = Field(default=0, ge=0, le=1000)
    fibre: float = Field(default=0, ge=0, le=500)
    sugar: float = Field(default=0, ge=0, le=1000)
    sat_fat: float = Field(default=0, ge=0, le=1000)
    sodium_mg: float = Field(default=0, ge=0, le=100_000)
    micros: dict[str, float] | None = Field(default=None, description=f"Optional, same basis: {', '.join(MICROS)}")
    liquid: bool = False
    favourite: bool = False
    notes: str | None = Field(default=None, max_length=500)
    estimated: bool = Field(default=False, description="True when you estimated the numbers")


def _per100_from(p: AddFood | Any, factor: float) -> dict:
    return {
        "kcal": p.kcal * factor,
        "protein": p.protein * factor,
        "carbs": p.carbs * factor,
        "fat": p.fat * factor,
        "fibre": p.fibre * factor,
        "sugar": p.sugar * factor,
        "sat_fat": p.sat_fat * factor,
        "sodium": p.sodium_mg * factor,
        "micros": {k: v * factor for k, v in (p.micros or {}).items() if k in MICROS},
    }


def add_food(ctx: ItemContext, data: dict, p: AddFood) -> ActionOutcome:
    if len(data["foods"]) >= 3000:
        raise ActionError("Your food library is full (3000 foods). Delete some you don't use.")
    if p.per == "serving" and not p.serving_grams:
        raise ActionError("Per-serving numbers need the serving's weight in grams (serving_grams).")
    factor = 100.0 / p.serving_grams if p.per == "serving" and p.serving_grams else 1.0
    servings = []
    if p.serving_grams:
        servings.append({"id": "s1", "label": (p.serving_label or "1 serving")[:60], "grams": p.serving_grams})
    for s in p.servings or []:
        if len(servings) < 12:
            servings.append({"id": f"s{len(servings) + 1}", "label": s.label, "grams": s.grams})
    taken = {f["id"] for f in data["foods"]}
    fid = _mkid("f", taken, p.name, p.brand, p.kcal, ctx.now.isoformat())
    food = {
        "id": fid,
        "name": p.name.strip(),
        "brand": (p.brand or "").strip(),
        "barcode": p.barcode,
        "servings": servings,
        "default_serving": servings[0]["id"] if servings else None,
        "per100": _per100_from(p, factor),
        "liquid": p.liquid,
        "source": "ai" if p.estimated else "custom",
        "notes": (p.notes or ("Estimated nutrition" if p.estimated else ""))[:500],
        "created": ctx.now.isoformat(),
    }
    data["foods"].append(food)
    if p.favourite and fid not in data["favourites"]:
        data["favourites"].append(fid)
    return ActionOutcome(summary=f"Added {_food_name(food)} to your foods", result={"food_id": fid, "per100": _brief_n(food["per100"]), "servings": servings})


class EditFood(BaseModel):
    food_id: str
    name: str | None = Field(default=None, max_length=120)
    brand: str | None = Field(default=None, max_length=80)
    barcode: str | None = Field(default=None, max_length=20)
    per: Literal["100g", "serving"] = "100g"
    serving_grams: float | None = Field(default=None, gt=0, le=5000, description="Needed when per='serving'")
    kcal: float | None = Field(default=None, ge=0, le=10_000)
    protein: float | None = Field(default=None, ge=0, le=1000)
    carbs: float | None = Field(default=None, ge=0, le=1000)
    fat: float | None = Field(default=None, ge=0, le=1000)
    fibre: float | None = Field(default=None, ge=0, le=500)
    sugar: float | None = Field(default=None, ge=0, le=1000)
    sat_fat: float | None = Field(default=None, ge=0, le=1000)
    sodium_mg: float | None = Field(default=None, ge=0, le=100_000)
    servings: list[ServingIn] | None = Field(default=None, max_length=12, description="Replace the serving sizes")
    notes: str | None = Field(default=None, max_length=500)


def edit_food(ctx: ItemContext, data: dict, p: EditFood) -> ActionOutcome:
    if p.food_id.startswith("b:"):
        raise ActionError("Built-in foods can't be edited — add your own version with add_food.")
    food = next((f for f in data["foods"] if f["id"] == p.food_id), None)
    if food is None:
        raise ActionError(f"No food {p.food_id!r} in the library.")
    if p.per == "serving" and not p.serving_grams:
        raise ActionError("Per-serving numbers need serving_grams.")
    factor = 100.0 / p.serving_grams if p.per == "serving" and p.serving_grams else 1.0
    for k, key in (("kcal", "kcal"), ("protein", "protein"), ("carbs", "carbs"), ("fat", "fat"), ("fibre", "fibre"), ("sugar", "sugar"), ("sat_fat", "sat_fat"), ("sodium_mg", "sodium")):
        v = getattr(p, k)
        if v is not None:
            food["per100"][key] = round(v * factor, 1)
    if p.name:
        food["name"] = p.name.strip()
    if p.brand is not None:
        food["brand"] = p.brand.strip()
    if p.barcode is not None:
        food["barcode"] = p.barcode or None
    if p.notes is not None:
        food["notes"] = p.notes
    if p.servings is not None:
        food["servings"] = [{"id": f"s{i + 1}", "label": s.label, "grams": s.grams} for i, s in enumerate(p.servings)]
        food["default_serving"] = food["servings"][0]["id"] if food["servings"] else None
    return ActionOutcome(summary=f"Updated {_food_name(food)} (past entries keep their numbers)", result={"food_id": food["id"], "per100": _brief_n(food["per100"])})


class FoodRef(BaseModel):
    food_id: str


def delete_food(ctx: ItemContext, data: dict, p: FoodRef) -> ActionOutcome:
    food = next((f for f in data["foods"] if f["id"] == p.food_id), None)
    if food is None:
        raise ActionError(f"No food {p.food_id!r} in the library.")
    data["foods"].remove(food)
    data["favourites"] = [f for f in data["favourites"] if f != p.food_id]
    return ActionOutcome(summary=f"Deleted {_food_name(food)} (your diary keeps what you logged)")


class Favourite(BaseModel):
    food_id: str = Field(description="Library id or built-in ref")
    on: bool = True


def favourite_food(ctx: ItemContext, data: dict, p: Favourite) -> ActionOutcome:
    food = science.resolve_food(data, p.food_id)
    if food is None:
        raise ActionError(f"No food {p.food_id!r}.")
    if p.on and p.food_id not in data["favourites"]:
        data["favourites"].append(p.food_id)
    if not p.on:
        data["favourites"] = [f for f in data["favourites"] if f != p.food_id]
    return ActionOutcome(summary=f"{'Starred' if p.on else 'Unstarred'} {food['name']}")


# ------------------------------------------------------------- saved meals


class SaveMeal(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    from_date: str | None = Field(default=None, description="Save what was logged on this day…")
    from_slot: str | None = Field(default=None, description="…in this meal")
    entry_ids: list[str] | None = Field(default=None, max_length=40, description="…or exactly these entries")
    items: list[FoodLine] | None = Field(default=None, max_length=40, description="…or these items")
    slot: str | None = Field(default=None, description="The meal it's usually eaten at")


def save_meal(ctx: ItemContext, data: dict, p: SaveMeal) -> ActionOutcome:
    if len(data["meals"]) >= 300:
        raise ActionError("You have 300 saved meals — delete some first.")
    items: list[dict] = []
    if p.items:
        items = [_portion(data, line) for line in p.items]
    else:
        d = _day_str(ctx, p.from_date)
        day = data["days"].get(d) or {"entries": []}
        es = day["entries"]
        if p.entry_ids:
            es = [e for e in es if e["id"] in set(p.entry_ids)]
        elif p.from_slot:
            sid = _slot(data, ctx, p.from_slot)
            es = [e for e in es if e["slot"] == sid]
        keys = ("name", "brand", "food_ref", "amount", "unit", "serving_id", "serving_label", "grams", "n", "estimate")
        items = [{k: json.loads(json.dumps(e.get(k))) for k in keys} for e in es]
    if not items:
        raise ActionError("There's nothing to save — name the day and meal, entries, or items.")
    taken = {m["id"] for m in data["meals"]}
    mid = _mkid("m", taken, p.name, ctx.now.isoformat())
    slot = _slot(data, ctx, p.slot or p.from_slot) if (p.slot or p.from_slot) else None
    data["meals"].append({"id": mid, "name": p.name.strip(), "slot": slot, "items": items[:40], "created": ctx.now.isoformat()})
    kcal = sum(i["n"]["kcal"] for i in items)
    return ActionOutcome(summary=f"Saved the meal “{p.name}” ({len(items)} items, {round(kcal)} kcal)", result={"meal_id": mid})


class LogSavedMeal(BaseModel):
    meal: str = Field(description="Saved meal id or name")
    date: str | None = None
    slot: str | None = Field(default=None, description="Default the meal's usual slot, else the time of day")
    servings: float = Field(default=1, gt=0, le=20, description="Multiply every item (0.5 = half)")


def _find_meal(data: dict, ref: str) -> dict:
    m = next((m for m in data["meals"] if m["id"] == ref), None)
    if m is None:
        low = ref.strip().lower()
        m = next((m for m in data["meals"] if m["name"].lower() == low), None) or next(
            (m for m in data["meals"] if low in m["name"].lower()), None
        )
    if m is None:
        raise ActionError(f"No saved meal {ref!r}.")
    return m


def log_saved_meal(ctx: ItemContext, data: dict, p: LogSavedMeal) -> ActionOutcome:
    m = _find_meal(data, p.meal)
    d = _day_str(ctx, p.date)
    slot = _slot(data, ctx, p.slot) if p.slot else (m.get("slot") if m.get("slot") in {s["id"] for s in _slots(data)} else _guess_slot(data, ctx))
    day = _day(data, d)
    if len(day["entries"]) + len(m["items"]) > 80:
        raise ActionError("That day is full.")
    taken = _all_entry_ids(data)
    now_hm = ctx.now.strftime("%H:%M") if d == ctx.today.isoformat() else None
    for i, it in enumerate(m["items"]):
        e = json.loads(json.dumps(it))
        if p.servings != 1:
            e["n"] = science.scale_totals(e["n"], p.servings)
            e["amount"] = round(e["amount"] * p.servings, 2)
            if e.get("grams"):
                e["grams"] = round(e["grams"] * p.servings, 1)
        e.update(id=_mkid("e", taken, d, m["id"], i, ctx.now.isoformat()), slot=slot, source="meal", time=now_hm, note="")
        day["entries"].append(e)
    kcal = sum(i["n"]["kcal"] for i in m["items"]) * p.servings
    return ActionOutcome(summary=f"Logged “{m['name']}” to {_slot_name(data, slot)} — {round(kcal)} kcal", result={"day_total": _brief_n(_day_totals(data, d)), "remaining": _remaining(data, d)})


class MealRef(BaseModel):
    meal: str = Field(description="Saved meal id or name")


def delete_saved_meal(ctx: ItemContext, data: dict, p: MealRef) -> ActionOutcome:
    m = _find_meal(data, p.meal)
    data["meals"].remove(m)
    return ActionOutcome(summary=f"Deleted the saved meal “{m['name']}”")


# ----------------------------------------------------------------- targets


class WeekdayTarget(BaseModel):
    day: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    kcal: float | None = Field(default=None, ge=0, le=15_000)
    protein: float | None = Field(default=None, ge=0, le=1000)
    carbs: float | None = Field(default=None, ge=0, le=2000)
    fat: float | None = Field(default=None, ge=0, le=1000)


class SetTargets(BaseModel):
    kcal: float | None = Field(default=None, ge=800, le=15_000)
    protein: float | None = Field(default=None, ge=0, le=1000, description="g")
    carbs: float | None = Field(default=None, ge=0, le=2000, description="g")
    fat: float | None = Field(default=None, ge=0, le=1000, description="g")
    fibre: float | None = Field(default=None, ge=0, le=200, description="g")
    sodium_mg: float | None = Field(default=None, ge=0, le=20_000, description="Upper limit")
    sugar_g: float | None = Field(default=None, ge=0, le=1000, description="Upper limit (0 clears it)")
    water_ml: int | None = Field(default=None, ge=0, le=10_000)
    weekday: list[WeekdayTarget] | None = Field(default=None, max_length=7, description="Per-weekday overrides (e.g. higher on training days)")
    clear_weekday: bool = Field(default=False, description="Remove all weekday overrides")


def set_targets(ctx: ItemContext, data: dict, p: SetTargets) -> ActionOutcome:
    t = data["targets"]
    notes = []
    macros_given = any(v is not None for v in (p.protein, p.carbs, p.fat))
    energy_change = p.kcal is not None or macros_given
    if p.protein is not None:
        t["protein"] = round(p.protein)
    if p.carbs is not None:
        t["carbs"] = round(p.carbs)
    if p.fat is not None:
        t["fat"] = round(p.fat)
    if p.kcal is not None:
        if not macros_given:
            # Keep protein, share the rest between carbs and fat as before.
            rest = max(0.0, p.kcal - t["protein"] * 4)
            old = t["carbs"] * 4 + t["fat"] * 9 or 1
            t["carbs"] = round(rest * (t["carbs"] * 4 / old) / 4)
            t["fat"] = round(rest * (t["fat"] * 9 / old) / 9)
        t["kcal"] = round(p.kcal)
    elif macros_given:
        t["kcal"] = round(science.kcal_from_macros(t["protein"], t["carbs"], t["fat"]))
    macro_kcal = science.kcal_from_macros(t["protein"], t["carbs"], t["fat"])
    if t["kcal"] and abs(macro_kcal - t["kcal"]) / t["kcal"] > 0.08:
        notes.append(f"Note: the macros add up to {round(macro_kcal)} kcal, not {round(t['kcal'])}.")
    floor = science.FLOOR.get(data["profile"].get("sex"), 1350)
    if t["kcal"] < floor:
        notes.append(f"That's under {floor} kcal a day — very low intakes are best done with a clinician's support.")
    if p.fibre is not None:
        t["fibre"] = p.fibre
    if p.sodium_mg is not None:
        t["sodium"] = p.sodium_mg
    if p.sugar_g is not None:
        t["sugar"] = p.sugar_g or None
    if p.water_ml is not None:
        t["water_ml"] = p.water_ml
    if p.clear_weekday:
        t["weekday"] = {}
    for w in p.weekday or []:
        over = {k: getattr(w, k) for k in ("kcal", "protein", "carbs", "fat") if getattr(w, k) is not None}
        if over:
            t["weekday"][w.day] = over
        else:
            t["weekday"].pop(w.day, None)
    if energy_change:
        t["mode"] = "custom"
    t["updated"] = ctx.now.isoformat()
    data["profile"]["onboarded"] = True
    return ActionOutcome(
        summary=f"Targets: {round(t['kcal'])} kcal · P {round(t['protein'])} g · C {round(t['carbs'])} g · F {round(t['fat'])} g",
        result={"targets": {k: t[k] for k in ("kcal", "protein", "carbs", "fat", "fibre", "water_ml")}, "weekday": t["weekday"], "notes": notes},
    )


class WeightIn(BaseModel):
    date: str
    kg: float = Field(ge=20, le=400)


class ComputeTargets(BaseModel):
    sex: Literal["male", "female"] | None = None
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    age: int | None = Field(default=None, ge=13, le=110, description="Instead of birth_year")
    height_cm: float | None = Field(default=None, ge=90, le=250)
    weight_kg: float | None = Field(default=None, ge=25, le=350)
    activity: Literal["sedentary", "light", "moderate", "active", "very_active"] | None = None
    goal: Literal["lose", "maintain", "gain"] | None = None
    rate_pct: float | None = Field(default=None, ge=0, le=1.5, description="% of body weight per week (0.25–1 to lose, 0.1–0.5 to gain)")
    goal_weight_kg: float | None = Field(default=None, ge=25, le=350)
    diet_style: Literal["balanced", "high_protein", "low_carb", "keto", "low_fat"] | None = None
    protein_per_kg: float | None = Field(default=None, ge=0.6, le=3.3)
    use_adaptive: bool = Field(default=False, description="Base it on the adaptive TDEE estimate instead of the formula (when there's enough data)")
    weights: list[WeightIn] | None = Field(default=None, max_length=400, description="Weigh-ins (for use_adaptive) if you read them from the health item")
    apply: bool = Field(default=True, description="False = just preview the numbers")


async def _weights(ctx: ItemContext, data: dict, given: list[WeightIn] | None) -> list[tuple[str, float]]:
    own = [(w["date"], float(w["kg"])) for w in data.get("weighins") or []]
    if given:
        return science.merge_weights([(w.date, w.kg) for w in given if DAY_RE.match(w.date)], own)
    health: list[tuple[str, float]] = []
    if ctx.read_item is not None:
        try:
            got = await ctx.read_item("health")
        except Exception:  # noqa: BLE001 — a missing/odd health item just means no data
            got = None
        if got:
            health = science.weights_from_health(got[2])
    return science.merge_weights(health, own)


async def compute_targets(ctx: ItemContext, data: dict, p: ComputeTargets) -> ActionOutcome:
    prof = json.loads(json.dumps(data["profile"]))
    for k in ("sex", "birth_year", "height_cm", "weight_kg", "activity", "goal", "rate_pct", "goal_weight_kg", "diet_style", "protein_per_kg"):
        v = getattr(p, k)
        if v is not None:
            prof[k] = v
    if p.age is not None:
        prof["birth_year"] = ctx.today.year - p.age
    if prof.get("goal") == "maintain":
        prof["rate_pct"] = prof.get("rate_pct") or 0
    override = None
    tdee_info = None
    if p.use_adaptive:
        tdee_info = science.estimate_tdee(data, await _weights(ctx, data, p.weights), ctx.today)
        if tdee_info.get("adaptive_tdee") is None:
            raise ActionError("Not enough data for an adaptive estimate yet: " + "; ".join(tdee_info.get("needs") or []))
        override = tdee_info["tdee"]
    try:
        out = science.compute_targets(prof, ctx.today, tdee_override=override)
    except ValueError as e:
        raise ActionError(str(e)) from e
    if p.apply:
        data["profile"] = {**prof, "onboarded": True}
        t = data["targets"]
        t.update(
            mode="auto",
            kcal=out["kcal"],
            protein=out["protein"],
            carbs=out["carbs"],
            fat=out["fat"],
            fibre=out["fibre"],
            water_ml=out["water_ml"],
            basis=out["basis"],
            updated=ctx.now.isoformat(),
        )
    b = out["basis"]
    summary = (
        f"{'Set' if p.apply else 'Suggested'} targets: {round(out['kcal'])} kcal · P {round(out['protein'])} g · "
        f"C {round(out['carbs'])} g · F {round(out['fat'])} g (maintenance ≈ {b['tdee']} kcal)"
    )
    return ActionOutcome(summary=summary, result={**out, "applied": p.apply, "tdee_estimate": tdee_info})


class Prefs(BaseModel):
    energy_unit: Literal["kcal", "kJ"] | None = None
    weight_unit: Literal["kg", "lb"] | None = None
    water_unit: Literal["ml", "floz"] | None = None
    meal_slots: list[str] | None = Field(
        default=None,
        min_length=1,
        max_length=8,
        description="The day's meals in order, e.g. ['Breakfast','Lunch','Pre-workout','Dinner','Snacks']. Existing names keep "
        "their history; a meal left out is hidden (its past entries stay where they are). To RENAME use rename_meals.",
    )
    rename_meals: dict[str, str] | None = Field(default=None, description="Meal name/id → new name (keeps its history), e.g. {'Snacks': 'Treats'}")
    reminder_times: dict[str, str | None] | None = Field(default=None, description="Meal name/id → 'HH:MM' (null to stop)")
    reminders: bool | None = Field(default=None, description="Turn meal-logging reminders on/off")
    close_day_at: str | None = Field(default=None, description="'HH:MM' evening nudge to finish the day's log ('' to stop)")
    water_step_ml: int | None = Field(default=None, ge=50, le=1000)
    show_micros: bool | None = None
    diet_tags: list[str] | None = Field(default=None, max_length=20, description="e.g. vegetarian, vegan, pescatarian, gluten-free, dairy-free, halal, kosher, low-FODMAP")
    allergies: str | None = Field(default=None, max_length=300)
    dislikes: str | None = Field(default=None, max_length=300)


def _slug(name: str) -> str:
    s = "".join(ch for ch in name.lower() if ch.isalnum())[:30]
    return s or "meal"


def _slots_in_use(data: dict) -> set[str]:
    return {e["slot"] for day in data["days"].values() for e in day.get("entries", [])} | {
        m["slot"] for m in data.get("meals") or [] if m.get("slot")
    }


def _arrange_slots(data: dict, names: list[str]) -> list[dict]:
    """The new list of meals from names in order. Ids are stable: a name
    matching an existing meal (shown or hidden) keeps its id; a new name gets
    a new id. Meals left out are hidden when any diary entry or saved meal
    uses them (so past days still show those entries) and dropped otherwise
    — history is never moved to another meal."""
    current = data["settings"]["meal_slots"]
    by_key: dict[str, dict] = {}
    for x in current:
        by_key.setdefault(x["name"].strip().lower(), x)
        by_key.setdefault(x["id"], x)
    taken = {x["id"] for x in current}
    new: list[dict] = []
    seen: set[str] = set()
    for name in names:
        name = name.strip()[:40]
        if not name:
            continue
        prev = by_key.get(name.lower()) or by_key.get(_slug(name))
        if prev is not None and prev["id"] not in seen:
            new.append({**prev, "name": name if prev["name"].lower() != name.lower() else prev["name"], "hidden": False})
            seen.add(prev["id"])
            continue
        sid, n = _slug(name), 2
        while sid in taken or sid in seen:
            sid, n = f"{_slug(name)}{n}", n + 1
        taken.add(sid)
        seen.add(sid)
        new.append({"id": sid, "name": name, "remind_at": None, "hidden": False})
    if not new:
        raise ActionError("Keep at least one meal.")
    if len(new) > MAX_VISIBLE_SLOTS:
        raise ActionError(f"Up to {MAX_VISIBLE_SLOTS} meals a day.")
    used = _slots_in_use(data)
    for x in current:
        if x["id"] not in seen and x["id"] in used:
            new.append({**x, "hidden": True, "remind_at": None})
    return new


def update_preferences(ctx: ItemContext, data: dict, p: Prefs) -> ActionOutcome:
    s = data["settings"]
    changed = []
    for k in ("energy_unit", "weight_unit", "water_unit", "water_step_ml", "show_micros", "reminders"):
        v = getattr(p, k)
        if v is not None:
            s[k] = v
            changed.append(k.replace("_", " "))
    if p.close_day_at is not None:
        s["close_day_at"] = p.close_day_at if TIME_RE.match(p.close_day_at or "") else None
        changed.append("evening nudge")
    if p.rename_meals:
        for key, new_name in p.rename_meals.items():
            sid = _slot(data, ctx, key)
            new_name = new_name.strip()[:40]
            if not new_name:
                raise ActionError("A meal needs a name.")
            next(x for x in s["meal_slots"] if x["id"] == sid)["name"] = new_name
        changed.append("meal names")
    if p.meal_slots is not None:
        s["meal_slots"] = _arrange_slots(data, p.meal_slots)
        changed.append("meals")
    if p.reminder_times:
        for key, at in p.reminder_times.items():
            sid = _slot(data, ctx, key)
            slot = next(x for x in s["meal_slots"] if x["id"] == sid)
            slot["remind_at"] = at if at and TIME_RE.match(at) else None
        if p.reminders is None and any(p.reminder_times.values()):
            s["reminders"] = True
        changed.append("reminder times")
    prof = data["profile"]
    if p.diet_tags is not None:
        prof["diet_tags"] = [t.strip().lower()[:30] for t in p.diet_tags if t.strip()]
        changed.append("diet")
    if p.allergies is not None:
        prof["allergies"] = p.allergies
        changed.append("allergies")
    if p.dislikes is not None:
        prof["dislikes"] = p.dislikes
        changed.append("dislikes")
    return ActionOutcome(summary=f"Updated {', '.join(changed) or 'nothing'}", result={"settings": s})


# --------------------------------------------------------------- read-only


class DayArg(BaseModel):
    date: str | None = Field(default=None, description="Default today")


def _report_slots(data: dict, day: dict) -> list[dict]:
    """The shown meals, then any hidden (removed) meal this day has entries
    in, then an "Other" group for entries whose meal no longer exists."""
    used = {e["slot"] for e in day.get("entries", [])}
    known = {s["id"] for s in data["settings"]["meal_slots"]}
    out = list(_slots(data))
    out += [s for s in data["settings"]["meal_slots"] if s.get("hidden") and s["id"] in used]
    out += [{"id": sid, "name": sid.title()} for sid in sorted(used - known)]
    return out


def _day_report(data: dict, d: str) -> dict:
    day = data["days"].get(d) or {"entries": [], "water_ml": 0, "note": "", "complete": False}
    tgt = science.targets_for(data["targets"], d)
    t = science.total(day["entries"])
    slots = []
    for s in _report_slots(data, day):
        es = [e for e in day["entries"] if e["slot"] == s["id"]]
        slots.append(
            {
                "slot": s["id"],
                "name": s["name"],
                "total": _brief_n(science.total(es)),
                "entries": [
                    {"id": e["id"], "name": e["name"], "amount": f"{e['amount']:g} {e['serving_label'] or e['unit']}", **_brief_n(e["n"]), "estimate": e["estimate"]}
                    for e in es
                ],
            }
        )
    return {
        "date": d,
        "totals": {**_brief_n(t), "sugar": t["sugar"], "sat_fat": t["sat_fat"], "sodium_mg": t["sodium"], "micros": t["micros"]},
        "targets": tgt,
        "remaining": _remaining(data, d),
        "meals": slots,
        "water_ml": day["water_ml"],
        "complete": day["complete"],
        "estimated_entries": sum(1 for e in day["entries"] if e["estimate"]),
        "micros_coverage": {
            "entries_with_micros": sum(1 for e in day["entries"] if (e["n"].get("micros") or {})),
            "entries": len(day["entries"]),
            "note": "Vitamin/mineral totals only include foods that list them.",
        },
        "note": day["note"],
    }


def day_summary(ctx: ItemContext, data: dict, p: DayArg) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    return ActionOutcome(summary="", result=_day_report(data, d))


def remaining_today(ctx: ItemContext, data: dict, p: DayArg) -> ActionOutcome:
    d = _day_str(ctx, p.date)
    rem = _remaining(data, d)
    day = data["days"].get(d) or {"entries": []}
    logged = {e["slot"] for e in day["entries"]}
    open_slots = [s["name"] for s in _slots(data) if s["id"] not in logged]
    density = round(rem["protein"] / rem["kcal"] * 100, 1) if rem["kcal"] > 50 and rem["protein"] > 0 else None
    return ActionOutcome(
        summary="",
        result={
            "date": d,
            "remaining": rem,
            "meals_not_logged": open_slots,
            "protein_g_per_100kcal_needed": density,
            "hint": "Over 7 g protein per 100 kcal needs lean sources (chicken breast, white fish, egg whites, non-fat Greek yogurt, whey)." if density and density > 7 else None,
        },
    )


class WeekArg(BaseModel):
    end_date: str | None = Field(default=None, description="Last day (default today)")
    days: int = Field(default=7, ge=2, le=90)


def week_summary(ctx: ItemContext, data: dict, p: WeekArg) -> ActionOutcome:
    end = date.fromisoformat(_day_str(ctx, p.end_date))
    rows = []
    for i in range(p.days - 1, -1, -1):
        d = (end - timedelta(days=i)).isoformat()
        day = data["days"].get(d)
        tgt = science.targets_for(data["targets"], d)
        t = science.total(day["entries"]) if day else science.zero()
        rows.append(
            {
                "date": d,
                "logged": bool(day and day.get("entries")),
                "complete": bool(day and day.get("complete")),
                **_brief_n(t),
                "target_kcal": tgt["kcal"],
                "target_protein": tgt["protein"],
                "water_ml": (day or {}).get("water_ml", 0),
            }
        )
    logged = [r for r in rows if r["logged"]]
    avg = {k: round(sum(r[k] for r in logged) / len(logged), 1) for k in ("kcal", "protein", "carbs", "fat", "fibre")} if logged else None
    on_target = sum(1 for r in logged if r["target_kcal"] and abs(r["kcal"] - r["target_kcal"]) <= 0.1 * r["target_kcal"])
    protein_hit = sum(1 for r in logged if r["target_protein"] and r["protein"] >= 0.9 * r["target_protein"])
    avg_target = round(sum(r["target_kcal"] or 0 for r in logged) / len(logged)) if logged else None
    return ActionOutcome(
        summary="",
        result={
            "days": rows,
            "logged_days": len(logged),
            "average_per_logged_day": avg,
            "average_target_kcal": avg_target,
            "days_within_10pct_of_kcal": on_target,
            "days_protein_at_least_90pct": protein_hit,
            "macro_split_pct": (
                {
                    "protein": round(avg["protein"] * 4 / avg["kcal"] * 100) if avg and avg["kcal"] else None,
                    "carbs": round(avg["carbs"] * 4 / avg["kcal"] * 100) if avg and avg["kcal"] else None,
                    "fat": round(avg["fat"] * 9 / avg["kcal"] * 100) if avg and avg["kcal"] else None,
                }
                if avg
                else None
            ),
        },
    )


class TdeeArg(BaseModel):
    weights: list[WeightIn] | None = Field(default=None, max_length=400, description="Weigh-ins from the health item, if you read them; otherwise it reads them itself")
    window_days: int = Field(default=21, ge=14, le=28)


async def estimate_tdee(ctx: ItemContext, data: dict, p: TdeeArg) -> ActionOutcome:
    weights = await _weights(ctx, data, p.weights)
    est = science.estimate_tdee(data, weights, ctx.today, p.window_days)
    suggestion = None
    if est.get("tdee"):
        try:
            sug = science.compute_targets(data["profile"], ctx.today, tdee_override=est["tdee"])
            suggestion = {k: sug[k] for k in ("kcal", "protein", "carbs", "fat")}
        except ValueError:
            suggestion = None
    tr = science.trend(weights)
    est["trend_weight_kg"] = tr[-1][1] if tr else None
    est["current_target_kcal"] = data["targets"]["kcal"]
    est["suggested_targets"] = suggestion
    return ActionOutcome(summary="", result=est)


class TopFoods(BaseModel):
    nutrient: str = Field(description=f"kcal, protein, carbs, sugar, fibre, fat, sat_fat, sodium, or a micro: {', '.join(MICROS)}")
    days: int = Field(default=30, ge=1, le=365)
    end_date: str | None = None
    limit: int = Field(default=10, ge=1, le=50)


def top_foods_by_nutrient(ctx: ItemContext, data: dict, p: TopFoods) -> ActionOutcome:
    key = p.nutrient.strip().lower().replace(" ", "_")
    key = {"calories": "kcal", "energy": "kcal", "fiber": "fibre", "salt": "sodium", "saturated_fat": "sat_fat", "carbohydrates": "carbs"}.get(key, key)
    if key not in MACRO_KEYS and key not in MICROS:
        raise ActionError(f"Unknown nutrient {p.nutrient!r}.")
    end = date.fromisoformat(_day_str(ctx, p.end_date))
    start = (end - timedelta(days=p.days - 1)).isoformat()
    groups: dict[str, dict] = {}
    total_amt = 0.0
    for d, day in data["days"].items():
        if not (start <= d <= end.isoformat()):
            continue
        for e in day["entries"]:
            v = float(e["n"].get(key) or 0) if key in MACRO_KEYS else float((e["n"].get("micros") or {}).get(key) or 0)
            if v <= 0:
                continue
            g = e.get("food_ref") or e["name"].lower()
            row = groups.setdefault(g, {"name": e["name"], "amount": 0.0, "times": 0})
            row["amount"] += v
            row["times"] += 1
            total_amt += v
    top = sorted(groups.values(), key=lambda r: -r["amount"])[: p.limit]
    for r in top:
        r["amount"] = round(r["amount"], 1)
        r["share_pct"] = round(r["amount"] / total_amt * 100, 1) if total_amt else 0
    return ActionOutcome(summary="", result={"nutrient": key, "from": start, "to": end.isoformat(), "total": round(total_amt, 1), "top": top})


class SearchFoods(BaseModel):
    query: str = Field(min_length=1, max_length=100)
    limit: int = Field(default=12, ge=1, le=40)


def _score(name: str, brand: str, q: str) -> float:
    return food_search.score(name, brand, q)


def search_library(data: dict, q: str, limit: int) -> list[dict]:
    pool = [*data["foods"], *builtin_foods().values()]
    favs = set(data["favourites"])
    scored = []
    for f in pool:
        sc = _score(f["name"], f.get("brand", ""), q)
        if sc > 0:
            if f["id"] in favs:
                sc += 0.3
            if not f["id"].startswith("b:"):
                sc += 0.2
            scored.append((sc, f))
    scored.sort(key=lambda x: -x[0])
    return [
        {
            "food_id": f["id"],
            "name": _food_name(f),
            "per100": _brief_n(f["per100"]),
            "servings": [{"serving_id": s["id"], "label": s["label"], "grams": s["grams"]} for s in f.get("servings", [])],
            "favourite": f["id"] in favs,
            "source": "library" if not f["id"].startswith("b:") else "built-in",
        }
        for _, f in scored[:limit]
    ]


def search_foods(ctx: ItemContext, data: dict, p: SearchFoods) -> ActionOutcome:
    return ActionOutcome(summary="", result={"query": p.query, "foods": search_library(data, p.query, p.limit)})


class OffSearch(BaseModel):
    query: str | None = Field(default=None, max_length=100, description="Product name (branded / packaged foods)")
    barcode: str | None = Field(default=None, max_length=20)


async def search_open_food_facts(ctx: ItemContext, data: dict, p: OffSearch) -> ActionOutcome:
    from app.items.kinds.meals import off

    who = str(getattr(ctx.user, "id", "") or "")
    try:
        if p.barcode:
            code = off.clean_barcode(p.barcode)
            if who and not off.cached_barcode(code)[0]:
                off.check_rate(who, "barcode")
            f = await off.lookup_barcode(code)
            foods = [f] if f else []
        elif p.query:
            if who and not off.is_cached(off.search_key(p.query, 10)):
                off.check_rate(who, "search")
            foods = (await off.search(p.query, 10))[:8]
        else:
            raise ActionError("Give a product name or a barcode.")
    except ValueError as e:
        raise ActionError(str(e)) from e
    except off.RateLimited as e:
        raise ActionError(f"Too many Open Food Facts lookups just now — wait {round(e.retry_after)} s, or estimate it.") from e
    except off.OffUnavailable as e:
        raise ActionError("Open Food Facts isn't answering right now.") from e
    return ActionOutcome(
        summary="",
        result={
            "foods": [
                {"name": f["name"], "brand": f["brand"], "barcode": f["barcode"], "per100": _brief_n(f["per100"]), "servings": f["servings"]}
                for f in foods
            ],
            "how_to_use": "add_food with per='100g' and these numbers (plus serving_label/serving_grams), then log_foods with the new food_id.",
        },
    )


# ------------------------------------------------------------------ the list

ACTIONS = [
    ItemAction("log_foods", "Log one or more foods to the diary (a whole meal in one call). For library/built-in foods pass food_id + amount (from search_foods); for described food ('2 eggs and toast') pass name, portion and your estimated nutrition for the whole portion with estimate=true.", LogFoods, log_foods),
    ItemAction("edit_entry", "Change a diary entry: amount/unit (nutrition rescales), meal, day, name, time, note, or its nutrition totals.", EditEntry, edit_entry),
    ItemAction("delete_entries", "Remove diary entries by id.", DeleteEntries, delete_entries),
    ItemAction("copy_day", "Copy a day's food (or some meals of it) to another day — 'same breakfast as yesterday', 'copy Monday's lunch to dinner'.", CopyDay, copy_day),
    ItemAction("log_water", "Add (or set) water drunk on a day, in ml.", LogWater, log_water),
    ItemAction("set_day", "Mark a day complete (fully logged — the TDEE estimate relies on it) or save a day note.", SetDay, set_day),
    ItemAction("log_weight", "Record a weigh-in in this file (when there's no Body & Health item, or the person asks here).", LogWeight, log_weight),
    ItemAction("add_food", "Add a custom food to the library (nutrition per 100 g, or per serving with its grams).", AddFood, add_food),
    ItemAction("edit_food", "Edit a library food. Past diary entries keep their logged numbers.", EditFood, edit_food),
    ItemAction("delete_food", "Delete a library food (diary history is kept).", FoodRef, delete_food),
    ItemAction("favourite_food", "Star or unstar a food (library or built-in).", Favourite, favourite_food),
    ItemAction("save_meal", "Save a combo of foods as a reusable meal — from a logged day/meal, entry ids, or items.", SaveMeal, save_meal),
    ItemAction("log_saved_meal", "Log a saved meal (optionally scaled) to a day and meal.", LogSavedMeal, log_saved_meal),
    ItemAction("delete_saved_meal", "Delete a saved meal.", MealRef, delete_saved_meal),
    ItemAction("compute_targets", "Work out calorie and macro targets from the profile (Mifflin-St Jeor × activity, goal rate, diet style) — or from the adaptive TDEE with use_adaptive. Updates the profile with any fields given. apply=false previews.", ComputeTargets, compute_targets),
    ItemAction("set_targets", "Set custom targets (kcal, macros, fibre, sodium/sugar limits, water) and per-weekday overrides.", SetTargets, set_targets),
    ItemAction("update_preferences", "Units, meal names/order, meal-logging reminder times, evening nudge, water step, micros display, diet tags, allergies, dislikes.", Prefs, update_preferences),
    ItemAction("day_summary", "A day's totals, targets, remaining, and every entry by meal (with ids).", DayArg, day_summary, writes=False),
    ItemAction("remaining_today", "What's left today (kcal, macros, fibre, water), meals not logged yet, and how protein-dense the rest needs to be.", DayArg, remaining_today, writes=False),
    ItemAction("week_summary", "Per-day totals over a period (default the last 7 days) with averages, adherence and macro split.", WeekArg, week_summary, writes=False),
    ItemAction("estimate_tdee", "The adaptive maintenance-calorie estimate from intake and weight trend over 2–4 weeks (reads the Body & Health weigh-ins itself, or pass them), with suggested targets.", TdeeArg, estimate_tdee, writes=False),
    ItemAction("top_foods_by_nutrient", "Which foods supplied the most of a nutrient over a period (sodium, protein, sugar, fibre, iron…).", TopFoods, top_foods_by_nutrient, writes=False),
    ItemAction("search_foods", "Find foods in the person's library and the built-in list (generic foods with reference nutrition). Use before estimating.", SearchFoods, search_foods, writes=False),
    ItemAction("search_open_food_facts", "Look up a packaged/branded product in Open Food Facts by name or barcode.", OffSearch, search_open_food_facts, writes=False),
]


def _fill(dst: Any, src: Any) -> None:
    """Add the keys ``src`` has and ``dst`` lacks, recursively and in place
    (so the objects already in ``dst`` stay the same objects)."""
    if isinstance(dst, dict) and isinstance(src, dict):
        for k, v in src.items():
            if k not in dst:
                dst[k] = v
            elif isinstance(dst[k], (dict, list)):
                if isinstance(dst[k], list) and isinstance(v, list) and len(dst[k]) != len(v):
                    dst[k] = v  # the model normalised it (de-duplicated…)
                else:
                    _fill(dst[k], v)
    elif isinstance(dst, list) and isinstance(src, list) and len(dst) == len(src):
        for a, b in zip(dst, src):
            _fill(a, b)


def _hydrating(a: ItemAction) -> ItemAction:
    """The stored file leaves empty fields out; actions work on the full
    shape, so fill the defaults in (in place) before running."""
    fn = a.run

    def run(ctx: ItemContext, data: dict, p: Any) -> Any:
        _fill(data, hydrate(data))
        return fn(ctx, data, p)

    a.run = run
    return a


ACTIONS = [_hydrating(a) for a in ACTIONS]


# ----------------------------------------------------------------- archive


KEEP_WEIGHINS_DAYS = 120


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    """Split the file for "Archive older data": diary days before
    ``before_day`` go to the archive file; foods, saved meals, targets,
    settings and the profile stay (and are copied, so the archive reads on
    its own). Weigh-ins before the day are copied to the archive, and the
    last ~4 months of them stay here too for the trend and TDEE."""
    if not DAY_RE.match(before_day or ""):
        raise ActionError("Archive up to a day (YYYY-MM-DD).")
    try:
        date.fromisoformat(before_day)
    except ValueError as e:
        raise ActionError(f"{before_day} isn't a real date.") from e
    if before_day > ctx.today.isoformat():
        raise ActionError("You can only archive days that have passed.")
    full = hydrate(data)
    old = {d: day for d, day in full["days"].items() if d < before_day}
    if not old:
        raise ActionError(f"There's nothing logged before {before_day}.")
    keep_from = min(before_day, (ctx.today - timedelta(days=KEEP_WEIGHINS_DAYS)).isoformat())
    kept = {
        **full,
        "days": {d: day for d, day in full["days"].items() if d >= before_day},
        "weighins": [w for w in full["weighins"] if w["date"] >= keep_from],
    }
    archived = {
        **json.loads(json.dumps(full)),
        "days": old,
        "weighins": [w for w in full["weighins"] if w["date"] < before_day],
    }
    archived["settings"]["reminders"] = False  # an archive shouldn't nag
    archived["settings"]["close_day_at"] = None
    archived["profile"]["onboarded"] = True
    return kept, archived

