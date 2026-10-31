"""Meals & Macros (app/items/kinds/meals): the model, targets science,
every action, to_text, reminders, Open Food Facts (mocked httpx), the kind
router and one end-to-end API flow."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.items.kinds.meals import SPEC, off, science
from app.items.kinds.meals.foods_db import builtin_foods
from app.items.service import run_action
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 8, 15, tzinfo=TZ)  # a Saturday morning


def _ctx(now: datetime = NOW, read_item=None) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ, read_item=read_item)  # type: ignore[arg-type]


def _fresh() -> dict:
    return SPEC.validate(SPEC.template(_ctx()))


async def _run(data: dict, name: str, args: dict | None = None, ctx: ItemContext | None = None):
    out = await run_action(ctx or _ctx(), SPEC, data, name, args or {})
    SPEC.validate(data)  # every action leaves a valid file
    return out


# ------------------------------------------------------------------- model


def test_template_is_valid_and_has_defaults():
    d = _fresh()
    assert [s["name"] for s in d["settings"]["meal_slots"]] == ["Breakfast", "Lunch", "Dinner", "Snacks"]
    assert d["profile"]["onboarded"] is False and d["targets"]["kcal"] == 2000
    assert d["days"] == {} and d["foods"] == []
    # Old/empty files still load.
    assert SPEC.validate({})["settings"]["energy_unit"] == "kcal"


def test_model_rejects_bad_data_and_normalises():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        SPEC.validate({"days": {"31/10/2026": {}}})
    with pytest.raises(ValidationError):
        SPEC.validate({"foods": [{"id": "f1", "name": "x", "per100": {"kcal": -5}}]})
    d = SPEC.validate(
        {
            "foods": [{"id": "f1", "name": "Bar", "barcode": "93-1000 1234", "per100": {"kcal": 123.456, "micros": {"iron_mg": 2, "bogus": 9}}}],
            "weighins": [{"date": "2026-10-02", "kg": 80}, {"date": "2026-10-01", "kg": 81}, {"date": "2026-10-02", "kg": 79.5}],
            "favourites": ["a", "a", "b"],
            "settings": {"meal_slots": [{"id": "x", "name": "X", "remind_at": "25:00"}, {"id": "x", "name": "Dup"}]},
        }
    )
    f = d["foods"][0]
    assert f["barcode"] == "9310001234" and f["per100"]["kcal"] == 123.5 and f["per100"]["micros"] == {"iron_mg": 2.0}
    assert [w["date"] for w in d["weighins"]] == ["2026-10-01", "2026-10-02"] and d["weighins"][1]["kg"] == 79.5
    assert d["favourites"] == ["a", "b"]
    assert d["settings"]["meal_slots"] == [{"id": "x", "name": "X", "remind_at": None, "hidden": False}]


def test_builtin_foods_are_sane():
    foods = builtin_foods()
    assert len(foods) >= 150
    for ref, f in foods.items():
        assert ref.startswith("b:") and f["servings"], ref
        p = f["per100"]
        # Energy roughly matches the macros (Atwater; alcohol and fibre explain the rest).
        atwater = p["protein"] * 4 + p["carbs"] * 4 + p["fat"] * 9 + p["micros"].get("alcohol_g", 0) * 7
        assert abs(atwater - p["kcal"]) <= max(25, 0.2 * p["kcal"]), (ref, atwater, p["kcal"])
        assert p["sugar"] <= p["carbs"] + 0.1 and p["sat_fat"] <= p["fat"] + 0.1, ref
        SPEC.validate({"foods": [{**{k: v for k, v in f.items() if k not in ("category", "source")}, "id": "x"}]})


# ----------------------------------------------------------------- science


def test_mifflin_st_jeor_and_targets():
    assert science.bmr("male", 30, 180, 80) == pytest.approx(1780)
    assert science.bmr("female", 30, 165, 60) == pytest.approx(1320.25)
    prof = {"sex": "male", "birth_year": 1996, "height_cm": 180, "weight_kg": 80, "activity": "moderate", "goal": "lose", "rate_pct": 0.5}
    t = science.compute_targets(prof, date(2026, 10, 31))
    tdee = 1780 * 1.55
    assert t["basis"]["tdee"] == round(tdee)
    assert t["kcal"] == pytest.approx(round((tdee - 80 * 0.005 * 7700 / 7) / 10) * 10)
    assert t["protein"] == 160  # 2.0 g/kg in a deficit
    assert t["fat"] >= 40 and t["carbs"] > 0 and 25 <= t["fibre"] <= 38
    assert abs(t["protein"] * 4 + t["carbs"] * 4 + t["fat"] * 9 - t["kcal"]) < 10


def test_targets_are_floored_and_capped():
    small = {"sex": "female", "birth_year": 1960, "height_cm": 150, "weight_kg": 48, "activity": "sedentary", "goal": "lose", "rate_pct": 1.5}
    t = science.compute_targets(small, date(2026, 10, 31))
    assert t["kcal"] == 1200 and "floor" in t["basis"]["notes"] and "capped" in t["basis"]["notes"]
    assert t["basis"]["protein_per_kg"] >= 1.2  # older adult
    big = {"sex": "male", "birth_year": 1980, "height_cm": 175, "weight_kg": 130, "activity": "light", "goal": "maintain"}
    t = science.compute_targets(big, date(2026, 10, 31))
    assert t["protein"] < 130 * 1.6 and "reference weight" in t["basis"]["notes"]
    keto = {**big, "diet_style": "keto"}
    assert science.compute_targets(keto, date(2026, 10, 31))["carbs"] == 30
    with pytest.raises(ValueError):
        science.compute_targets({"weight_kg": 70}, date(2026, 10, 31))


def test_weights_from_any_health_shape():
    shapes = [
        {"weights": [{"date": "2026-10-01", "kg": 80.2}, {"date": "2026-10-02", "kg": 80.0}]},
        {"measurements": [{"at": "2026-10-01T07:00:00+10:00", "metric": "weight", "value": 80.2}, {"at": "2026-10-02T07:00:00+10:00", "metric": "body_fat", "value": 20}]},
        {"log": {"2026-10-01": {"weight_kg": 80.2}}},
        {"entries": [{"day": "2026-10-01", "weight": 176.8, "unit": "lb"}]},
        {"body": {"weight": {"2026-10-01": 80.2}}},
    ]
    for s in shapes:
        got = science.weights_from_health(s)
        assert got and got[0][0] == "2026-10-01" and got[0][1] == pytest.approx(80.2, abs=0.1), s
    assert science.weights_from_health({"x": 1}) == []


def _seed_weeks(data: dict, *, kcal: float, start_kg: float, kg_per_week: float, days: int = 28) -> list[tuple[str, float]]:
    weights = []
    for i in range(days):
        d = (NOW.date() - timedelta(days=days - i)).isoformat()
        data["days"][d] = {"entries": [{"id": f"e{i}", "name": "Food", "slot": "lunch", "amount": 1, "unit": "serving", "n": {"kcal": kcal, "protein": 150}}], "water_ml": 0, "note": "", "complete": True}
        if i % 2 == 0:
            weights.append((d, round(start_kg + kg_per_week * i / 7, 2)))
    return weights


def test_adaptive_tdee_recovers_true_expenditure():
    data = _fresh()
    data["profile"].update(sex="male", birth_year=1990, height_cm=180, weight_kg=85, activity="moderate")
    # Eating 2200 and losing 0.5 kg/week → TDEE ≈ 2200 + 0.5*7700/7 = 2750.
    weights = _seed_weeks(data, kcal=2200, start_kg=86, kg_per_week=-0.5)
    data = SPEC.validate(data)
    est = science.estimate_tdee(data, weights, NOW.date(), 21)
    assert est["adaptive_tdee"] == pytest.approx(2750, abs=40)
    assert est["confidence"] == "high" and est["logged_days"] == 21
    assert est["weight_change_kg_per_week"] == pytest.approx(-0.5, abs=0.02)
    # Thin data → falls back to the formula and says what's needed.
    est = science.estimate_tdee(data, weights[-2:], NOW.date(), 21)
    assert est["adaptive_tdee"] is None and est["confidence"] == "none" and est["tdee"] == est["formula_tdee"] and est["needs"]
    tr = science.trend(weights)
    assert tr[0][0] == weights[0][0] and len(tr) == (date.fromisoformat(weights[-1][0]) - date.fromisoformat(weights[0][0])).days + 1


def test_partial_days_are_left_out_of_the_estimate():
    data = _fresh()
    weights = _seed_weeks(data, kcal=2000, start_kg=80, kg_per_week=0)
    d = (NOW.date() - timedelta(days=3)).isoformat()
    data["days"][d]["complete"] = False
    data["days"][d]["entries"][0]["n"]["kcal"] = 300  # clearly not a full day
    est = science.estimate_tdee(SPEC.validate(data), weights, NOW.date(), 21)
    assert est["partial_days_skipped"] == 1 and est["avg_intake_kcal"] == 2000


# ----------------------------------------------------------------- actions


async def test_log_foods_from_builtins_and_estimates():
    data = _fresh()
    out = await _run(
        data,
        "log_foods",
        {
            "items": [
                {"name": "Eggs", "food_id": "b:egg", "amount": 2, "unit": "serving"},
                {"name": "Toast with butter", "portion": "1 slice + 10 g butter", "kcal": 150, "protein": 3, "carbs": 14, "fat": 9, "grams": 38},
                {"name": "Flat white", "food_id": "b:latte", "amount": 220, "unit": "ml", "slot": "snacks"},
            ]
        },
    )
    day = data["days"]["2026-10-31"]
    eggs, toast, coffee = day["entries"]
    assert eggs["slot"] == "breakfast" and eggs["grams"] == 100 and eggs["n"]["kcal"] == 143 and not eggs["estimate"] and eggs["source"] == "food"
    assert eggs["serving_label"] == "1 large" and eggs["time"] == "08:15"
    assert toast["estimate"] and toast["food_ref"] is None and toast["serving_label"] == "1 slice + 10 g butter" and toast["source"] == "ai"
    assert coffee["slot"] == "snacks" and coffee["n"]["kcal"] == pytest.approx(118.8)
    assert "~" in out.summary and out.result["day_total"]["kcal"] == pytest.approx(143 + 150 + 118.8, abs=0.2)
    assert out.result["remaining"]["kcal"] == round(2000 - (143 + 150 + 118.8))
    # Macros-only lines get Atwater energy; nothing at all is refused.
    await _run(data, "log_foods", {"date": "yesterday", "slot": "Dinner", "items": [{"name": "Steak", "protein": 50, "fat": 20}]})
    assert data["days"]["2026-10-30"]["entries"][0]["n"]["kcal"] == 380 and data["days"]["2026-10-30"]["entries"][0]["time"] is None
    with pytest.raises(ActionError, match="needs a food_id"):
        await _run(data, "log_foods", {"items": [{"name": "Mystery"}]})
    with pytest.raises(ActionError, match="No food"):
        await _run(data, "log_foods", {"items": [{"name": "x", "food_id": "b:nope"}]})
    with pytest.raises(ActionError, match="no meal called"):
        await _run(data, "log_foods", {"slot": "elevenses", "items": [{"name": "x", "kcal": 10}]})
    with pytest.raises(ActionError, match="YYYY-MM-DD"):
        await _run(data, "log_foods", {"date": "31/10", "items": [{"name": "x", "kcal": 10}]})


async def test_log_foods_ids_are_deterministic_and_save_as_food():
    a, b = _fresh(), _fresh()
    args = {"items": [{"name": "Banana bread", "kcal": 320, "protein": 5, "carbs": 50, "fat": 11, "grams": 100, "portion": "1 slice", "save_as_food": True}]}
    await _run(a, "log_foods", args)
    await _run(b, "log_foods", args)
    assert a == b
    f = a["foods"][0]
    assert a["days"]["2026-10-31"]["entries"][0]["food_ref"] == f["id"] and f["per100"]["kcal"] == 320 and f["servings"][0]["label"] == "1 slice"


async def test_edit_and_delete_entries():
    data = _fresh()
    await _run(data, "log_foods", {"items": [{"name": "Rice", "food_id": "b:rice-white", "amount": 150, "unit": "g", "slot": "lunch"}, {"name": "Curry", "kcal": 400, "protein": 30, "carbs": 20, "fat": 22, "grams": 300}]})
    rice, curry = data["days"]["2026-10-31"]["entries"]
    await _run(data, "edit_entry", {"entry_id": rice["id"], "amount": 1, "unit": "serving"})
    assert rice["grams"] == 158 and rice["n"]["kcal"] == pytest.approx(205.4)
    await _run(data, "edit_entry", {"entry_id": curry["id"], "amount": 150, "unit": "g", "slot": "dinner"})
    assert curry["n"]["kcal"] == 200 and curry["slot"] == "dinner"
    await _run(data, "edit_entry", {"entry_id": curry["id"], "protein": 40})
    assert curry["n"]["protein"] == 40 and curry["n"]["kcal"] == science.kcal_from_macros(40, 10, 11)
    await _run(data, "edit_entry", {"entry_id": curry["id"], "move_to_date": "2026-10-30"})
    assert len(data["days"]["2026-10-31"]["entries"]) == 1 and data["days"]["2026-10-30"]["entries"][0]["id"] == curry["id"]
    with pytest.raises(ActionError):
        await _run(data, "edit_entry", {"entry_id": "nope", "amount": 2})
    out = await _run(data, "delete_entries", {"date": "2026-10-30", "entry_ids": [curry["id"]]})
    assert out.result["removed"] == 1 and data["days"]["2026-10-30"]["entries"] == []
    with pytest.raises(ActionError):
        await _run(data, "delete_entries", {"entry_ids": ["gone"]})


async def test_food_edits_never_rewrite_history():
    data = _fresh()
    f = (await _run(data, "add_food", {"name": "Protein bar", "brand": "Acme", "per": "serving", "serving_label": "1 bar", "serving_grams": 60, "kcal": 210, "protein": 20, "carbs": 22, "fat": 7, "favourite": True})).result
    assert f["per100"]["kcal"] == 350 and data["favourites"] == [f["food_id"]]
    await _run(data, "log_foods", {"items": [{"name": "bar", "food_id": f["food_id"], "amount": 1}]})
    await _run(data, "edit_food", {"food_id": f["food_id"], "kcal": 500})
    assert data["foods"][0]["per100"]["kcal"] == 500
    assert data["days"]["2026-10-31"]["entries"][0]["n"]["kcal"] == 210  # snapshot kept
    await _run(data, "delete_food", {"food_id": f["food_id"]})
    assert data["foods"] == [] and data["favourites"] == [] and data["days"]["2026-10-31"]["entries"][0]["n"]["kcal"] == 210
    with pytest.raises(ActionError, match="Built-in"):
        await _run(data, "edit_food", {"food_id": "b:egg", "kcal": 1})
    with pytest.raises(ActionError, match="serving_grams"):
        await _run(data, "add_food", {"name": "x", "per": "serving", "kcal": 10})
    with pytest.raises(ActionError):
        await _run(data, "delete_food", {"food_id": "nope"})
    await _run(data, "favourite_food", {"food_id": "b:banana"})
    assert data["favourites"] == ["b:banana"]
    await _run(data, "favourite_food", {"food_id": "b:banana", "on": False})
    assert data["favourites"] == []


async def test_saved_meals_and_copy_day():
    data = _fresh()
    await _run(data, "log_foods", {"date": "yesterday", "slot": "breakfast", "items": [{"name": "Oats", "food_id": "b:oats", "amount": 40, "unit": "g"}, {"name": "Milk", "food_id": "b:milk-2", "amount": 200, "unit": "ml"}]})
    m = (await _run(data, "save_meal", {"name": "Usual oats", "from_date": "yesterday", "from_slot": "breakfast"})).result
    meal = data["meals"][0]
    assert meal["id"] == m["meal_id"] and meal["slot"] == "breakfast" and len(meal["items"]) == 2
    out = await _run(data, "log_saved_meal", {"meal": "usual oats", "servings": 1.5})
    today = data["days"]["2026-10-31"]["entries"]
    assert len(today) == 2 and today[0]["slot"] == "breakfast" and today[0]["source"] == "meal" and today[0]["grams"] == 60
    assert out.result["day_total"]["kcal"] == pytest.approx((379 * 0.4 + 50 * 2.06) * 1.5, abs=0.5)  # milk: 200 ml x 1.03 g/ml
    await _run(data, "copy_day", {"from_date": "yesterday", "slots": ["Breakfast"], "to_slot": "snacks"})
    assert len(today) == 4 and {e["slot"] for e in today[2:]} == {"snacks"} and today[2]["source"] == "copy"
    await _run(data, "copy_day", {"from_date": "yesterday", "replace": True})
    assert len(data["days"]["2026-10-31"]["entries"]) == 4  # breakfast replaced, snacks kept
    with pytest.raises(ActionError, match="Nothing is logged"):
        await _run(data, "copy_day", {"from_date": "2026-01-01"})
    with pytest.raises(ActionError):
        await _run(data, "save_meal", {"name": "Empty", "from_date": "2026-01-01"})
    await _run(data, "save_meal", {"name": "Shake", "items": [{"name": "Whey", "food_id": "b:whey", "amount": 1}]})
    await _run(data, "delete_saved_meal", {"meal": "Shake"})
    assert [x["name"] for x in data["meals"]] == ["Usual oats"]
    with pytest.raises(ActionError):
        await _run(data, "log_saved_meal", {"meal": "nope"})


async def test_water_day_and_weight():
    data = _fresh()
    await _run(data, "log_water", {"ml": 500})
    out = await _run(data, "log_water", {"ml": 250})
    assert out.result["water_ml"] == 750
    await _run(data, "log_water", {"ml": -2000})
    assert data["days"]["2026-10-31"]["water_ml"] == 0
    await _run(data, "set_day", {"complete": True, "note": "Birthday dinner"})
    assert data["days"]["2026-10-31"]["complete"] and data["days"]["2026-10-31"]["note"] == "Birthday dinner"
    await _run(data, "log_weight", {"weight": 176.4, "unit": "lb"})
    assert data["weighins"] == [{"date": "2026-10-31", "kg": 80.01}] and data["profile"]["weight_kg"] == 80.0
    with pytest.raises(ActionError):
        await _run(data, "log_weight", {"weight": 5})


async def test_targets_actions():
    data = _fresh()
    out = await _run(data, "compute_targets", {"sex": "female", "age": 34, "height_cm": 168, "weight_kg": 70, "activity": "light", "goal": "lose", "rate_pct": 0.5})
    t = data["targets"]
    assert t["mode"] == "auto" and data["profile"]["onboarded"] and data["profile"]["birth_year"] == 1992
    assert t["kcal"] == out.result["kcal"] and t["basis"]["tdee"] > t["kcal"] and t["protein"] == 140
    preview = await _run(data, "compute_targets", {"goal": "maintain", "apply": False})
    assert preview.result["kcal"] > t["kcal"] and data["profile"]["goal"] == "lose"
    with pytest.raises(ActionError, match="Not enough data"):
        await _run(data, "compute_targets", {"use_adaptive": True})
    await _run(data, "set_targets", {"kcal": 1900})
    assert t["mode"] == "custom" and t["kcal"] == 1900 and t["protein"] == 140
    assert abs(science.kcal_from_macros(t["protein"], t["carbs"], t["fat"]) - 1900) < 10
    out = await _run(data, "set_targets", {"protein": 150, "carbs": 150, "fat": 60, "weekday": [{"day": "sat", "kcal": 2300, "carbs": 250}], "water_ml": 2500})
    assert t["kcal"] == 1740 and t["weekday"] == {"sat": {"kcal": 2300, "carbs": 250}}
    assert science.targets_for(t, "2026-10-31")["kcal"] == 2300  # a Saturday
    assert science.targets_for(t, "2026-11-02")["kcal"] == 1740
    out = await _run(data, "set_targets", {"kcal": 1000})
    assert any("1200" in n for n in out.result["notes"])
    await _run(data, "set_targets", {"clear_weekday": True})
    assert t["weekday"] == {}
    with pytest.raises(ActionError):
        await _run({**_fresh()}, "compute_targets", {"weight_kg": 70})


async def test_adaptive_targets_read_the_health_item():
    data = _fresh()
    data["profile"].update(sex="male", birth_year=1990, height_cm=180, weight_kg=85, activity="moderate", goal="lose", rate_pct=0.5)
    weights = _seed_weeks(data, kcal=2200, start_kg=86, kg_per_week=-0.5)
    data = SPEC.validate(data)
    asked = []

    async def read_item(kind):
        asked.append(kind)
        return (uuid.uuid4(), "Body", {"weights": [{"date": d, "kg": kg} for d, kg in weights]})

    ctx = _ctx(read_item=read_item)
    est = (await _run(data, "estimate_tdee", {}, ctx)).result
    assert asked == ["health"] and est["adaptive_tdee"] == pytest.approx(2750, abs=40)
    assert est["suggested_targets"]["kcal"] < est["tdee"] and est["trend_weight_kg"]
    # Passing weights directly works too (no read).
    est2 = (await _run(data, "estimate_tdee", {"weights": [{"date": d, "kg": kg} for d, kg in weights]})).result
    assert est2["adaptive_tdee"] == est["adaptive_tdee"]
    out = await _run(data, "compute_targets", {"use_adaptive": True}, ctx)
    assert data["targets"]["basis"]["tdee_source"] == "adaptive" and out.result["tdee_estimate"]["confidence"] == "high"


async def test_preferences_and_slots():
    data = _fresh()
    await _run(data, "log_foods", {"slot": "snacks", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    await _run(data, "update_preferences", {"meal_slots": ["Breakfast", "Lunch", "Pre-workout", "Dinner"], "energy_unit": "kJ", "reminder_times": {"Lunch": "12:30"}, "diet_tags": ["Vegetarian"], "close_day_at": "21:00"})
    s = data["settings"]
    assert [x["id"] for x in s["meal_slots"] if not x["hidden"]] == ["breakfast", "lunch", "preworkout", "dinner"]
    assert s["energy_unit"] == "kJ" and s["reminders"] and s["meal_slots"][1]["remind_at"] == "12:30" and s["close_day_at"] == "21:00"
    # The removed meal is hidden, never merged: its entry stays where it was.
    assert data["days"]["2026-10-31"]["entries"][0]["slot"] == "snacks"
    assert next(x for x in s["meal_slots"] if x["id"] == "snacks")["hidden"] is True
    assert data["profile"]["diet_tags"] == ["vegetarian"]
    with pytest.raises(ActionError):
        await _run(data, "update_preferences", {"reminder_times": {"Brunch2": "10:00"}})


async def test_read_only_analysis():
    data = _fresh()
    data["targets"].update(kcal=2000, protein=150)
    for i, kcal in enumerate([1900, 2100, 2500, 0, 2000, 1950, 2050]):
        d = (NOW.date() - timedelta(days=6 - i)).isoformat()
        if kcal:
            await _run(data, "log_foods", {"date": d, "slot": "lunch", "items": [{"name": "Chips" if i == 2 else "Meal", "kcal": kcal, "protein": 140, "carbs": 200, "fat": 70, "sodium_mg": 3000 if i == 2 else 500}]})
    week = (await _run(data, "week_summary", {})).result
    assert week["logged_days"] == 6 and len(week["days"]) == 7 and week["days"][3]["logged"] is False
    assert week["average_per_logged_day"]["kcal"] == pytest.approx(2083.3, abs=0.1)
    assert week["days_within_10pct_of_kcal"] == 5 and week["days_protein_at_least_90pct"] == 6
    assert week["macro_split_pct"]["protein"] == round(140 * 4 / (12500 / 6) * 100)
    day = (await _run(data, "day_summary", {})).result
    assert day["totals"]["kcal"] == 2050 and day["meals"][1]["entries"][0]["name"] == "Meal" and day["remaining"]["kcal"] == -50
    rem = (await _run(data, "remaining_today", {"date": "2026-10-31"})).result
    assert rem["remaining"]["protein"] == 10 and "Breakfast" in rem["meals_not_logged"]
    top = (await _run(data, "top_foods_by_nutrient", {"nutrient": "salt", "days": 7})).result
    assert top["nutrient"] == "sodium" and top["top"][0]["name"] == "Chips" and top["top"][0]["share_pct"] == pytest.approx(54.5)
    with pytest.raises(ActionError):
        await _run(data, "top_foods_by_nutrient", {"nutrient": "unobtainium"})
    found = (await _run(data, "search_foods", {"query": "greek yogurt"})).result["foods"]
    assert found and "Greek yogurt" in found[0]["name"] and found[0]["food_id"].startswith("b:")
    # Library foods outrank built-ins.
    await _run(data, "add_food", {"name": "Greek yogurt honey", "brand": "Chobani", "kcal": 110})
    assert (await _run(data, "search_foods", {"query": "greek yogurt"})).result["foods"][0]["source"] == "library"


# -------------------------------------------------------------- text etc.


async def test_to_text_is_bounded_and_newest_first():
    data = _fresh()
    await _run(data, "compute_targets", {"sex": "male", "age": 40, "height_cm": 178, "weight_kg": 82, "goal": "lose", "rate_pct": 0.5})
    await _run(data, "log_foods", {"date": "2026-10-30", "items": [{"name": "Pasta", "food_id": "b:pasta", "amount": 250, "unit": "g", "slot": "dinner"}]})
    await _run(data, "log_foods", {"items": [{"name": "Porridge", "food_id": "b:oatmeal", "amount": 1, "slot": "breakfast"}]})
    await _run(data, "save_meal", {"name": "Pasta night", "from_date": "2026-10-30"})
    text = SPEC.to_text(data)
    assert "Goal: lose" in text and "Daily targets" in text and "Pasta night" in text
    assert text.index("2026-10-31") < text.index("2026-10-30") and "Oatmeal" in text
    # Years of data stay bounded.
    big = _fresh()
    for i in range(900):
        d = (NOW.date() - timedelta(days=i)).isoformat()
        big["days"][d] = {"entries": [{"id": f"e{i}-{j}", "name": f"Food {j}", "slot": "lunch", "n": {"kcal": 300}} for j in range(10)]}
    big = SPEC.validate(big)
    assert len(SPEC.to_text(big)) <= 20_000
    assert len(json.dumps(big)) < SPEC.max_bytes


def test_reminders_skip_logged_meals_and_past_times():
    data = _fresh()
    data["settings"]["reminders"] = True
    data["settings"]["meal_slots"][0]["remind_at"] = "08:00"  # already past today
    data["settings"]["meal_slots"][1]["remind_at"] = "12:30"
    data["settings"]["meal_slots"][2]["remind_at"] = "19:00"
    data["settings"]["close_day_at"] = "21:30"
    data["days"]["2026-10-31"] = {"entries": [{"id": "e1", "name": "x", "slot": "dinner", "n": {"kcal": 1}}]}
    data = SPEC.validate(data)
    rs = SPEC.reminders(data, _ctx())
    today = [r for r in rs if "2026-10-31" in r.key]
    assert sorted(r.key for r in today) == ["close:2026-10-31", "meal:2026-10-31:lunch"]
    assert all(r.due_at.tzinfo is not None and r.due_at > NOW for r in rs)
    assert any(r.key == "meal:2026-11-01:breakfast" for r in rs)
    data["settings"]["reminders"] = False
    assert SPEC.reminders(data, _ctx()) == []


def test_tools_have_no_refs_and_cover_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names and "read_other_item" in names and "web_search" in names
    assert "$ref" not in json.dumps(tools)
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "log_foods" not in ro and {"day_summary", "estimate_tdee", "search_foods"} <= ro


# ------------------------------------------------------------ Open Food Facts


_PRODUCT = {
    "code": "9300633603557",
    "product_name": "Crunchy Peanut Butter",
    "brands": "Bega, Mondelez",
    "serving_size": "20 g",
    "serving_quantity": 20,
    "quantity": "375 g",
    "nutriments": {
        "energy-kcal_100g": 637,
        "proteins_100g": 26.6,
        "carbohydrates_100g": 10.9,
        "sugars_100g": 6.7,
        "fiber_100g": 7.4,
        "fat_100g": 51.6,
        "saturated-fat_100g": 8.0,
        "sodium_100g": 0.36,
        "potassium_100g": 0.7,
        "vitamin-d_100g": 0.000001,
    },
}


@pytest.fixture
def mock_off(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.headers["User-Agent"].startswith("Promptly/") and "(self-hosted)" in request.headers["User-Agent"]
        path = request.url.path
        if path == "/api/v2/product/9300633603557.json":
            return httpx.Response(200, json={"status": 1, "product": _PRODUCT})
        if path.startswith("/api/v2/product/"):
            if "4000000000006" in path:
                return httpx.Response(500)
            return httpx.Response(404, json={"status": 0})
        if path == "/cgi/search.pl":
            assert request.url.params["json"] == "1" and request.url.params["page_size"]
            return httpx.Response(
                200,
                json={
                    "products": [
                        _PRODUCT,
                        dict(_PRODUCT),  # duplicate collapses
                        {"product_name": "Juice", "brands": "X", "quantity": "1 L", "nutriments": {"energy_100g": 188, "carbohydrates_100g": 10, "salt_100g": 0.05}},
                        {"product_name": "No nutrition"},
                    ]
                },
            )
        return httpx.Response(404)

    def client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), headers={"User-Agent": off.USER_AGENT})

    monkeypatch.setattr(off, "_client", client)
    _reset_off()
    yield calls
    _reset_off()


def _reset_off():
    off._cache.clear()
    off._failed.clear()
    off._calls.clear()
    off._down_until = 0.0


def test_off_mapping():
    f = off.map_product(_PRODUCT)
    assert f["name"] == "Crunchy Peanut Butter" and f["brand"] == "Bega" and f["barcode"] == "9300633603557"
    p = f["per100"]
    assert p["kcal"] == 637 and p["protein"] == 26.6 and p["sodium"] == 360 and p["micros"] == {"potassium_mg": 700.0, "vitamin_d_ug": 1.0}
    assert f["servings"][0] == {"id": "s1", "label": "20 g", "grams": 20.0} and f["servings"][1]["grams"] == 375
    # kJ only, salt only, per-serving only.
    g = off.map_product({"product_name": "Y", "serving_quantity": 50, "nutriments": {"energy_serving": 418.4, "proteins_serving": 5, "salt_serving": 0.5}})
    assert g["per100"]["kcal"] == 200 and g["per100"]["protein"] == 10 and g["per100"]["sodium"] == 400
    assert off.map_product({"product_name": "Z", "nutriments": {}}) is None
    assert off.map_product({"nutriments": {"energy-kcal_100g": 5}}) is None
    # The mapped food fits the file's model.
    SPEC.validate({"foods": [{**f, "id": "f1"}]})


async def test_off_barcode_search_and_cache(mock_off):
    food = await off.lookup_barcode("9300633603557")
    assert food["name"] == "Crunchy Peanut Butter"
    again = await off.lookup_barcode("9300633603557")
    assert again == food and len(mock_off) == 1  # cached
    assert await off.lookup_barcode("0000000000017") is None
    with pytest.raises(off.OffUnavailable):
        await off.lookup_barcode("4000000000006")
    with pytest.raises(ValueError):
        await off.lookup_barcode("12")
    found = await off.search("peanut butter")
    assert [f["name"] for f in found] == ["Crunchy Peanut Butter", "Juice"]
    assert found[1]["liquid"] and found[1]["per100"]["kcal"] == pytest.approx(44.9, abs=0.1) and found[1]["per100"]["sodium"] == 20
    assert await off.search("p") == []


async def test_off_action(mock_off):
    data = _fresh()
    res = (await _run(data, "search_open_food_facts", {"barcode": "9300633603557"})).result
    assert res["foods"][0]["per100"]["kcal"] == 637
    res = (await _run(data, "search_open_food_facts", {"query": "peanut"})).result
    assert len(res["foods"]) == 2
    with pytest.raises(ActionError):
        await _run(data, "search_open_food_facts", {})
    with pytest.raises(ActionError, match="isn't answering"):
        await _run(data, "search_open_food_facts", {"barcode": "4000000000006"})


# ------------------------------------------------------------ the API flow


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_end_to_end_api(client, db, user, mock_off):
    h = _auth(user)
    assert (await client.post("/api/items/store/meals", headers=h)).status_code == 200
    r = await client.post("/api/items", headers=h, json={"kind": "meals", "title": "My food"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "My food.meals" and item["data"]["profile"]["onboarded"] is False

    r = await client.post(f"/api/items/{fid}/actions/compute_targets", headers=h, json={"args": {"sex": "male", "age": 30, "height_cm": 180, "weight_kg": 80, "activity": "moderate", "goal": "maintain"}})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["targets"]["kcal"] == round(1780 * 1.55 / 10) * 10
    r = await client.post(f"/api/items/{fid}/actions/log_foods", headers=h, json={"args": {"items": [{"name": "Banana", "food_id": "b:banana", "amount": 1}]}})
    assert r.status_code == 200 and "Banana" in r.json()["summary"]
    rev = r.json()["revision"]
    r = await client.post(f"/api/items/{fid}/actions/log_foods", headers=h, json={"args": {"items": [{"name": "Nothing"}]}})
    assert r.status_code == 400 and "needs a food_id" in r.json()["detail"]
    r = await client.post(f"/api/items/{fid}/actions/remaining_today", headers=h, json={})
    assert r.status_code == 200 and r.json()["revision"] == rev

    # A direct UI save, validated by the model.
    data = r.json()["data"]
    data["weighins"] = [{"date": (date.today() - timedelta(days=i)).isoformat(), "kg": 80 - i * 0.1} for i in range(5)]
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": data, "base_revision": rev})
    assert r.status_code == 200, r.text
    bad = dict(r.json()["data"])
    bad["days"] = {"nope": {}}
    assert (await client.put(f"/api/items/{fid}", headers=h, json={"data": bad, "base_revision": r.json()["revision"]})).status_code == 400

    # The kind's own endpoints.
    r = await client.get("/api/items/k/meals/builtin/foods", headers=h)
    assert r.status_code == 200 and len(r.json()["foods"]) >= 150 and "Fruit" in r.json()["categories"]
    r = await client.get("/api/items/k/meals/off/barcode/9300633603557", headers=h)
    assert r.status_code == 200 and r.json()["food"]["brand"] == "Bega"
    assert (await client.get("/api/items/k/meals/off/barcode/0000000000017", headers=h)).status_code == 404
    assert (await client.get("/api/items/k/meals/off/barcode/4000000000006", headers=h)).status_code == 502
    assert (await client.get("/api/items/k/meals/off/barcode/12", headers=h)).status_code == 400
    r = await client.get("/api/items/k/meals/off/search", headers=h, params={"q": "peanut"})
    assert r.status_code == 200 and len(r.json()["foods"]) == 2
    r = await client.get(f"/api/items/k/meals/trends/{fid}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["weights"]) == 5 and body["trend"] and body["tdee"]["formula_tdee"] and body["tdee"]["confidence"] == "none"
    # Auth is required, and strangers can't read someone's trends.
    assert (await client.get("/api/items/k/meals/off/search", params={"q": "x"})).status_code == 401
    assert (await client.get("/api/items/k/meals/builtin/foods")).status_code == 401
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await db.refresh(other)
    assert (await client.get(f"/api/items/k/meals/trends/{fid}", headers=_auth(other))).status_code == 404


class _FakeModel:
    def __init__(self, hops):
        self.hops = list(hops)
        self.calls = []

    async def stream_chat_events(self, **kw):
        from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

        self.calls.append(kw)
        hop = self.hops.pop(0) if self.hops else {"text": "done"}
        if hop.get("text"):
            yield TextDelta(text=hop["text"])
        for i, (name, args) in enumerate(hop.get("tools", [])):
            yield ToolCallDelta(index=i, id=f"call{i}{len(self.calls)}", name=name, arguments=json.dumps(args))
        yield FinishEvent(reason="tool_calls" if hop.get("tools") else "stop")


async def test_describe_to_log_through_the_ai_panel(client, db, user, monkeypatch):
    from app.items import ai
    from app.models_config import provider as prov

    h = _auth(user)
    await client.post("/api/items/store/meals", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "meals", "title": "Food"})).json()["file_id"]
    fake = _FakeModel(
        [
            {"tools": [("search_foods", {"query": "egg"})]},
            {
                "tools": [
                    (
                        "log_foods",
                        {
                            "slot": "breakfast",
                            "items": [
                                {"name": "Eggs", "food_id": "b:egg", "amount": 2},
                                {"name": "Toast with butter", "portion": "1 slice + 10 g butter", "kcal": 150, "protein": 3, "carbs": 14, "fat": 9, "estimate": True},
                            ],
                        },
                    )
                ]
            },
            {"text": "Logged breakfast (~293 kcal; toast estimated)."},
        ]
    )
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "2 eggs and toast with butter", object(), "m", can_edit=True)]
    done = events[-1]
    assert done["type"] == "done" and done["changed"], events
    entries = next(iter(done["data"]["days"].values()))["entries"]
    assert [e["name"] for e in entries] == ["Egg, whole", "Toast with butter"] and entries[1]["estimate"] is True
    system = fake.calls[0]["system"]
    assert "Mifflin-St Jeor" in system and "eating-disorder" in system.lower()


# ------------------------------------------------------- fix pass: storage


def _banana_entry(i: int, day: str) -> dict:
    food = builtin_foods()["b:banana"]
    return {
        "id": f"e{i:05d}x",
        "name": food["name"],
        "food_ref": food["id"],
        "amount": 1,
        "unit": "serving",
        "serving_id": "s1",
        "serving_label": food["servings"][0]["label"],
        "grams": food["servings"][0]["grams"],
        "n": science.scale(food["per100"], food["servings"][0]["grams"]),
        "slot": "breakfast",
        "source": "food",
        "time": "08:10",
    }


def test_stored_entries_leave_defaults_out_and_load_back():
    from app.items.kinds.meals.models import hydrate

    full = {"name": "Toast", "brand": "", "food_ref": None, "amount": 1.0, "unit": "serving", "serving_id": None, "serving_label": "",
            "grams": None, "estimate": False, "id": "e1", "slot": "breakfast", "source": "quick", "time": None, "note": "",
            "n": {"kcal": 120.0, "protein": 4.0, "carbs": 20.0, "sugar": 0.0, "fibre": 0.0, "fat": 2.0, "sat_fat": 0.0, "sodium": 0.0, "micros": {}}}
    stored = SPEC.validate({"days": {"2026-10-31": {"entries": [full]}}})
    e = stored["days"]["2026-10-31"]["entries"][0]
    assert e == {"name": "Toast", "id": "e1", "slot": "breakfast", "source": "quick", "n": {"kcal": 120, "protein": 4, "carbs": 20, "fat": 2}}
    # Loading fills everything back in; an old (full) file and a slim one read the same.
    assert hydrate(stored)["days"]["2026-10-31"]["entries"][0] == full
    assert SPEC.validate(stored) == stored
    # Non-default values are kept.
    e2 = SPEC.validate({"days": {"2026-10-31": {"entries": [{**full, "estimate": True, "note": "big", "n": {**full["n"], "fibre": 3}}]}}})["days"]["2026-10-31"]["entries"][0]
    assert e2["estimate"] is True and e2["note"] == "big" and e2["n"]["fibre"] == 3


def test_three_years_of_logging_fits():
    data = _fresh()
    start = NOW.date() - timedelta(days=3 * 365)
    for d in range(3 * 365):
        day = (start + timedelta(days=d)).isoformat()
        data["days"][day] = {"entries": [_banana_entry(d * 15 + j, day) for j in range(15)], "complete": True}
    stored = SPEC.validate(data)
    size = len(json.dumps(stored, separators=(",", ":"), ensure_ascii=False))
    per_entry = size / (3 * 365 * 15)
    from app.items.kinds.meals.models import hydrate

    before = len(json.dumps(hydrate(stored), separators=(",", ":"), ensure_ascii=False))
    assert per_entry < 340 and size < 0.8 * before, (per_entry, size / before)
    assert size < 0.75 * SPEC.max_bytes  # three years of heavy logging stays under the "filling up" warning


async def test_archive_moves_old_days_and_keeps_the_library():
    data = _fresh()
    await _run(data, "add_food", {"name": "My bar", "kcal": 200, "protein": 20})
    await _run(data, "log_foods", {"date": "2026-01-10", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    await _run(data, "log_foods", {"date": "2026-10-30", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    await _run(data, "save_meal", {"name": "Snack", "from_date": "2026-10-30"})
    for d, kg in (("2025-12-01", 82), ("2026-01-05", 81), ("2026-09-01", 79), ("2026-10-29", 78)):
        await _run(data, "log_weight", {"date": d, "weight": kg})
    data = SPEC.validate(data)
    kept, archived = SPEC.archive(data, _ctx(), "2026-06-01")
    kept, archived = SPEC.validate(kept), SPEC.validate(archived)
    assert list(kept["days"]) == ["2026-10-30"] and list(archived["days"]) == ["2026-01-10"]
    assert kept["foods"] and kept["meals"] and kept["targets"] == data["targets"] and kept["settings"] == data["settings"]
    assert archived["foods"] == kept["foods"]  # the archive reads on its own
    assert [w["date"] for w in kept["weighins"]] == ["2026-09-01", "2026-10-29"]  # recent ones stay for the trend
    assert [w["date"] for w in archived["weighins"]] == ["2025-12-01", "2026-01-05"]
    assert archived["settings"]["reminders"] is False
    for bad in ("2027-01-01", "1990-01-01", "nope"):
        with pytest.raises(ActionError):
            SPEC.archive(data, _ctx(), bad)


# -------------------------------------------------------- fix pass: search


def test_search_finds_the_basics():
    from app.items.kinds.meals import search as fs
    from app.items.kinds.meals.actions import search_library

    data = _fresh()

    def top(q: str, n: int = 3) -> list[str]:
        return [f["food_id"] for f in search_library(data, q, n)]

    assert top("eggs")[0] == "b:egg"
    assert top("egg")[0] == "b:egg"
    assert top("bananas")[0] == "b:banana"
    assert "b:yogurt-plain" in top("yoghurt", 5) and "b:greek-yogurt-0" in top("greek yoghurt", 2)
    assert top("yog", 4) and all("yogurt" in f for f in top("yog", 4))
    assert top("strawberry")[0] == "b:strawberries"
    assert top("tomatoes")[0] == "b:tomato"
    assert top("cherry")[0] == "b:cherries"
    assert top("aubergine")[0] == "b:eggplant"
    assert top("courgette")[0] == "b:zucchini"
    assert "b:beef-mince-85" in top("ground beef")
    assert top("doughnut")[0] == "b:donut"
    assert top("crisps")[0] == "b:chips"
    assert top("prawns")[0] == "b:shrimp"
    assert top("porridge")[0] == "b:oatmeal"
    assert top("biscuits")[0] == "b:cookie"
    assert top("zzz") == []
    assert fs.tokens("Crème fraîche, 2 Eggs") == ["creme", "fraiche", "2", "egg"]
    assert fs.stem("berries") == fs.stem("berry") and fs.stem("cookies") == fs.stem("cookie") and fs.stem("glasses") == "glass"
    assert fs.stem("hummus") == "hummus" and fs.stem("cheeses") == fs.stem("cheese")


# --------------------------------------------------------- fix pass: slots


async def test_meal_slots_have_stable_ids_and_keep_history():
    data = _fresh()
    await _run(data, "log_foods", {"date": "2026-10-01", "slot": "snacks", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    await _run(data, "save_meal", {"name": "Arvo", "from_date": "2026-10-01", "from_slot": "snacks"})
    # Rename: only the label changes.
    out = await _run(data, "update_preferences", {"rename_meals": {"Snacks": "Treats"}})
    assert "meal names" in out.summary
    slot = next(x for x in data["settings"]["meal_slots"] if x["id"] == "snacks")
    assert slot["name"] == "Treats" and not slot["hidden"]
    assert data["days"]["2026-10-01"]["entries"][0]["slot"] == "snacks"
    # Remove it: hidden (it has history), entries untouched and still shown on that day.
    await _run(data, "update_preferences", {"meal_slots": ["Breakfast", "Lunch", "Dinner"]})
    slot = next(x for x in data["settings"]["meal_slots"] if x["id"] == "snacks")
    assert slot["hidden"] is True and data["days"]["2026-10-01"]["entries"][0]["slot"] == "snacks"
    rep = (await _run(data, "day_summary", {"date": "2026-10-01"})).result
    assert [m["name"] for m in rep["meals"]] == ["Breakfast", "Lunch", "Dinner", "Treats"] and rep["meals"][3]["entries"]
    rep = (await _run(data, "day_summary", {})).result
    assert [m["name"] for m in rep["meals"]] == ["Breakfast", "Lunch", "Dinner"]  # not on days without it
    # A hidden meal can't be logged into, and doesn't remind.
    with pytest.raises(ActionError):
        await _run(data, "log_foods", {"slot": "Treats", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    data["settings"]["reminders"] = True
    next(x for x in data["settings"]["meal_slots"] if x["id"] == "snacks")["remind_at"] = "20:00"
    assert not [r for r in SPEC.reminders(SPEC.validate(data), _ctx()) if ":snacks" in r.key]
    # Copying from the removed meal lands in a shown one.
    await _run(data, "copy_day", {"from_date": "2026-10-01"})
    assert data["days"]["2026-10-31"]["entries"][0]["slot"] == "breakfast"  # 08:15 → breakfast
    # Bringing the name back un-hides the same meal (same id, same history).
    await _run(data, "update_preferences", {"meal_slots": ["Breakfast", "Lunch", "Dinner", "Treats"]})
    assert [x["id"] for x in data["settings"]["meal_slots"] if not x["hidden"]] == ["breakfast", "lunch", "dinner", "snacks"]
    # A meal with no history is simply dropped.
    await _run(data, "update_preferences", {"meal_slots": ["Breakfast", "Dinner", "Treats"]})
    assert "lunch" not in {x["id"] for x in data["settings"]["meal_slots"]}
    with pytest.raises(ActionError):
        await _run(data, "update_preferences", {"meal_slots": [f"Meal {i}" for i in range(9)]})
    # The model refuses more than 8 shown meals, but keeps hidden ones besides.
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        SPEC.validate({"settings": {"meal_slots": [{"id": f"m{i}", "name": f"M{i}"} for i in range(9)]}})
    many = SPEC.validate({"settings": {"meal_slots": [{"id": f"m{i}", "name": f"M{i}", "hidden": i > 3} for i in range(12)]}})
    assert len(many["settings"]["meal_slots"]) == 12


def test_to_text_shows_removed_meals_and_uses_text_now():
    from app.items.spec import _TEXT_NOW

    data = _fresh()
    data["settings"]["meal_slots"].append({"id": "supper", "name": "Supper", "hidden": True})
    data["days"]["2026-10-30"] = {"entries": [{"id": "e1", "name": "Cocoa", "slot": "supper", "n": {"kcal": 150}}, {"id": "e2", "name": "Lost", "slot": "gone", "n": {"kcal": 10}}]}
    data["days"]["2026-11-03"] = {"entries": [{"id": "e3", "name": "Planned", "slot": "lunch", "n": {"kcal": 500}}]}
    data = SPEC.validate(data)
    token = _TEXT_NOW.set(datetime(2026, 10, 31, 23, 30, tzinfo=TZ))
    try:
        text = SPEC.to_text(data)
    finally:
        _TEXT_NOW.reset(token)
    assert "Today is 2026-10-31" in text and "Supper (removed meal): Cocoa" in text and "Other: Lost" in text
    assert "Planned ahead: 2026-11-03" in text and "2026-11-03: " not in text


# ---------------------------------------------------- fix pass: corrections


async def test_edit_entry_reports_the_day_its_really_on():
    data = _fresh()
    out = await _run(data, "log_foods", {"date": "yesterday", "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]})
    eid = out.result["entries"][0]["id"]
    out = await _run(data, "edit_entry", {"entry_id": eid, "amount": 2})  # date defaults to today
    assert out.result["entry"]["date"] == "2026-10-30" and "2026-10-30" in out.summary
    out = await _run(data, "delete_entries", {"entry_ids": [eid]})
    assert out.result["removed"] == 1


async def test_household_measures_for_liquids_and_known_densities():
    data = _fresh()
    out = await _run(data, "log_foods", {"items": [
        {"name": "Olive oil", "food_id": "b:olive-oil", "amount": 1, "unit": "tbsp"},
        {"name": "Milk", "food_id": "b:milk-skim", "amount": 1, "unit": "cup"},
        {"name": "Cola", "food_id": "b:cola", "amount": 12, "unit": "floz"},
    ]})
    es = data["days"]["2026-10-31"]["entries"]
    assert es[0]["grams"] == pytest.approx(13.7, abs=0.1)  # 15 ml x 0.91 g/ml
    assert es[1]["grams"] == pytest.approx(247.2, abs=0.1) and es[2]["grams"] == pytest.approx(354.9, abs=0.1)
    assert es[0]["n"]["kcal"] == pytest.approx(builtin_foods()["b:olive-oil"]["per100"]["kcal"] * 0.1365, abs=1)
    assert len(out.result["entries"]) == 3
    with pytest.raises(ActionError, match="can't be measured in cup"):
        await _run(data, "log_foods", {"items": [{"name": "Rice", "food_id": "b:rice-white", "amount": 1, "unit": "cup"}]})
    # Changing an entry's amount keeps the spoon measure and rescales it.
    await _run(data, "edit_entry", {"entry_id": es[0]["id"], "amount": 2})
    assert data["days"]["2026-10-31"]["entries"][0]["grams"] == pytest.approx(27.3, abs=0.1)


async def test_day_summary_flags_incomplete_micros():
    data = _fresh()
    await _run(data, "log_foods", {"items": [
        {"name": "Egg", "food_id": "b:egg", "amount": 1},
        {"name": "Toast", "kcal": 150, "protein": 4, "carbs": 20, "fat": 5},
    ]})
    cov = (await _run(data, "day_summary", {})).result["micros_coverage"]
    assert cov["entries_with_micros"] == 1 and cov["entries"] == 2
    assert "Cronometer" not in SPEC.replaces and "incomplete" in SPEC.description


# ---------------------------------------------------------- fix pass: TDEE


def test_tdee_fits_the_smoothed_trend_and_ignores_a_spike():
    import random

    rng = random.Random(7)
    data = _fresh()
    data["profile"].update(sex="female", birth_year=1988, height_cm=168, weight_kg=72, activity="light")
    weights = []
    for i in range(60):
        d = (NOW.date() - timedelta(days=60 - i)).isoformat()
        data["days"][d] = {"entries": [{"id": f"e{i}", "name": "Food", "slot": "lunch", "n": {"kcal": 1800}}], "complete": True}
        weights.append((d, round(75 - 0.4 * i / 7 + rng.uniform(-0.6, 0.6), 2)))  # losing 0.4 kg/week, +-0.6 kg water noise
    # A big salty-day water spike right at the end of the window.
    weights[-1] = (weights[-1][0], weights[-1][1] + 2.0)
    data = SPEC.validate(data)
    est = science.estimate_tdee(data, weights, NOW.date(), 21)
    true = 1800 + 0.4 * 7700 / 7  # 2240
    assert est["weight_method"] == "trend"
    assert est["adaptive_tdee"] == pytest.approx(true, abs=150)
    # Raw least squares over the same window would be dragged by the spike.
    start = date.fromisoformat(est["from"])
    raw = [((date.fromisoformat(d) - start).days, kg) for d, kg in weights if est["from"] <= d <= est["to"]]
    raw_tdee = 1800 - science._slope(raw) * 7700
    assert abs(est["adaptive_tdee"] - true) < abs(raw_tdee - true)


def test_tdee_counts_only_whole_days():
    data = _fresh()
    weights = []
    for i in range(28):
        d = (NOW.date() - timedelta(days=28 - i)).isoformat()
        es = [{"id": f"e{i}{s}", "name": "Food", "slot": s, "n": {"kcal": k}} for s, k in (("breakfast", 500), ("lunch", 800), ("dinner", 1000), ("snacks", 200))]
        data["days"][d] = {"entries": es, "complete": i % 4 == 0}  # only some marked complete
        if i % 2 == 0:
            weights.append((d, 80.0))
    d1 = (NOW.date() - timedelta(days=3)).isoformat()  # breakfast + lunch only: 1300 = 52 % of a typical 2500
    data["days"][d1] = {"entries": data["days"][d1]["entries"][:2]}
    d2 = (NOW.date() - timedelta(days=4)).isoformat()  # all three mains, a light day: 1600 = 64 %
    data["days"][d2] = {"entries": [{**e, "n": {"kcal": k}} for e, k in zip(data["days"][d2]["entries"][:3], (400, 500, 700))]}
    d3 = (NOW.date() - timedelta(days=5)).isoformat()  # dinner forgotten but a big lunch: 2100 = 84 %
    data["days"][d3] = {"entries": [{**e, "n": {"kcal": k}} for e, k in zip(data["days"][d3]["entries"][:2], (600, 1500))]}
    data = SPEC.validate(data)
    est = science.estimate_tdee(data, weights, NOW.date(), 21)
    assert est["typical_day_kcal"] == 2500 and est["partial_days_skipped"] == 1 and est["logged_days"] == 20


# ------------------------------------------------- fix pass: Open Food Facts


def test_barcode_check_digits():
    assert off.valid_gtin("9300633603557") and off.valid_gtin("0000000000017") and off.valid_gtin("96385074")
    assert not off.valid_gtin("9300633603551") and not off.valid_gtin("12345")
    with pytest.raises(ValueError, match="8, 12, 13 or 14 digits.*has 5"):
        off.clean_barcode("12345")
    with pytest.raises(ValueError, match="check"):
        off.clean_barcode("9300633603551")
    assert off.clean_barcode("9 300633 603557") == "9300633603557"


async def test_off_rate_limit_and_failure_memory(mock_off, monkeypatch):
    # Failures are remembered briefly: a second try doesn't hit OFF again.
    with pytest.raises(off.OffUnavailable):
        await off.lookup_barcode("4000000000006")
    n = len(mock_off)
    with pytest.raises(off.OffUnavailable):
        await off.lookup_barcode("4000000000006")
    assert len(mock_off) == n
    # Sliding window per user.
    for _ in range(off.RATE_LIMITS["search"][0]):
        off.check_rate("u1", "search")
    with pytest.raises(off.RateLimited) as e:
        off.check_rate("u1", "search")
    assert 0 < e.value.retry_after <= 60
    off.check_rate("u2", "search")  # someone else isn't affected
    off.check_rate("u1", "barcode")  # barcodes have their own, more generous budget
    t = off.time.monotonic()
    monkeypatch.setattr(off.time, "monotonic", lambda: t + 61)
    off.check_rate("u1", "search")  # the window slid


async def test_off_endpoints_rate_limit_per_user(client, db, user, mock_off):
    h = _auth(user)
    for i in range(off.RATE_LIMITS["search"][0]):
        assert (await client.get("/api/items/k/meals/off/search", headers=h, params={"q": f"peanut {i}"})).status_code == 200
    r = await client.get("/api/items/k/meals/off/search", headers=h, params={"q": "peanut more"})
    assert r.status_code == 429 and r.headers["Retry-After"] and "lookups" in r.json()["detail"]
    # Cached answers are free.
    assert (await client.get("/api/items/k/meals/off/search", headers=h, params={"q": "peanut 0"})).status_code == 200
    r = await client.get("/api/items/k/meals/off/barcode/9300633603551", headers=h)
    assert r.status_code == 400 and "check" in r.json()["detail"]


async def test_archive_through_the_api(client, db, user):
    h = _auth(user)
    await client.post("/api/items/store/meals", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "meals", "title": "Food"})).json()["file_id"]
    for d in ("2026-01-02", "2026-10-01"):
        r = await client.post(f"/api/items/{fid}/actions/log_foods", headers=h, json={"args": {"date": d, "items": [{"name": "Apple", "food_id": "b:apple", "amount": 1}]}})
        assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/archive", headers=h, json={"before": "2026-06-01"})
    assert r.status_code == 200, r.text
    assert list(r.json()["data"]["days"]) == ["2026-10-01"]
    arch = (await client.get(f"/api/items/{r.json()['archive_id']}", headers=h)).json()
    assert list(arch["data"]["days"]) == ["2026-01-02"]
