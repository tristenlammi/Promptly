"""The Meal Planner's actions — the AI's (and chat's) hands. Deterministic
for (data, args, ctx.now): ids come from titles, dates and counters."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from app.items.kinds.mealplan import foods, grocery, parse, units
from app.items.kinds.mealplan.models import SLOTS, Nutrition, Slot, safe_link
from app.items.kinds.mealplan.starters import STARTERS
from app.items.spec import ActionError, ActionOutcome, ItemContext

DAY = r"^\d{4}-\d{2}-\d{2}$"
MAX_PLAN = 3000

# ------------------------------------------------------------------ helpers


def js_weekday(d: date) -> int:
    """0 = Sunday … 6 = Saturday."""
    return (d.weekday() + 1) % 7


def week_of(d: date, week_start: int) -> tuple[date, date]:
    start = d - timedelta(days=(js_weekday(d) - week_start) % 7)
    return start, start + timedelta(days=6)


def _day(s: str | None, field: str = "date") -> date:
    try:
        return date.fromisoformat(s or "")
    except ValueError as e:
        raise ActionError(f"{field} must be a YYYY-MM-DD date (got {s!r}).") from e


def _range(ctx: ItemContext, data: dict, start: str | None, end: str | None) -> tuple[str, str]:
    ws = data["preferences"].get("week_start", 1)
    if start is None and end is None:
        a, b = week_of(ctx.today, ws)
        # Late in the week: the list is for the week ahead.
        if (ctx.today - a).days >= 5:
            a, b = a + timedelta(days=7), b + timedelta(days=7)
        return a.isoformat(), b.isoformat()
    a = _day(start, "start") if start else _day(end, "end") - timedelta(days=6)
    b = _day(end, "end") if end else a + timedelta(days=6)
    if b < a:
        raise ActionError("end is before start.")
    if (b - a).days > 62:
        raise ActionError("Pick a range of two months or less.")
    return a.isoformat(), b.isoformat()


def find_recipe(data: dict, ref: str | None) -> dict | None:
    if not ref:
        return None
    for r in data["recipes"]:
        if r["id"] == ref:
            return r
    low = ref.strip().lower()
    for r in data["recipes"]:
        if r["title"].lower() == low:
            return r
    hits = [r for r in data["recipes"] if low in r["title"].lower()]
    return hits[0] if len(hits) == 1 else None


def need_recipe(data: dict, ref: str) -> dict:
    r = find_recipe(data, ref)
    if r is None:
        raise ActionError(f"No recipe {ref!r} in the recipe box (use its id from the data).")
    return r


def new_recipe_id(data: dict, title: str, taken: set[str] | None = None) -> str:
    base = grocery.slug(title, 36)
    ids = {r["id"] for r in data["recipes"]} | (taken or set())
    rid, n = base, 2
    while rid in ids:
        rid, n = f"{base}-{n}", n + 1
    return rid


def ingredient_texts(recipe: dict) -> list[str]:
    return foods.ingredient_texts(recipe.get("ingredients", []))


def conflicts(prefs: dict, recipe: dict) -> dict:
    """What in ``recipe`` breaks the person's allergies, diets, dislikes
    (each ingredient's item and note are read)."""
    texts = ingredient_texts(recipe)
    out: dict = {}
    al = foods.allergen_report(recipe.get("ingredients", []), prefs.get("allergies", []))
    if al:
        out["allergens"] = al
    di = {d: h for d in prefs.get("diets", []) if (h := foods.diet_conflicts(texts, d))}
    if di:
        out["diets"] = di
    dl = [d for d in prefs.get("dislikes", []) if foods.allergy_hits(texts, d)]
    if dl:
        out["dislikes"] = dl
    return out


def _ingredients_from(lines: list[str], structured: list[dict]) -> list[dict]:
    out: list[dict] = []
    for s in structured:
        ing = {k: s.get(k) for k in ("qty", "qty_max", "unit", "item", "note", "optional", "group", "aisle")}
        ing["unit"] = units.unit_key(ing.get("unit") or "")
        ing["note"] = ing.get("note") or ""
        ing["group"] = ing.get("group") or ""
        ing["optional"] = bool(ing.get("optional"))
        if not ing.get("aisle"):
            ing["aisle"] = foods.aisle_for(ing.get("item") or "")
        if ing.get("item"):
            out.append(ing)
    out.extend(parse.parse_ingredient_lines(lines))
    for n, ing in enumerate(out[:150], 1):
        ing["id"] = f"i{n}"
    return out[:150]


def trim_plan(data: dict) -> None:
    if len(data["plan"]) > MAX_PLAN - 50:
        data["plan"].sort(key=lambda e: (e["date"], SLOTS.index(e["slot"])))
        del data["plan"][: len(data["plan"]) - (MAX_PLAN - 100)]


def _entry_id(data: dict, day: str, slot: str, taken: set[str]) -> str:
    base = f"{day.replace('-', '')}{slot[0]}"
    ids = {e["id"] for e in data["plan"]} | taken
    n = 1
    while f"{base}{n}" in ids:
        n += 1
    return f"{base}{n}"


def allergen_text(report: dict[str, list[str]]) -> str:
    return "; ".join(f"{a}: {', '.join(h[:3])}" for a, h in report.items())


def allergen_warnings(data: dict, recipes: list[dict], today: date) -> tuple[str, dict]:
    """Re-check recipes just added or changed against the allergy list:
    (a line for the person, details for the model)."""
    allergies = data["preferences"].get("allergies", [])
    if not allergies:
        return "", {}
    details: dict = {}
    for r in recipes:
        found = foods.allergen_report(r.get("ingredients", []), allergies)
        if not found:
            continue
        planned = sorted(
            e["date"] for e in data["plan"]
            if e.get("recipe_id") == r["id"] and e["date"] >= today.isoformat() and not e.get("cooked")
        )
        details[r["id"]] = {"title": r["title"], "allergens": found, "planned_on": planned[:10]}
    if not details:
        return "", {}
    bits = []
    for d in details.values():
        b = f"“{d['title']}” contains {allergen_text(d['allergens'])}"
        if d["planned_on"]:
            b += f" and is planned on {', '.join(d['planned_on'][:3])}"
        bits.append(b)
    line = "⚠ Allergy warning: " + "; ".join(bits) + ". It can't be planned until the ingredients are made safe."
    return line[:900], details


def _fmt_ing(ing: dict) -> str:
    return units.ingredient_text(ing)


# ------------------------------------------------------------------ recipes


class IngredientIn(BaseModel):
    qty: float | None = Field(None, ge=0, le=100_000, description="Amount; omit for 'to taste'")
    qty_max: float | None = Field(None, ge=0, le=100_000, description="Upper end of a range (1–2 tbsp)")
    unit: str = Field("", max_length=20, description="g, kg, ml, l, tsp, tbsp, cup, oz, lb, clove, can… or '' for a count")
    item: str = Field(min_length=1, max_length=200, description="The ingredient as bought: 'red onion', 'chicken thighs'")
    note: str = Field("", max_length=300, description="Preparation: 'finely chopped'")
    optional: bool = False
    group: str = Field("", max_length=80, description="Section, e.g. 'For the sauce'")
    aisle: str = Field("", max_length=30, description="Store aisle key; leave empty to auto-detect")


class RecipeIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    servings: float = Field(4, gt=0, le=100)
    ingredient_lines: list[str] = Field(
        default_factory=list,
        max_length=150,
        description="Ingredients one per line exactly as a cook writes them ('1 1/2 cups plain flour, sifted', "
        "'2 cloves garlic, minced'). A line ending in ':' ('For the sauce:') starts a group. Preferred.",
    )
    ingredients: list[IngredientIn] = Field(default_factory=list, max_length=150, description="Structured alternative to ingredient_lines")
    steps: list[str] = Field(default_factory=list, max_length=80, description="One instruction per step, with temperatures and times")
    prep_min: int | None = Field(None, ge=0, le=20_000)
    cook_min: int | None = Field(None, ge=0, le=20_000)
    total_min: int | None = Field(None, ge=0, le=40_000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    cuisine: str = Field("", max_length=60)
    source_url: str = Field("", max_length=1000, description="Where it came from (cite web recipes)")
    image_url: str = Field("", max_length=2000)
    notes: str = Field("", max_length=5000)
    prep_ahead: str = Field("", max_length=300, description="Anything to do the day before (thaw, marinate, soak) — triggers an evening reminder")
    nutrition: Nutrition | None = Field(None, description="Per serving, if known")
    rating: int = Field(0, ge=0, le=5)
    favorite: bool = False


def recipe_dict(p: RecipeIn, rid: str, today: date) -> dict:
    total = p.total_min
    if total is None and (p.prep_min or p.cook_min):
        total = (p.prep_min or 0) + (p.cook_min or 0)
    return {
        "id": rid,
        "title": p.title.strip(),
        "servings": p.servings,
        "ingredients": _ingredients_from(p.ingredient_lines, [i.model_dump() for i in p.ingredients]),
        "steps": [s.strip() for s in p.steps if s.strip()],
        "prep_min": p.prep_min,
        "cook_min": p.cook_min,
        "total_min": total,
        "tags": p.tags,
        "cuisine": p.cuisine,
        "source_url": safe_link(p.source_url)[:1000],
        "image_url": safe_link(p.image_url)[:2000],
        "notes": p.notes,
        "prep_ahead": p.prep_ahead,
        "rating": p.rating,
        "favorite": p.favorite,
        "times_cooked": 0,
        "last_cooked": None,
        "nutrition": p.nutrition.model_dump() if p.nutrition else None,
        "added": today.isoformat(),
    }


class AddRecipes(BaseModel):
    recipes: list[RecipeIn] = Field(min_length=1, max_length=20)


def add_recipes(ctx: ItemContext, data: dict, p: AddRecipes) -> ActionOutcome:
    if len(data["recipes"]) + len(p.recipes) > 1500:
        raise ActionError("The recipe box is full (1,500 recipes). Delete some first.")
    made, warnings = [], {}
    taken: set[str] = set()
    for r in p.recipes:
        rid = new_recipe_id(data, r.title, taken)
        taken.add(rid)
        rec = recipe_dict(r, rid, ctx.today)
        if not rec["ingredients"] and not rec["steps"]:
            raise ActionError(f"“{r.title}” has no ingredients or steps.")
        data["recipes"].append(rec)
        made.append({"id": rid, "title": rec["title"], "ingredients": len(rec["ingredients"])})
        c = conflicts(data["preferences"], rec)
        if c:
            warnings[rid] = c
    names = ", ".join(f"“{m['title']}”" for m in made[:3]) + (f" and {len(made) - 3} more" if len(made) > 3 else "")
    line, allergens = allergen_warnings(data, [r for r in data["recipes"] if r["id"] in taken], ctx.today)
    return ActionOutcome(
        summary=f"Added {names} to the recipe box" + (f". {line}" if line else ""),
        result={"added": made, "conflicts_with_preferences": warnings, "allergen_conflicts": allergens},
    )


class EditRecipe(BaseModel):
    recipe_id: str
    title: str | None = Field(None, min_length=1, max_length=200)
    servings: float | None = Field(None, gt=0, le=100)
    ingredient_lines: list[str] | None = Field(None, max_length=150, description="Replaces all ingredients")
    steps: list[str] | None = Field(None, max_length=80, description="Replaces all steps")
    prep_min: int | None = Field(None, ge=0, le=20_000)
    cook_min: int | None = Field(None, ge=0, le=20_000)
    total_min: int | None = Field(None, ge=0, le=40_000)
    tags: list[str] | None = Field(None, max_length=20)
    cuisine: str | None = Field(None, max_length=60)
    source_url: str | None = Field(None, max_length=1000)
    image_url: str | None = Field(None, max_length=2000)
    notes: str | None = Field(None, max_length=5000)
    prep_ahead: str | None = Field(None, max_length=300)
    nutrition: Nutrition | None = None
    rating: int | None = Field(None, ge=0, le=5)
    favorite: bool | None = None


def edit_recipe(ctx: ItemContext, data: dict, p: EditRecipe) -> ActionOutcome:
    r = need_recipe(data, p.recipe_id)
    changed = []
    for f in ("title", "servings", "prep_min", "cook_min", "total_min", "tags", "cuisine", "source_url",
              "image_url", "notes", "prep_ahead", "rating", "favorite"):
        v = getattr(p, f)
        if v is not None:
            if f in ("source_url", "image_url"):
                v = safe_link(v)[: 1000 if f == "source_url" else 2000]
            r[f] = v
            changed.append(f)
    if p.nutrition is not None:
        r["nutrition"] = p.nutrition.model_dump()
        changed.append("nutrition")
    if p.ingredient_lines is not None:
        r["ingredients"] = _ingredients_from(p.ingredient_lines, [])
        changed.append("ingredients")
    if p.steps is not None:
        r["steps"] = [s.strip() for s in p.steps if s.strip()]
        changed.append("steps")
    if (p.prep_min is not None or p.cook_min is not None) and p.total_min is None:
        r["total_min"] = (r.get("prep_min") or 0) + (r.get("cook_min") or 0) or r.get("total_min")
    if not changed:
        raise ActionError("Nothing to change — pass at least one field.")
    if p.title:
        for e in data["plan"]:
            if e.get("recipe_id") == r["id"]:
                e["title"] = r["title"]
    line, allergens = allergen_warnings(data, [r], ctx.today)
    return ActionOutcome(
        summary=f"Updated “{r['title']}”" + (f". {line}" if line else ""),
        result={"id": r["id"], "changed": changed, "conflicts_with_preferences": conflicts(data["preferences"], r),
                "allergen_conflicts": allergens},
    )


class DeleteRecipes(BaseModel):
    recipe_ids: list[str] = Field(min_length=1, max_length=100)


def delete_recipes(ctx: ItemContext, data: dict, p: DeleteRecipes) -> ActionOutcome:
    gone = []
    for ref in p.recipe_ids:
        r = find_recipe(data, ref)
        if r is None:
            continue
        data["recipes"] = [x for x in data["recipes"] if x["id"] != r["id"]]
        # Planned meals keep their name as free text.
        for e in data["plan"]:
            if e.get("recipe_id") == r["id"]:
                e["recipe_id"] = None
                e["title"] = e.get("title") or r["title"]
        gone.append(r["title"])
    if not gone:
        raise ActionError("None of those recipes are in the recipe box.")
    return ActionOutcome(summary=f"Deleted {', '.join(f'“{g}”' for g in gone[:3])}" + (f" and {len(gone) - 3} more" if len(gone) > 3 else ""),
                         result={"deleted": gone})


class ScaleRecipe(BaseModel):
    recipe_id: str
    servings: float | None = Field(None, gt=0, le=200, description="Target servings")
    factor: float | None = Field(None, gt=0, le=50, description="Or a multiplier (2 = double)")
    units: Literal["keep", "metric", "imperial"] = "keep"


def scale_recipe(ctx: ItemContext, data: dict, p: ScaleRecipe) -> ActionOutcome:
    r = need_recipe(data, p.recipe_id)
    factor = p.factor or ((p.servings / r["servings"]) if p.servings else 1.0)
    lines = [_fmt_ing(units.scale_line(i, factor, p.units)) for i in r["ingredients"]]
    return ActionOutcome(
        summary="",
        result={
            "title": r["title"],
            "servings": round(r["servings"] * factor, 2),
            "factor": round(factor, 4),
            "ingredients": lines,
        },
    )


class AddStarters(BaseModel):
    pass


def add_starter_recipes(ctx: ItemContext, data: dict, p: AddStarters) -> ActionOutcome:
    have = {r["title"].lower() for r in data["recipes"]}
    todo = [RecipeIn(**s) for s in STARTERS if s["title"].lower() not in have]
    if not todo:
        raise ActionError("The starter recipes are already in the recipe box.")
    # Starters that contain one of the person's allergens are left out.
    allergies = data["preferences"].get("allergies", [])
    safe, skipped = [], []
    for r in todo:
        ings = _ingredients_from(r.ingredient_lines, [i.model_dump() for i in r.ingredients])
        (skipped if foods.allergen_report(ings, allergies) else safe).append(r)
    if not safe:
        raise ActionError("Every starter recipe contains something on your allergy list — ask the assistant for safe recipes instead.")
    out = add_recipes(ctx, data, AddRecipes(recipes=safe))
    if skipped:
        names = ", ".join(f"“{r.title}”" for r in skipped)
        out.summary += f" (left out {names}: on your allergy list)"
        out.result["skipped_for_allergies"] = [r.title for r in skipped]
    return out


# --------------------------------------------------------------------- plan


class MealIn(BaseModel):
    date: str = Field(pattern=DAY)
    slot: Slot = "dinner"
    recipe_id: str | None = Field(None, description="A recipe in the box (id, or exact title)")
    title: str | None = Field(None, max_length=200, description="Free-text meal when there's no recipe ('Takeaway', 'Eat out')")
    servings: float | None = Field(None, gt=0, le=100, description="Default: household size")
    leftovers_of_date: str | None = Field(None, pattern=DAY, description="This meal is the leftovers of the meal cooked on this date…")
    leftovers_of_slot: Slot | None = Field(None, description="…in this slot (default dinner). Shopping is added to that cook.")
    note: str = Field("", max_length=300)


class PlanMeals(BaseModel):
    meals: list[MealIn] = Field(min_length=1, max_length=60)
    replace: bool = Field(True, description="Replace what's already planned in the same day and slot")


def plan_meals(ctx: ItemContext, data: dict, p: PlanMeals) -> ActionOutcome:
    prefs = data["preferences"]
    taken: set[str] = set()
    placed, problems = [], {}
    meals = sorted(p.meals, key=lambda m: m.leftovers_of_date is not None)  # cooks before their leftovers
    # Allergens first, so a refused batch changes nothing.
    for m in meals:
        r = find_recipe(data, m.recipe_id) if m.recipe_id else None
        found = foods.allergen_report(r.get("ingredients", []), prefs.get("allergies", [])) if r else {}
        if found:
            raise ActionError(
                f"“{r['title']}” contains a listed allergen ({allergen_text(found)}). "
                "Pick another recipe or change the ingredients first (edit_recipe), then plan it."
            )
        free_text = (m.title or "").strip()
        hit = [a for a in prefs.get("allergies", []) if free_text and foods.allergy_hits([free_text], a)]
        if hit:
            raise ActionError(f"“{free_text}” looks like it contains a listed allergen ({', '.join(hit)}). Plan a safe meal instead.")
    cleared: set[tuple[str, str]] = set()
    for m in meals:
        _day(m.date)
        recipe = None
        if m.recipe_id:
            recipe = find_recipe(data, m.recipe_id)
            if recipe is None and not m.title:
                raise ActionError(f"No recipe {m.recipe_id!r} — add it first (add_recipes) or pass a free-text title.")
        if recipe is None and not (m.title or "").strip() and not m.leftovers_of_date:
            raise ActionError(f"{m.date} {m.slot}: give a recipe_id, a title, or leftovers_of_date.")
        src = None
        if m.leftovers_of_date:
            slot = m.leftovers_of_slot or "dinner"
            src = next(
                (e for e in data["plan"] if e["date"] == m.leftovers_of_date and e["slot"] == slot and not e.get("leftovers_of")),
                None,
            )
            if src is None:
                raise ActionError(f"Nothing is planned for {m.leftovers_of_date} {slot} to make leftovers from.")
            if m.leftovers_of_date >= m.date:
                raise ActionError("Leftovers have to come from an earlier meal.")
            if recipe is None and src.get("recipe_id"):
                recipe = find_recipe(data, src["recipe_id"])
        if recipe is not None:
            c = conflicts(prefs, recipe)
            if c.get("allergens"):
                raise ActionError(
                    f"“{recipe['title']}” contains a listed allergen ({allergen_text(c['allergens'])}). "
                    "Pick another recipe or change the ingredients first (edit_recipe), then plan it."
                )
            if c:
                problems[recipe["title"]] = c
        free_text = (m.title or "").strip()
        if free_text:
            hit = [a for a in prefs.get("allergies", []) if foods.allergy_hits([free_text], a)]
            if hit:
                raise ActionError(f"“{free_text}” looks like it contains a listed allergen ({', '.join(hit)}). Plan a safe meal instead.")
        if p.replace and (m.date, m.slot) not in cleared:
            data["plan"] = [e for e in data["plan"] if not (e["date"] == m.date and e["slot"] == m.slot)]
            cleared.add((m.date, m.slot))
        eid = _entry_id(data, m.date, m.slot, taken)
        taken.add(eid)
        title = (m.title or "").strip() or (recipe["title"] if recipe else (src.get("title", "") if src else ""))
        data["plan"].append(
            {
                "id": eid,
                "date": m.date,
                "slot": m.slot,
                "recipe_id": recipe["id"] if recipe else None,
                "title": title[:200],
                "servings": m.servings,
                "leftovers_of": src["id"] if src else None,
                "note": m.note,
                "cooked": False,
            }
        )
        placed.append({"id": eid, "date": m.date, "slot": m.slot, "title": title, "leftovers": bool(src)})
    data["plan"].sort(key=lambda e: (e["date"], SLOTS.index(e["slot"])))
    trim_plan(data)
    days = sorted({x["date"] for x in placed})
    span = days[0] if len(days) == 1 else f"{days[0]} – {days[-1]}"
    return ActionOutcome(
        summary=f"Planned {len(placed)} meal{'s' if len(placed) != 1 else ''} ({span})",
        result={"planned": placed, "preference_warnings": problems},
    )


class ClearPlan(BaseModel):
    start: str = Field(pattern=DAY)
    end: str = Field(pattern=DAY)
    slots: list[Slot] | None = Field(None, description="Only these slots (default all)")
    keep_cooked: bool = Field(True, description="Keep meals already marked cooked")


def clear_plan(ctx: ItemContext, data: dict, p: ClearPlan) -> ActionOutcome:
    if p.end < p.start:
        raise ActionError("end is before start.")
    before = len(data["plan"])

    def gone(e: dict) -> bool:
        return (
            p.start <= e["date"] <= p.end
            and (p.slots is None or e["slot"] in p.slots)
            and not (p.keep_cooked and e.get("cooked"))
        )

    removed = {e["id"] for e in data["plan"] if gone(e)}
    data["plan"] = [e for e in data["plan"] if e["id"] not in removed]
    for e in data["plan"]:
        if e.get("leftovers_of") in removed:
            e["leftovers_of"] = None
    n = before - len(data["plan"])
    if not n:
        raise ActionError("Nothing planned in that range.")
    return ActionOutcome(summary=f"Cleared {n} meal{'s' if n != 1 else ''} from {p.start} to {p.end}", result={"removed": n})


class MarkCooked(BaseModel):
    recipe_id: str | None = Field(None, description="The recipe (default: the planned meal's)")
    date: str | None = Field(None, pattern=DAY, description="The planned day (default today)")
    slot: Slot | None = None
    rating: int | None = Field(None, ge=1, le=5)
    cooked: bool = Field(True, description="False un-marks it")


def mark_cooked(ctx: ItemContext, data: dict, p: MarkCooked) -> ActionOutcome:
    day = p.date or ctx.today.isoformat()
    recipe = None
    if p.recipe_id:
        recipe = need_recipe(data, p.recipe_id)
    cands = [
        e for e in data["plan"]
        if e["date"] == day and (p.slot is None or e["slot"] == p.slot)
        and (recipe is None or e.get("recipe_id") == recipe["id"])
    ]
    entry = cands[0] if cands else None
    if recipe is None and entry is not None:
        recipe = find_recipe(data, entry.get("recipe_id"))
    if entry is None and recipe is None:
        raise ActionError(f"Nothing is planned for {day}{f' {p.slot}' if p.slot else ''} — give a recipe_id.")
    was = bool(entry and entry.get("cooked"))
    if entry is not None:
        entry["cooked"] = p.cooked
    if recipe is not None:
        if p.cooked and (entry is None or not was):
            recipe["times_cooked"] = int(recipe.get("times_cooked") or 0) + 1
            if not recipe.get("last_cooked") or recipe["last_cooked"] < day:
                recipe["last_cooked"] = day
        elif not p.cooked and was and recipe.get("times_cooked"):
            recipe["times_cooked"] -= 1
        if p.rating:
            recipe["rating"] = p.rating
    name = recipe["title"] if recipe else (entry.get("title") or "meal")
    return ActionOutcome(
        summary=f"Marked “{name}” as {'cooked' if p.cooked else 'not cooked'}",
        result={"times_cooked": recipe.get("times_cooked") if recipe else None, "entry": entry["id"] if entry else None},
    )


# ------------------------------------------------------------------ grocery


class GenerateGrocery(BaseModel):
    start: str | None = Field(None, pattern=DAY, description="Default: this week (next week from Friday on)")
    end: str | None = Field(None, pattern=DAY)
    include_optional: bool = False
    keep_manual: bool = Field(True, description="Keep items added by hand")
    restore_removed: bool = Field(False, description="Bring back plan items the person deleted from this range's list")


def generate_grocery_list(ctx: ItemContext, data: dict, p: GenerateGrocery) -> ActionOutcome:
    start, end = _range(ctx, data, p.start, p.end)
    stats = grocery.regenerate(data, start, end, ctx.now.isoformat(timespec="seconds"),
                               include_optional=p.include_optional, keep_manual=p.keep_manual,
                               restore_removed=p.restore_removed)
    if not stats["recipes"]:
        raise ActionError(f"No recipes are planned between {start} and {end} — plan some meals first.")
    items = data["grocery"]["items"]
    by_aisle: dict[str, list[str]] = {}
    for i in items:
        if not i["checked"]:
            amt = grocery.amounts_text(i["amounts"])
            by_aisle.setdefault(foods.AISLES.get(i["aisle"], "Other"), []).append(f"{i['name']}{f' ({amt})' if amt else ''}")
    return ActionOutcome(
        summary=f"Grocery list for {start} – {end}: {stats['items']} items from {stats['recipes']} meals"
        + (f", {stats['covered_by_pantry']} already in the pantry" if stats["covered_by_pantry"] else "")
        + (f", {len(stats['left_off'])} you removed left off" if stats["left_off"] else ""),
        result={"start": start, "end": end, **stats, "by_aisle": by_aisle, "pantry_covered": data["grocery"]["covered"]},
    )


class GroceryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    qty: float | None = Field(None, ge=0, le=100_000)
    unit: str = Field("", max_length=20)
    aisle: str = Field("", max_length=30, description="produce, bakery, meat, seafood, dairy, frozen, pantry, canned, baking, spices, condiments, snacks, drinks, household, other")
    note: str = Field("", max_length=300)


class AddGroceryItems(BaseModel):
    lines: list[str] = Field(default_factory=list, max_length=100, description="Free text, one item per line: '2 lb chicken thighs', 'paper towels'")
    items: list[GroceryIn] = Field(default_factory=list, max_length=100)


def add_grocery_items(ctx: ItemContext, data: dict, p: AddGroceryItems) -> ActionOutcome:
    added, merged = [], []
    todo: list[tuple[str, float | None, str, str, str]] = []
    for line in p.lines:
        if not line.strip():
            continue
        ing = parse.parse_ingredient(line)
        name = ing["item"] or line.strip()
        todo.append((name, ing["qty"], ing["unit"], "", ing["note"]))
    for i in p.items:
        todo.append((i.name, i.qty, units.unit_key(i.unit), i.aisle, i.note))
    if not todo:
        raise ActionError("Nothing to add.")
    for name, qty, unit, aisle, note in todo:
        item, was = grocery.add_manual(data, name, qty, unit, aisle, note)
        (merged if was else added).append(item["name"])
    n = len(added) + len(merged)
    return ActionOutcome(summary=f"Added {n} item{'s' if n != 1 else ''} to the grocery list", result={"added": added, "merged_into_existing": merged})


def _match_items(data: dict, refs: list[str]) -> list[dict]:
    items = data["grocery"]["items"]
    out = []
    for ref in refs:
        low = ref.strip().lower()
        key = foods.ingredient_key(ref)
        hit = next((i for i in items if i["id"] == ref), None) or next(
            (i for i in items if i["name"].lower() == low or (key and i.get("key") == key)), None
        ) or next((i for i in items if low and low in i["name"].lower()), None)
        if hit is not None and hit not in out:
            out.append(hit)
    return out


class CheckGroceryItems(BaseModel):
    items: list[str] = Field(default_factory=list, max_length=200, description="Item ids or names")
    checked: bool = True
    all: bool = Field(False, description="Every item on the list")


def check_grocery_items(ctx: ItemContext, data: dict, p: CheckGroceryItems) -> ActionOutcome:
    hits = data["grocery"]["items"] if p.all else _match_items(data, p.items)
    if not hits:
        raise ActionError("None of those are on the grocery list.")
    for i in hits:
        i["checked"] = p.checked
    return ActionOutcome(summary=f"{'Checked off' if p.checked else 'Unchecked'} {len(hits)} item{'s' if len(hits) != 1 else ''}",
                         result={"items": [i["name"] for i in hits]})


class RemoveGroceryItems(BaseModel):
    items: list[str] = Field(default_factory=list, max_length=200, description="Item ids or names")
    checked: bool = Field(False, description="Remove every checked item")
    everything: bool = Field(False, description="Empty the list")


def remove_grocery_items(ctx: ItemContext, data: dict, p: RemoveGroceryItems) -> ActionOutcome:
    items = data["grocery"]["items"]
    if p.everything:
        gone = {i["id"] for i in items}
    else:
        gone = {i["id"] for i in _match_items(data, p.items)}
        if p.checked:
            gone |= {i["id"] for i in items if i["checked"]}
    if not gone:
        raise ActionError("Nothing to remove.")
    data["grocery"]["items"] = [i for i in items if i["id"] not in gone]
    if p.everything:
        data["grocery"].update(start=None, end=None, generated_at=None, covered=[])
    return ActionOutcome(summary=f"Removed {len(gone)} item{'s' if len(gone) != 1 else ''} from the grocery list", result={"removed": len(gone)})


# ------------------------------------------------------------------- pantry


class PantryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    qty: float | None = Field(None, ge=0, le=1_000_000, description="How much is on hand; omit for 'always have it'")
    unit: str = Field("", max_length=20)
    staple: bool = Field(True, description="Always kept in stock — never added to the grocery list")


class SetPantry(BaseModel):
    add: list[PantryIn] = Field(default_factory=list, max_length=200)
    remove: list[str] = Field(default_factory=list, max_length=200, description="Names to remove")
    replace: bool = Field(False, description="Replace the whole pantry with `add`")


def set_pantry(ctx: ItemContext, data: dict, p: SetPantry) -> ActionOutcome:
    if p.replace:
        data["pantry"] = []
    drop = {foods.ingredient_key(n) for n in p.remove}
    before = len(data["pantry"])
    data["pantry"] = [x for x in data["pantry"] if foods.ingredient_key(x["name"]) not in drop]
    removed = before - len(data["pantry"])
    added = 0
    for item in p.add:
        key = foods.ingredient_key(item.name)
        existing = next((x for x in data["pantry"] if foods.ingredient_key(x["name"]) == key), None)
        row = {"name": item.name.strip(), "qty": item.qty, "unit": units.unit_key(item.unit), "staple": item.staple and item.qty is None}
        if existing:
            existing.update(row)
        else:
            if len(data["pantry"]) >= 400:
                raise ActionError("The pantry is full (400 items).")
            pid = f"p-{grocery.slug(key, 24)}"
            ids = {x["id"] for x in data["pantry"]}
            n = 2
            while pid in ids:
                pid = f"p-{grocery.slug(key, 24)}-{n}"
                n += 1
            data["pantry"].append({"id": pid, **row})
            added += 1
    if not (added or removed or p.add or p.replace):
        raise ActionError("Nothing to change in the pantry.")
    return ActionOutcome(summary=f"Pantry updated ({len(data['pantry'])} items)", result={"added": added, "removed": removed, "pantry": [x["name"] for x in data["pantry"]]})


# -------------------------------------------------------------- preferences


class SetPreferences(BaseModel):
    household_size: int | None = Field(None, ge=1, le=20)
    diets: list[str] | None = Field(None, max_length=12, description="Full list: vegetarian, vegan, pescatarian, keto, halal, kosher, gluten-free, dairy-free…")
    allergies: list[str] | None = Field(None, max_length=20, description="Full list: peanut, tree nut, dairy, egg, gluten, soy, fish, shellfish, sesame…")
    dislikes: list[str] | None = Field(None, max_length=40, description="Full list")
    cuisines: list[str] | None = Field(None, max_length=20)
    weeknight_minutes: int | None = Field(None, ge=5, le=600)
    weekend_minutes: int | None = Field(None, ge=5, le=900)
    budget: Literal["low", "medium", "high"] | None = None
    skill: Literal["beginner", "intermediate", "advanced"] | None = None
    equipment: list[str] | None = Field(None, max_length=30, description="Full list: oven, air fryer, slow cooker, Instant Pot, grill…")
    week_start: int | None = Field(None, ge=0, le=6, description="0 = Sunday, 1 = Monday … 6 = Saturday")
    slots: list[Slot] | None = Field(None, description="Which meals to plan")
    units: Literal["metric", "imperial"] | None = None
    calories_per_day: int | None = Field(None, ge=800, le=6000, description="Per person")
    protein_g_per_day: int | None = Field(None, ge=10, le=400, description="Per person")
    prep_reminders: bool | None = None
    prep_reminder_time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    shopping_reminder: bool | None = None
    shopping_day: int | None = Field(None, ge=0, le=6)
    shopping_time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


def set_preferences(ctx: ItemContext, data: dict, p: SetPreferences) -> ActionOutcome:
    changed = {k: v for k, v in p.model_dump().items() if v is not None}
    if not changed:
        raise ActionError("Nothing to change.")
    data["preferences"].update(changed)
    data["preferences"]["onboarded"] = True
    return ActionOutcome(summary="Updated your preferences", result={"changed": sorted(changed)})


# ------------------------------------------------------------------ reading


class WhatCanIMake(BaseModel):
    ingredients: list[str] = Field(default_factory=list, max_length=100, description="What's on hand (default: the pantry)")
    max_missing: int = Field(3, ge=0, le=20)
    max_minutes: int | None = Field(None, ge=1, le=2000)
    limit: int = Field(10, ge=1, le=50)


def _have_match(need: str, have: set[str]) -> bool:
    """On hand covers a need when it names it, or something more general
    ("chicken" covers "chicken thigh") — never the reverse, so "black
    pepper" doesn't cover "1 pepper, diced"."""
    if need in have:
        return True
    nw = set(need.split())
    return any(h and set(h.split()) <= nw for h in have)


def what_can_i_make(ctx: ItemContext, data: dict, p: WhatCanIMake) -> ActionOutcome:
    src = p.ingredients or [x["name"] for x in data["pantry"]]
    have = {grocery.pantry_key({"name": x}) for x in src}
    have |= foods.BASIC_STAPLES
    have.discard("")
    out = []
    for r in data["recipes"]:
        if p.max_minutes and (r.get("total_min") or 0) > p.max_minutes:
            continue
        needs = []
        for i in r["ingredients"]:
            if i.get("optional"):
                continue
            k = foods.grocery_key(i.get("item", ""), i.get("unit") or "", i.get("qty"))
            if k and k not in foods.ALWAYS_HAVE and k not in needs:
                needs.append(k)
        if not needs:
            continue
        missing = [k for k in needs if not _have_match(k, have)]
        if len(missing) > p.max_missing:
            continue
        out.append({
            "id": r["id"],
            "title": r["title"],
            "missing": missing,
            "coverage": round(1 - len(missing) / len(needs), 2),
            "total_min": r.get("total_min"),
        })
    out.sort(key=lambda x: (len(x["missing"]), -x["coverage"], x["total_min"] or 999))
    return ActionOutcome(summary="", result={"on_hand": sorted(have)[:80], "recipes": out[: p.limit]})


def _targets_in(obj, depth: int = 0, ctx_key: str = "") -> dict:
    """Calorie / protein targets in another item's data (best effort)."""
    found: dict = {}
    if depth > 4:
        return found
    if isinstance(obj, dict):
        for k, v in obj.items():
            lk = str(k).lower()
            inside = ctx_key or any(w in lk for w in ("target", "goal"))
            if isinstance(v, (int, float)) and not isinstance(v, bool) and (ctx_key or "target" in lk or "goal" in lk):
                if ("calor" in lk or "kcal" in lk or lk == "energy") and 800 <= v <= 6000:
                    found.setdefault("calories", v)
                elif "protein" in lk and 10 <= v <= 400:
                    found.setdefault("protein_g", v)
                elif ("carb" in lk) and 0 <= v <= 1000:
                    found.setdefault("carbs_g", v)
                elif lk.startswith("fat") and 0 <= v <= 400:
                    found.setdefault("fat_g", v)
            elif isinstance(v, (dict, list)):
                for kk, vv in _targets_in(v, depth + 1, "t" if inside else "").items():
                    found.setdefault(kk, vv)
    elif isinstance(obj, list):
        for x in obj[:20]:
            for kk, vv in _targets_in(x, depth + 1, ctx_key).items():
                found.setdefault(kk, vv)
    return found


class PlanSummary(BaseModel):
    start: str | None = Field(None, pattern=DAY, description="Default: this week")
    end: str | None = Field(None, pattern=DAY)


async def plan_summary(ctx: ItemContext, data: dict, p: PlanSummary) -> ActionOutcome:
    prefs = data["preferences"]
    if p.start is None and p.end is None:
        a, b = week_of(ctx.today, prefs.get("week_start", 1))
        start, end = a.isoformat(), b.isoformat()
    else:
        start, end = _range(ctx, data, p.start, p.end)
    recipes = {r["id"]: r for r in data["recipes"]}
    household = prefs.get("household_size", 2)
    days = []
    seen: dict[str, int] = {}
    cuisines: dict[str, int] = {}
    over_time, warn = [], {}
    d = date.fromisoformat(start)
    empty = 0
    while d.isoformat() <= end:
        ds = d.isoformat()
        meals, kcal, protein, with_n = [], 0.0, 0.0, 0
        for e in [e for e in data["plan"] if e["date"] == ds]:
            r = recipes.get(e.get("recipe_id") or "")
            item = {"slot": e["slot"], "title": e.get("title") or (r["title"] if r else ""), "servings": e.get("servings") or household,
                    "leftovers": bool(e.get("leftovers_of")), "cooked": e.get("cooked", False)}
            if r:
                item["recipe_id"] = r["id"]
                item["total_min"] = r.get("total_min")
                if not e.get("leftovers_of"):
                    seen[r["id"]] = seen.get(r["id"], 0) + 1
                if r.get("cuisine"):
                    cuisines[r["cuisine"]] = cuisines.get(r["cuisine"], 0) + 1
                limit = prefs.get("weeknight_minutes") if d.weekday() < 5 else (prefs.get("weekend_minutes") or None)
                if limit and (r.get("total_min") or 0) > limit and not e.get("leftovers_of") and e["slot"] == "dinner":
                    over_time.append(f"{ds}: {r['title']} ({r['total_min']} min > {limit})")
                c = conflicts(prefs, r)
                if c:
                    warn[r["title"]] = c
                n = r.get("nutrition") or {}
                if n.get("calories") is not None:
                    kcal += n["calories"]
                    protein += n.get("protein_g") or 0
                    with_n += 1
            meals.append(item)
        missing = [s for s in prefs.get("slots", ["dinner"]) if not any(m["slot"] == s for m in meals)]
        empty += len(missing)
        day = {"date": ds, "weekday": d.strftime("%a"), "meals": meals, "empty_slots": missing}
        if with_n:
            day["per_person_from_recipes"] = {"calories": round(kcal), "protein_g": round(protein), "meals_with_nutrition": with_n}
        days.append(day)
        d += timedelta(days=1)
    targets = {k: v for k, v in (("calories", prefs.get("calories_per_day")), ("protein_g", prefs.get("protein_g_per_day"))) if v}
    if ctx.read_item is not None:
        try:
            other = await ctx.read_item("meals")
        except Exception:  # noqa: BLE001 — another item's shape is not ours to trust
            other = None
        if other:
            for k, v in _targets_in(other[2]).items():
                targets.setdefault(k, v)
    planned = sum(len(x["meals"]) for x in days)
    return ActionOutcome(
        summary="",
        result={
            "start": start,
            "end": end,
            "days": days,
            "planned_meals": planned,
            "empty_slots": empty,
            "repeats": {recipes[k]["title"]: v for k, v in seen.items() if v > 1},
            "cuisines": cuisines,
            "over_time_limit": over_time,
            "preference_warnings": warn,
            "daily_targets": targets,
            "grocery_list": {
                "range": [data["grocery"].get("start"), data["grocery"].get("end")],
                "open_items": sum(1 for i in data["grocery"]["items"] if not i["checked"]),
            },
        },
    )


class RecipeNutrition(BaseModel):
    recipe_id: str
    servings: float | None = Field(None, gt=0, le=100, description="How many servings to total (default 1)")


def recipe_nutrition(ctx: ItemContext, data: dict, p: RecipeNutrition) -> ActionOutcome:
    r = need_recipe(data, p.recipe_id)
    n = r.get("nutrition")
    if not n or all(v is None for v in n.values()):
        return ActionOutcome(summary="", result={
            "title": r["title"],
            "nutrition": None,
            "message": "No nutrition stored for this recipe. Estimate it from the ingredients (state that it's an estimate) and save it with edit_recipe.",
            "ingredients_per_serving": [_fmt_ing(units.scale_line(i, 1 / r["servings"], "metric")) for i in r["ingredients"]],
        })
    k = p.servings or 1
    per = {key: v for key, v in n.items() if v is not None}
    total = {key: round(v * k, 1) for key, v in per.items()}
    prefs = data["preferences"]
    pct = {}
    if prefs.get("calories_per_day") and per.get("calories"):
        pct["calories"] = round(per["calories"] / prefs["calories_per_day"] * 100)
    if prefs.get("protein_g_per_day") and per.get("protein_g"):
        pct["protein_g"] = round(per["protein_g"] / prefs["protein_g_per_day"] * 100)
    if per.get("calories"):
        macro_kcal = (per.get("protein_g") or 0) * 4 + (per.get("carbs_g") or 0) * 4 + (per.get("fat_g") or 0) * 9
        split = {}
        if macro_kcal:
            split = {m: round((per.get(f"{m}_g") or 0) * f / macro_kcal * 100) for m, f in (("protein", 4), ("carbs", 4), ("fat", 9))}
    else:
        split = {}
    return ActionOutcome(summary="", result={
        "title": r["title"], "per_serving": per, "servings": k, "total": total,
        "percent_of_daily_target_per_serving": pct, "calorie_split_percent": split,
    })


# ------------------------------------------------------------- import (web)


class ImportRecipeUrl(BaseModel):
    url: str = Field(min_length=8, max_length=2000, description="A recipe page (most recipe sites publish schema.org data)")
    servings: float | None = Field(None, gt=0, le=100, description="Override the servings")
    tags: list[str] = Field(default_factory=list, max_length=10)


async def import_recipe_url(ctx: ItemContext, data: dict, p: ImportRecipeUrl) -> ActionOutcome:
    from app.items.kinds.mealplan.web import ImportFailed, fetch_recipe

    existing = next((r for r in data["recipes"] if r.get("source_url") == p.url), None)
    if existing:
        return ActionOutcome(summary=f"“{existing['title']}” is already in the recipe box", result={"id": existing["id"], "already_saved": True})
    try:
        draft = await fetch_recipe(p.url)
    except ImportFailed as e:
        raise ActionError(str(e)) from e
    if p.servings:
        draft["servings"] = p.servings
    draft["tags"] = list(dict.fromkeys([*draft.get("tags", []), *[t.lower() for t in p.tags]]))[:20]
    rid = new_recipe_id(data, draft["title"])
    rec = {**draft, "id": rid, "rating": 0, "favorite": False, "times_cooked": 0, "last_cooked": None,
           "prep_ahead": "", "added": ctx.today.isoformat()}
    for n, ing in enumerate(rec["ingredients"], 1):
        ing["id"] = f"i{n}"
    rec["source_url"] = safe_link(rec.get("source_url") or p.url)[:1000]
    rec["image_url"] = safe_link(rec.get("image_url"))[:2000]
    data["recipes"].append(rec)
    line, allergens = allergen_warnings(data, [rec], ctx.today)
    return ActionOutcome(
        summary=f"Imported “{rec['title']}” ({len(rec['ingredients'])} ingredients, {len(rec['steps'])} steps)"
        + (f". {line}" if line else ""),
        result={"id": rid, "conflicts_with_preferences": conflicts(data["preferences"], rec), "allergen_conflicts": allergens},
    )


