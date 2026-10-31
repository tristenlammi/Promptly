"""Meal Planner item (app/items/kinds/mealplan): parsers, units, grocery
merge, every action, reminders, text, the import endpoint and an API flow."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.items.kinds.mealplan import SPEC, foods, grocery, parse, units
from app.items.kinds.mealplan import actions as A
from app.items.kinds.mealplan.models import MealPlanData
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 11, 4, 10, 0, tzinfo=TZ)  # a Wednesday


def ctx(now: datetime = NOW, read_item=None) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ, read_item=read_item)  # type: ignore[arg-type]


def blank() -> dict:
    return SPEC.validate(SPEC.template(ctx()))


async def run(data: dict, name: str, args: dict, c: ItemContext | None = None):
    from app.items.service import run_action

    out = await run_action(c or ctx(), SPEC, data, name, args)
    SPEC.validate(data)  # every write leaves a valid file
    return out


# ------------------------------------------------------------ ingredients


@pytest.mark.parametrize(
    "line, qty, qty_max, unit, item, note",
    [
        ("1 ½ cups (200 g) plain flour, sifted", 1.5, None, "cup", "plain flour", "200 g, sifted"),
        ("1½ lb chicken thighs", 1.5, None, "lb", "chicken thighs", ""),
        ("1 1/2 teaspoons baking soda", 1.5, None, "tsp", "baking soda", ""),
        ("¾ cup milk", 0.75, None, "cup", "milk", ""),
        ("1-2 tbsp olive oil", 1, 2, "tbsp", "olive oil", ""),
        ("2 to 3 cups vegetable stock", 2, 3, "cup", "vegetable stock", ""),
        ("2 x 400g tins chopped tomatoes", 2, None, "can", "chopped tomatoes", "400 g can"),
        ("1 (14 oz) can black beans, drained and rinsed", 1, None, "can", "black beans", "14 oz can, drained and rinsed"),
        ("400g chickpeas", 400, None, "g", "chickpeas", ""),
        ("250ml whole milk", 250, None, "ml", "whole milk", ""),
        ("3 garlic cloves, minced", 3, None, "clove", "garlic", "minced"),
        ("2 cloves garlic", 2, None, "clove", "garlic", ""),
        ("a pinch of salt", 1, None, "pinch", "salt", ""),
        ("1 T sugar", 1, None, "tbsp", "sugar", ""),
        ("1 t salt", 1, None, "tsp", "salt", ""),
        ("6 oz. cheddar, grated", 6, None, "oz", "cheddar", "grated"),
        ("two onions", 2, None, "", "onions", ""),
        ("half a cup of rice", 0.5, None, "cup", "rice", ""),
        ("salt and pepper, to taste", None, None, "", "salt and pepper", "to taste"),
        ("4 boneless, skinless chicken breasts, cut into strips", 4, None, "", "boneless skinless chicken breasts", "cut into strips"),
        ("Juice of 1 lemon", 1, None, "", "lemon", "juice"),
        ("3 medium carrots - peeled", 3, None, "", "medium carrots", "peeled"),
        ("• 2 tablespoons butter, melted", 2, None, "tbsp", "butter", "melted"),
        ("1 kg potatoes", 1, None, "kg", "potatoes", ""),
        ("100 g feta (crumbled)", 100, None, "g", "feta", "crumbled"),
        ("2 eggs", 2, None, "", "eggs", ""),
    ],
)
def test_ingredient_lines_parse(line, qty, qty_max, unit, item, note):
    p = parse.parse_ingredient(line)
    assert p["qty"] == (pytest.approx(qty) if qty is not None else None)
    assert p["qty_max"] == (pytest.approx(qty_max) if qty_max is not None else None)
    assert (p["unit"], p["item"], p["note"]) == (unit, item, note)


def test_optional_groups_and_unicode_fractions():
    lines = ["For the sauce:", "1/4 cup soy sauce", "1 tsp chilli flakes (optional)", "", "Topping:", "⅓ cup sesame seeds"]
    out = parse.parse_ingredient_lines(lines)
    assert [i["group"] for i in out] == ["For the sauce", "For the sauce", "Topping"]
    assert out[1]["optional"] is True and out[1]["item"] == "chilli flakes"
    assert out[2]["qty"] == pytest.approx(1 / 3, abs=1e-3)
    assert out[0]["aisle"] == "condiments" and out[2]["aisle"] == "spices"
    assert parse.parse_ingredient("") ["item"] == ""
    assert parse.parse_ingredient("<b>2 cups</b> rice &amp; beans")["item"] == "rice & beans"


@pytest.mark.parametrize(
    "value, minutes",
    [("PT1H30M", 90), ("P0DT0H20M", 20), ("PT90M", 90), ("PT0.5H", 30), ("PT20M0S", 20), ("P1D", 1440),
     ("1 hour 15 mins", 75), ("45 minutes", 45), (25, 25), ("", None), (None, None), ("soon", None)],
)
def test_durations(value, minutes):
    assert parse.parse_duration(value) == minutes


# ------------------------------------------------------------------ units


def test_units_scale_and_convert():
    # Rounds to kitchen fractions; upgrades spoons to cups.
    assert units.present(1.5 * 3, "tsp") == (1.5, "tbsp")
    assert units.present(12, "tbsp") == (0.75, "cup")
    assert units.present(0.125, "cup") == (2.0, "tbsp")
    assert units.present(1250, "g") == (1.25, "kg")
    assert units.present(137, "g") == (135, "g")
    assert units.present(2, "cup", "metric") == (470, "ml")
    assert units.present(500, "g", "imperial") == (1.0, "lb")
    assert units.present(200, "g", "imperial") == (7.0, "oz")
    assert units.present(1, "tbsp", "metric") == (1.0, "tbsp")  # spoons stay spoons
    assert units.present(2.4, "", "keep", "eggs") == (2.0, "")
    assert units.present(1.45, "", "keep", "onion") == (1.5, "")
    assert units.fmt_qty(1.5, "cup") == "1 ½ cups"
    assert units.fmt_qty(0.333, "tsp") == "⅓ tsp"
    assert units.fmt_qty(250, "g") == "250 g"
    assert units.fmt_qty(1, "tbsp", 2) == "1–2 tbsp"
    assert units.unit_key("Tablespoons") == "tbsp" and units.unit_key("T") == "tbsp" and units.unit_key("t") == "tsp"
    assert units.unit_key("fl oz") == "floz" and units.unit_key("tins") == "can"
    s = units.scale_line({"qty": 1, "qty_max": 2, "unit": "tbsp", "item": "oil"}, 3)
    assert (s["qty"], s["qty_max"], s["unit"]) == (3.0, 6.0, "tbsp")
    s = units.scale_line({"qty": 2, "qty_max": 3, "unit": "tbsp", "item": "oil"}, 4)
    assert s["unit"] == "cup" and s["qty"] == 0.5 and s["qty_max"] == 0.75
    assert units.ingredient_text({"qty": 2, "unit": "clove", "item": "garlic", "note": "minced", "optional": True}) == "2 cloves garlic, minced (optional)"


def test_names_aisles_allergens_diets():
    assert foods.ingredient_key("2 Large Onions, diced") == "onion"
    assert foods.ingredient_key("fresh basil leaves") == "basil leaf"
    assert foods.ingredient_key("cherry tomatoes") == "cherry tomato"
    assert foods.aisle_for("chicken stock") == "pantry"
    assert foods.aisle_for("coconut milk") == "canned"
    assert foods.aisle_for("frozen peas") == "frozen"
    assert foods.aisle_for("dried oregano") == "spices"
    assert foods.aisle_for("eggplant") == "produce"
    assert foods.aisle_for("unsalted butter") == "dairy"
    assert foods.aisle_for("salmon fillets") == "seafood"
    assert foods.aisle_for("sourdough bread") == "bakery"
    assert foods.aisle_for("zzz") == "other"
    assert foods.allergy_hits(["coconut milk", "butter", "peanut butter", "almond milk"], "dairy") == ["butter"]
    assert foods.allergy_hits(["eggplant", "2 eggs"], "eggs") == ["2 eggs"]
    assert foods.allergy_hits(["nutmeg", "walnuts", "butternut squash"], "tree nuts") == ["walnuts"]
    assert foods.allergy_hits(["soy sauce", "tamari"], "gluten") == ["soy sauce"]
    assert foods.allergy_hits(["gluten-free spaghetti"], "gluten") == []
    assert foods.allergy_hits(["prawns", "salmon"], "seafood") == ["prawns", "salmon"]
    assert foods.allergy_hits(["coriander"], "coriander") == ["coriander"]  # unknown → literal
    assert foods.diet_conflicts(["chicken thighs", "vegetable stock", "honey", "tofu"], "vegan") == ["chicken thighs", "honey"]
    assert foods.diet_conflicts(["salmon", "rice"], "pescatarian") == []
    assert foods.diet_conflicts(["salmon"], "vegetarian") == ["salmon"]
    assert foods.diet_conflicts(["bacon", "white wine"], "halal") == ["bacon", "white wine"]
    assert foods.diet_conflicts(["beef", "cheddar"], "kosher") == ["meat with dairy (beef + cheddar)"]
    assert foods.diet_conflicts(["rice", "cauliflower rice"], "keto") == ["rice"]


# ---------------------------------------------------------------- JSON-LD

ALLRECIPES_LIKE = """<html><head><title>Best Chili</title>
<script type="application/ld+json">
[{"@context":"http://schema.org","@type":["Recipe"],"name":"Best Chili &amp; Cornbread",
 "image":{"@type":"ImageObject","url":"https://img.example.com/chili.jpg"},
 "recipeYield":["6","6 servings"],"prepTime":"PT15M","cookTime":"PT1H","totalTime":"PT1H15M",
 "recipeCategory":"Dinner","recipeCuisine":["Mexican"],"keywords":"chili, beef, Batch Cooking",
 "recipeIngredient":["1 pound ground beef","1 (15 ounce) can kidney beans, drained","2 tablespoons chili powder","1 onion, chopped"],
 "recipeInstructions":[{"@type":"HowToStep","text":"Brown the beef in a large pot."},{"@type":"HowToStep","text":"Add everything else and simmer 1 hour."}],
 "nutrition":{"@type":"NutritionInformation","calories":"412 kcal","proteinContent":"28 g","fatContent":"18 g","sodiumContent":"890 mg"}}]
</script></head><body></body></html>"""

YOAST_GRAPH = """<script type="application/ld+json" class="yoast-schema-graph">{"@context":"https://schema.org","@graph":[
 {"@type":"WebPage","@id":"https://blog.example.com/dal/"},
 {"@type":"Article","headline":"My dal"},
 {"@type":"Recipe","name":"Weeknight Dal","recipeYield":"4","totalTime":"P0DT0H35M",
  "recipeIngredient":["250 g red lentils","1 tsp turmeric","400 ml coconut milk"],
  "recipeInstructions":[{"@type":"HowToSection","name":"Dal","itemListElement":[{"@type":"HowToStep","text":"Rinse the lentils."},{"@type":"HowToStep","text":"Simmer 20 minutes."}]},
   {"@type":"HowToSection","name":"To serve","itemListElement":[{"@type":"HowToStep","text":"Top with coriander."}]}],
  "image":["https://blog.example.com/dal.jpg","https://blog.example.com/dal-2.jpg"]}]}</script>"""

STRING_STEPS = """<script type='application/ld+json'>{"@type":"Recipe","name":"Pancakes","recipeYield":"Makes 12 pancakes",
"recipeIngredient":["2 cups flour","2 eggs",],"recipeInstructions":"1. Whisk everything. 2. Fry spoonfuls for 2 minutes a side."}</script>"""

NO_RECIPE = """<html><head><meta property="og:title" content="About us"><script type="application/ld+json">{"@type":"Organization","name":"X"}</script></head></html>"""


def test_jsonld_list_and_types():
    r = parse.recipe_from_html(ALLRECIPES_LIKE, "https://www.example.com/chili")
    assert r["title"] == "Best Chili & Cornbread" and r["servings"] == 6
    assert (r["prep_min"], r["cook_min"], r["total_min"]) == (15, 60, 75)
    assert r["cuisine"] == "Mexican" and r["tags"] == ["dinner", "chili", "beef", "batch cooking"]
    assert r["image_url"] == "https://img.example.com/chili.jpg"
    assert r["steps"] == ["Brown the beef in a large pot.", "Add everything else and simmer 1 hour."]
    beans = r["ingredients"][1]
    assert (beans["qty"], beans["unit"], beans["item"]) == (1, "can", "kidney beans") and "15 oz" in beans["note"]
    assert r["ingredients"][0]["unit"] == "lb" and r["ingredients"][0]["aisle"] == "meat"
    assert r["nutrition"] == {"calories": 412, "protein_g": 28.0, "fat_g": 18.0, "sodium_mg": 890}
    assert r["source_url"] == "https://www.example.com/chili"


def test_jsonld_graph_and_sections():
    r = parse.recipe_from_html(YOAST_GRAPH, "https://blog.example.com/dal/")
    assert r["title"] == "Weeknight Dal" and r["total_min"] == 35 and r["servings"] == 4
    assert r["steps"] == ["Dal: Rinse the lentils.", "Simmer 20 minutes.", "To serve: Top with coriander."]
    assert r["image_url"] == "https://blog.example.com/dal.jpg"


def test_jsonld_string_steps_and_trailing_commas():
    r = parse.recipe_from_html(STRING_STEPS)
    assert r["title"] == "Pancakes" and r["servings"] == 12 and "Makes 12 pancakes" in r["notes"]
    assert r["steps"] == ["Whisk everything.", "Fry spoonfuls for 2 minutes a side."]
    assert len(r["ingredients"]) == 2


def test_no_recipe_on_page():
    assert parse.recipe_from_html(NO_RECIPE) is None
    assert parse.page_title(NO_RECIPE) == "About us"


def test_pasted_text():
    text = """Grandma's Banana Bread
Serves 8
Prep time: 15 mins
Cook time: 1 hour

Ingredients
3 ripe bananas, mashed
1/3 cup melted butter
3/4 cup sugar
1 1/2 cups flour

Method
1. Heat the oven to 175°C.
2. Mix everything and pour into a loaf tin.
3. Bake 60 minutes until a skewer comes out clean.

Notes
Freezes well. https://example.com/banana
"""
    r = parse.recipe_from_text(text)
    assert r["title"] == "Grandma's Banana Bread" and r["servings"] == 8
    assert (r["prep_min"], r["cook_min"], r["total_min"]) == (15, 60, 75)
    assert [i["item"] for i in r["ingredients"]] == ["ripe bananas", "melted butter", "sugar", "flour"]
    assert len(r["steps"]) == 3 and r["steps"][0] == "Heat the oven to 175°C."
    assert "Freezes well" in r["notes"] and r["source_url"] == "https://example.com/banana"
    # No headings: amounts → ingredients, sentences → steps.
    r = parse.recipe_from_text("Quick salad\n2 tomatoes\n1 cucumber\nChop everything and toss with olive oil and salt.")
    assert [i["item"] for i in r["ingredients"]] == ["tomatoes", "cucumber"] and len(r["steps"]) == 1


# ----------------------------------------------------------- model + text


def test_model_template_and_validation():
    d = blank()
    assert d["preferences"]["slots"] == ["dinner"] and d["preferences"]["household_size"] == 2
    assert d["preferences"]["aisle_order"][0] == "produce" and d["recipes"] == []
    MealPlanData.model_validate({"preferences": {"diets": ["Vegan", "vegan", " keto "], "slots": ["dinner", "breakfast"]}})
    clean = SPEC.validate({"preferences": {"diets": ["Vegan", "vegan"], "slots": ["dinner", "breakfast"], "aisle_order": ["dairy", "nope"]}})
    assert clean["preferences"]["diets"] == ["Vegan"] and clean["preferences"]["slots"] == ["breakfast", "dinner"]
    assert clean["preferences"]["aisle_order"][0] == "dairy" and len(clean["preferences"]["aisle_order"]) == len(foods.AISLE_ORDER)
    with pytest.raises(Exception):
        SPEC.validate({"plan": [{"id": "x", "date": "2026-13-40", "slot": "dinner"}]})
    with pytest.raises(Exception):
        SPEC.validate({"recipes": [{"id": "r", "title": "x", "servings": 0}]})
    ing = SPEC.validate({"recipes": [{"id": "r", "ingredients": [{"item": "x", "unit": "Tablespoons", "aisle": "weird"}]}]})
    assert ing["recipes"][0]["ingredients"][0]["unit"] == "tbsp" and ing["recipes"][0]["ingredients"][0]["aisle"] == "other"


async def test_to_text_has_the_facts():
    d = blank()
    await run(d, "add_starter_recipes", {})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "slot": "dinner", "recipe_id": "red-lentil-spinach-dal"}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    t = SPEC.to_text(d)
    assert "Red lentil & spinach dal" in t and "2026-11-05" in t and "Grocery list" in t and "red lentils" in t and "Red lentil 125 g" in t
    assert len(t) <= 20_000


# --------------------------------------------------------------- actions


async def test_recipes_add_edit_scale_delete():
    d = blank()
    out = await run(d, "add_recipes", {"recipes": [
        {"title": "Garlic Pasta", "servings": 2, "ingredient_lines": ["200 g spaghetti", "3 cloves garlic, sliced", "3 tbsp olive oil"],
         "steps": ["Boil pasta 10 minutes.", "Fry garlic in oil."], "prep_min": 5, "cook_min": 12},
        {"title": "Garlic Pasta", "ingredients": [{"qty": 1, "unit": "cup", "item": "rice"}], "steps": ["Cook."]},
    ]})
    ids = [a["id"] for a in out.result["added"]]
    assert ids == ["garlic-pasta", "garlic-pasta-2"]
    r = d["recipes"][0]
    assert r["total_min"] == 17 and r["ingredients"][1]["unit"] == "clove" and r["ingredients"][0]["id"] == "i1"
    assert r["added"] == "2026-11-04"
    with pytest.raises(ActionError):
        await run(d, "add_recipes", {"recipes": [{"title": "Empty"}]})

    sc = await run(d, "scale_recipe", {"recipe_id": "garlic-pasta", "servings": 6})
    assert sc.result["factor"] == 3 and sc.result["ingredients"][0] == "600 g spaghetti"
    assert sc.result["ingredients"][2] == "½ cup olive oil"
    sc = await run(d, "scale_recipe", {"recipe_id": "Garlic Pasta", "factor": 1, "units": "imperial"})
    assert sc.result["ingredients"][0] == "7 oz spaghetti"

    await run(d, "edit_recipe", {"recipe_id": "garlic-pasta", "title": "Aglio e olio", "ingredient_lines": ["200 g spaghetti"], "rating": 5})
    assert d["recipes"][0]["title"] == "Aglio e olio" and len(d["recipes"][0]["ingredients"]) == 1
    with pytest.raises(ActionError):
        await run(d, "edit_recipe", {"recipe_id": "garlic-pasta"})
    with pytest.raises(ActionError):
        await run(d, "edit_recipe", {"recipe_id": "nope", "title": "x"})

    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "garlic-pasta"}]})
    await run(d, "delete_recipes", {"recipe_ids": ["garlic-pasta"]})
    assert [r["id"] for r in d["recipes"]] == ["garlic-pasta-2"]
    assert d["plan"][0]["recipe_id"] is None and d["plan"][0]["title"] == "Aglio e olio"
    with pytest.raises(ActionError):
        await run(d, "delete_recipes", {"recipe_ids": ["nope"]})


async def test_plan_meals_week_leftovers_allergens_and_clear():
    d = blank()
    await run(d, "add_starter_recipes", {})
    with pytest.raises(ActionError):
        await run(d, "add_starter_recipes", {})
    week = [
        {"date": "2026-11-02", "recipe_id": "red-lentil-spinach-dal", "servings": 2},
        {"date": "2026-11-03", "leftovers_of_date": "2026-11-02"},
        {"date": "2026-11-04", "title": "Takeaway"},
        {"date": "2026-11-05", "slot": "breakfast", "recipe_id": "berry-overnight-oats"},
    ]
    out = await run(d, "plan_meals", {"meals": week})
    assert len(out.result["planned"]) == 4 and out.summary.startswith("Planned 4 meals")
    left = next(e for e in d["plan"] if e["date"] == "2026-11-03")
    cook = next(e for e in d["plan"] if e["date"] == "2026-11-02")
    assert left["leftovers_of"] == cook["id"] and left["recipe_id"] == "red-lentil-spinach-dal"
    # replace=True swaps what's in that slot; ids stay deterministic
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-04", "recipe_id": "beef-broccoli-stir-fry"}]})
    assert [e["title"] for e in d["plan"] if e["date"] == "2026-11-04"] == ["Beef & broccoli stir-fry"]
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-06", "recipe_id": "no-such"}]})
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-06", "leftovers_of_date": "2026-11-20"}]})
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-06"}]})
    # Allergens are refused; diet clashes come back as warnings.
    d["preferences"]["allergies"] = ["fish"]
    d["preferences"]["diets"] = ["vegetarian"]
    with pytest.raises(ActionError) as e:
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-07", "recipe_id": "lemon-garlic-salmon-with-green-beans"}]})
    assert "allergen" in str(e.value)
    out = await run(d, "plan_meals", {"meals": [{"date": "2026-11-07", "recipe_id": "sheet-pan-chicken-fajitas"}]})
    assert "Sheet-pan chicken fajitas" in out.result["preference_warnings"]
    # clear
    out = await run(d, "clear_plan", {"start": "2026-11-02", "end": "2026-11-02"})
    assert out.result["removed"] == 1 and left["leftovers_of"] is None
    with pytest.raises(ActionError):
        await run(d, "clear_plan", {"start": "2026-12-01", "end": "2026-12-02"})


async def test_grocery_merges_sums_subtracts_pantry_and_groups():
    d = blank()
    d["preferences"]["household_size"] = 4
    await run(d, "add_recipes", {"recipes": [
        {"title": "Tacos", "servings": 4, "ingredient_lines": ["500 g ground beef", "1 onion, diced", "2 tbsp olive oil", "1 tsp salt", "8 tortillas", "1 cup grated cheddar", "fresh coriander (optional)", "water"], "steps": ["Cook."]},
        {"title": "Chili", "servings": 4, "ingredient_lines": ["1 lb ground beef", "2 onions, chopped", "1 tbsp olive oil", "1 can kidney beans", "2 cans kidney beans", "250 ml water"], "steps": ["Simmer."]},
        {"title": "Soup", "servings": 2, "ingredient_lines": ["1 large onion", "2 cloves garlic", "1 head garlic"], "steps": ["Simmer."]},
    ]})
    await run(d, "set_pantry", {"add": [{"name": "salt"}, {"name": "extra virgin olive oil"}, {"name": "cheddar cheese", "qty": 50, "unit": "g", "staple": False}]})
    await run(d, "plan_meals", {"meals": [
        {"date": "2026-11-05", "recipe_id": "tacos"},
        {"date": "2026-11-06", "recipe_id": "chili", "servings": 8},
        {"date": "2026-11-07", "recipe_id": "soup"},  # 4 servings = ×2
        {"date": "2026-11-08", "leftovers_of_date": "2026-11-07", "servings": 2},  # cook ×3
    ]})
    await run(d, "add_grocery_items", {"lines": ["paper towels", "2 lb ground beef"]})
    out = await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-08"})
    items = {i["key"]: i for i in d["grocery"]["items"]}
    # beef: 500 g + 2 lb (907 g) from the plan + the manual 2 lb merged in
    assert items["ground beef"]["amounts"] == [{"qty": 2.3, "unit": "kg"}]
    assert items["ground beef"]["recipes"] == ["Tacos", "Chili"]
    # onions: 1 + 4 + 3 = 8 → whole count, pluralised
    assert items["onion"]["amounts"] == [{"qty": 8.0, "unit": ""}] and items["onion"]["name"] == "Onions"
    # garlic: cloves and heads stay separate amounts on one row
    assert items["garlic"]["amounts"] == [{"qty": 6.0, "unit": "clove"}, {"qty": 3.0, "unit": "head"}]
    assert items["kidney bean"]["amounts"] == [{"qty": 6.0, "unit": "can"}]
    # pantry staples and water are skipped; optional skipped by default
    assert "salt" not in items and "olive oil" not in items and "water" not in items and "coriander" not in items
    assert set(d["grocery"]["covered"]) >= {"Salt", "Olive oil"}
    # cheddar: 1 cup is volume — the pantry's grams can't subtract from it (and its key differs)
    assert items["cheddar"]["aisle"] == "dairy" and items["cheddar"]["amounts"] == [{"qty": 235.0, "unit": "ml"}]
    assert items["paper towel"]["source"] == "manual" and items["paper towel"]["aisle"] == "household"
    assert out.result["recipes"] == 3 and "Meat & poultry" in out.result["by_aisle"]
    # regenerating keeps checks
    await run(d, "check_grocery_items", {"items": ["Onions"]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-08"})
    assert next(i for i in d["grocery"]["items"] if i["key"] == "onion")["checked"] is True
    with pytest.raises(ActionError):
        await run(d, "generate_grocery_list", {"start": "2026-12-01", "end": "2026-12-07"})
    with pytest.raises(ActionError):
        await run(d, "generate_grocery_list", {"start": "2026-11-08", "end": "2026-11-01"})


async def test_pantry_quantity_subtracts():
    d = blank()
    await run(d, "add_recipes", {"recipes": [{"title": "Rice bowl", "servings": 2, "ingredient_lines": ["300 g rice", "2 eggs"], "steps": ["Cook."]}]})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "rice-bowl"}]})
    await run(d, "set_pantry", {"add": [{"name": "rice", "qty": 100, "unit": "g", "staple": False}, {"name": "eggs", "qty": 6}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    items = {i["key"]: i for i in d["grocery"]["items"]}
    assert items["rice"]["amounts"] == [{"qty": 200.0, "unit": "g"}]
    assert "egg" not in items
    await run(d, "set_pantry", {"remove": ["eggs"]})
    assert [p["name"] for p in d["pantry"]] == ["rice"]
    with pytest.raises(ActionError):
        await run(d, "set_pantry", {})


async def test_grocery_add_check_remove():
    d = blank()
    out = await run(d, "add_grocery_items", {"lines": ["2 lb chicken thighs", "milk"], "items": [{"name": "Milk", "qty": 1, "unit": "l"}]})
    assert out.result["added"] == ["Chicken thighs", "Milk"] and out.result["merged_into_existing"] == ["Milk"]
    milk = next(i for i in d["grocery"]["items"] if i["key"] == "milk")
    assert milk["amounts"] == [{"qty": 1.0, "unit": "l"}] and milk["aisle"] == "dairy"
    await run(d, "add_grocery_items", {"lines": ["500 ml milk"]})
    assert milk["amounts"] == [{"qty": 1.5, "unit": "l"}]
    await run(d, "check_grocery_items", {"items": ["milk"]})
    assert milk["checked"]
    with pytest.raises(ActionError):
        await run(d, "check_grocery_items", {"items": ["caviar"]})
    with pytest.raises(ActionError):
        await run(d, "add_grocery_items", {"lines": ["  "]})
    out = await run(d, "remove_grocery_items", {"checked": True})
    assert out.result["removed"] == 1 and len(d["grocery"]["items"]) == 1
    await run(d, "remove_grocery_items", {"everything": True})
    assert d["grocery"]["items"] == []
    with pytest.raises(ActionError):
        await run(d, "remove_grocery_items", {"items": ["x"]})


async def test_preferences_and_mark_cooked():
    d = blank()
    out = await run(d, "set_preferences", {"household_size": 3, "allergies": ["Peanuts"], "slots": ["lunch", "dinner"], "units": "imperial"})
    assert d["preferences"]["household_size"] == 3 and d["preferences"]["onboarded"] is True
    assert out.result["changed"] == ["allergies", "household_size", "slots", "units"]
    with pytest.raises(ActionError):
        await run(d, "set_preferences", {})
    await run(d, "add_starter_recipes", {})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-04", "recipe_id": "beef-broccoli-stir-fry"}]})
    out = await run(d, "mark_cooked", {"rating": 4})
    r = next(x for x in d["recipes"] if x["id"] == "beef-broccoli-stir-fry")
    assert r["times_cooked"] == 1 and r["rating"] == 4 and r["last_cooked"] == "2026-11-04" and d["plan"][0]["cooked"]
    await run(d, "mark_cooked", {})  # already cooked: no double count
    assert r["times_cooked"] == 1
    await run(d, "mark_cooked", {"cooked": False})
    assert r["times_cooked"] == 0 and not d["plan"][0]["cooked"]
    await run(d, "mark_cooked", {"recipe_id": "berry-overnight-oats", "date": "2026-11-01"})
    assert next(x for x in d["recipes"] if x["id"] == "berry-overnight-oats")["times_cooked"] == 1
    with pytest.raises(ActionError):
        await run(d, "mark_cooked", {"date": "2026-10-01"})


async def test_read_only_analysis():
    d = blank()
    await run(d, "add_starter_recipes", {})
    d["preferences"]["calories_per_day"] = 2000
    d["preferences"]["weeknight_minutes"] = 30
    out = await run(d, "what_can_i_make", {"ingredients": ["salmon", "green beans", "garlic", "lemon", "parsley"], "max_missing": 0})
    assert [r["id"] for r in out.result["recipes"]] == ["lemon-garlic-salmon-with-green-beans"]
    out = await run(d, "what_can_i_make", {"ingredients": ["rolled oats", "milk", "greek yogurt"], "max_missing": 3})
    assert out.result["recipes"][0]["id"] == "berry-overnight-oats"
    assert out.result["recipes"][0]["missing"] == ["chia seed", "maple syrup", "mixed berry"]

    await run(d, "plan_meals", {"meals": [
        {"date": "2026-11-02", "recipe_id": "red-lentil-spinach-dal"},
        {"date": "2026-11-03", "recipe_id": "red-lentil-spinach-dal"},
        {"date": "2026-11-04", "recipe_id": "sheet-pan-chicken-fajitas"},
    ]})

    async def read_item(kind):
        assert kind == "meals"
        return (uuid.uuid4(), "Macros", {"settings": {"targets": {"calories": 2200, "protein_g": 150}}})

    out = await run(d, "plan_summary", {}, ctx(read_item=read_item))
    res = out.result
    assert (res["start"], res["end"]) == ("2026-11-02", "2026-11-08")  # Monday week
    assert res["planned_meals"] == 3 and res["empty_slots"] == 4
    assert res["repeats"] == {"Red lentil & spinach dal": 2}
    assert res["daily_targets"] == {"calories": 2000, "protein_g": 150}
    assert any("Sheet-pan chicken fajitas" in x for x in res["over_time_limit"])
    assert res["days"][0]["per_person_from_recipes"]["calories"] == 610

    out = await run(d, "recipe_nutrition", {"recipe_id": "red-lentil-spinach-dal", "servings": 2})
    assert out.result["total"]["calories"] == 1220 and out.result["percent_of_daily_target_per_serving"]["calories"] in (30, 31)
    assert sum(out.result["calorie_split_percent"].values()) in (99, 100, 101)
    await run(d, "edit_recipe", {"recipe_id": "red-lentil-spinach-dal", "nutrition": {}})
    out = await run(d, "recipe_nutrition", {"recipe_id": "red-lentil-spinach-dal"})
    assert out.result["nutrition"] is None and out.result["ingredients_per_serving"]


async def test_import_recipe_url_action(monkeypatch):
    from app.items.kinds.mealplan import web

    async def fake_page(url):
        return ALLRECIPES_LIKE

    monkeypatch.setattr(web, "fetch_page", fake_page)
    d = blank()
    out = await run(d, "import_recipe_url", {"url": "https://www.example.com/chili", "tags": ["Family"]})
    r = d["recipes"][0]
    assert r["id"] == "best-chili-cornbread" and r["source_url"] == "https://www.example.com/chili"
    assert "family" in r["tags"] and r["ingredients"][0]["id"] == "i1"
    again = await run(d, "import_recipe_url", {"url": "https://www.example.com/chili"})
    assert again.result["already_saved"] and len(d["recipes"]) == 1

    async def bad_page(url):
        return NO_RECIPE

    monkeypatch.setattr(web, "fetch_page", bad_page)
    with pytest.raises(ActionError) as e:
        await run(d, "import_recipe_url", {"url": "https://www.example.com/about"})
    assert "About us" in str(e.value)


async def test_actions_are_deterministic():
    a, b = blank(), blank()
    for d in (a, b):
        await run(d, "add_starter_recipes", {})
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "red-lentil-spinach-dal"}]})
        await run(d, "add_grocery_items", {"lines": ["bread"]})
        await run(d, "generate_grocery_list", {})
    assert a == b


# ---------------------------------------------------------------- reminders


def test_reminders():
    d = blank()
    d["recipes"] = [
        {"id": "f", "title": "Fajitas", "prep_ahead": "Thaw the chicken.", "steps": ["x"]},
        {"id": "o", "title": "Oats", "prep_ahead": "Soak the oats.", "steps": ["x"]},
        {"id": "s", "title": "Salad", "steps": ["x"]},
    ]
    d["plan"] = [
        {"id": "1", "date": "2026-11-05", "slot": "dinner", "recipe_id": "f"},
        {"id": "2", "date": "2026-11-05", "slot": "breakfast", "recipe_id": "o"},
        {"id": "3", "date": "2026-11-06", "slot": "dinner", "recipe_id": "s"},
        {"id": "4", "date": "2026-11-04", "slot": "dinner", "recipe_id": "f"},  # today: too late
        {"id": "5", "date": "2026-11-07", "slot": "dinner", "recipe_id": "f", "cooked": True},
    ]
    d["preferences"].update(shopping_reminder=True, shopping_day=6, shopping_time="08:30")
    d["grocery"]["items"] = [{"id": "g", "name": "Milk", "key": "milk"}]
    d = SPEC.validate(d)
    rs = SPEC.reminders(d, ctx())
    keys = {r.key: r for r in rs}
    assert set(keys) == {"prep:2026-11-05", "shop:2026-11-07"}
    prep = keys["prep:2026-11-05"]
    assert prep.due_at == datetime(2026, 11, 4, 19, 0, tzinfo=TZ) and "Fajitas" in prep.title and "Soak" in prep.body
    assert keys["shop:2026-11-07"].due_at == datetime(2026, 11, 7, 8, 30, tzinfo=TZ) and "1 item" in keys["shop:2026-11-07"].body
    d["preferences"]["prep_reminders"] = False
    d["preferences"]["shopping_reminder"] = False
    assert SPEC.reminders(d, ctx()) == []
    # After 19:00 the evening before, that reminder is gone.
    d["preferences"]["prep_reminders"] = True
    assert SPEC.reminders(d, ctx(datetime(2026, 11, 4, 20, 0, tzinfo=TZ))) == []


# ---------------------------------------------------------------- tools


def test_tools_have_no_refs_and_include_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names
    assert {"web_search", "fetch_page", "read_other_item"} <= names
    assert "$ref" not in json.dumps(tools)
    read_only = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert {"scale_recipe", "what_can_i_make", "plan_summary", "recipe_nutrition"} <= read_only
    assert "plan_meals" not in read_only
    assert SPEC.kind == "mealplan" and SPEC.suffix == ".mealplan" and SPEC.color == "#D9902F"
    assert SPEC.reads == ("meals", "health") and SPEC.ai_web and SPEC.category == "Food"


# ---------------------------------------------------------------- API flow


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


async def test_api_flow(client, user):
    r = await client.post("/api/items/store/mealplan", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "mealplan", "title": "Family meals"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "Family meals.mealplan" and item["data"]["preferences"]["slots"] == ["dinner"]

    r = await client.post(f"/api/items/{fid}/actions/add_starter_recipes", headers=_auth(user), json={})
    assert r.status_code == 200, r.text
    today = date.today()
    r = await client.post(
        f"/api/items/{fid}/actions/plan_meals",
        headers=_auth(user),
        json={"args": {"meals": [{"date": (today + timedelta(days=d)).isoformat(), "recipe_id": rid}
                                 for d, rid in ((1, "red-lentil-spinach-dal"), (2, "sheet-pan-chicken-fajitas"))]}},
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/items/{fid}/actions/generate_grocery_list",
        headers=_auth(user),
        json={"args": {"start": today.isoformat(), "end": (today + timedelta(days=6)).isoformat()}},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert any(i["key"] == "red lentil" for i in data["grocery"]["items"])
    r = await client.post(f"/api/items/{fid}/actions/plan_summary", headers=_auth(user), json={})
    assert r.status_code == 200 and r.json()["result"]["start"]
    r = await client.post(f"/api/items/{fid}/actions/plan_meals", headers=_auth(user), json={"args": {"meals": [{"date": "x"}]}})
    assert r.status_code == 400

    # The UI's direct save path.
    data["grocery"]["items"][0]["checked"] = True
    rev = (await client.get(f"/api/items/{fid}/revision", headers=_auth(user))).json()["revision"]
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": rev})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["grocery"]["items"][0]["checked"] is True
    bad = dict(data, preferences={**data["preferences"], "household_size": 0})
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": bad, "base_revision": rev + 1})
    assert r.status_code == 400

    # Prep reminder for the fajitas (they have a prep-ahead note) — scheduled.
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.items.models import ItemReminder

    async with SessionLocal() as s:
        rows = (await s.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert any(x.key.startswith("prep:") for x in rows)

    # Search text follows the data.
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Red lentil & spinach dal" in row.content_text


async def test_import_endpoint(client, user, monkeypatch):
    from app.items.kinds.mealplan import web

    assert (await client.post("/api/items/k/mealplan/import", json={"url": "https://x.com"})).status_code == 401

    calls = []

    async def fake_fetch(method, url, **kw):
        calls.append(url)
        return httpx.Response(200, text=YOAST_GRAPH, request=httpx.Request("GET", url))

    monkeypatch.setattr("app.net.safe_fetch.safe_fetch", fake_fetch)
    r = await client.post("/api/items/k/mealplan/import", headers=_auth(user), json={"url": "blog.example.com/dal/"})
    assert r.status_code == 200, r.text
    assert r.json()["recipe"]["title"] == "Weeknight Dal" and calls == ["https://blog.example.com/dal/"]

    async def blocked(method, url, **kw):
        from app.net.safe_fetch import UnsafeURLError

        raise UnsafeURLError("blocked_ip:private", "nope")

    monkeypatch.setattr("app.net.safe_fetch.safe_fetch", blocked)
    r = await client.post("/api/items/k/mealplan/import", headers=_auth(user), json={"url": "http://10.0.0.1/"})
    assert r.status_code == 422 and "public web page" in r.json()["detail"]

    async def forbidden(method, url, **kw):
        return httpx.Response(403, text="no", request=httpx.Request("GET", url))

    monkeypatch.setattr("app.net.safe_fetch.safe_fetch", forbidden)
    r = await client.post("/api/items/k/mealplan/import", headers=_auth(user), json={"url": "https://x.example.com/"})
    assert r.status_code == 422 and "403" in r.json()["detail"]

    r = await client.post("/api/items/k/mealplan/import", headers=_auth(user), json={"text": "Toast\nIngredients\n2 slices bread\nMethod\nToast the bread."})
    assert r.status_code == 200 and r.json()["recipe"]["ingredients"][0]["unit"] == "slice"
    r = await client.post("/api/items/k/mealplan/import", headers=_auth(user), json={})
    assert r.status_code == 400
    r = await client.post("/api/items/k/mealplan/parse", headers=_auth(user), json={"lines": ["2 cups rice", "Sauce:", "1 tbsp soy sauce"]})
    assert r.status_code == 200
    ings = r.json()["ingredients"]
    assert ings[0]["unit"] == "cup" and ings[1]["group"] == "Sauce"


async def test_real_ssrf_guard_refuses_private_addresses():
    """The real fetcher (no mocks) refuses internal targets before any request."""
    from app.items.kinds.mealplan.web import ImportFailed, fetch_page

    for url in ("http://127.0.0.1/", "http://localhost:8000/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"):
        with pytest.raises(ImportFailed):
            await fetch_page(url)


# ======================================================= fix pass (review)

# ------------------------------------------------------------- allergens

ALLERGEN_CASES = [
    # (ingredient text, allergy as written, flagged?)
    ("Crème fraîche", "dairy", True),
    ("CRÈME FRAÎCHE", "milk", True),
    ("Parmigiano-Reggiano, grated", "dairy", True),
    ("parmesan", "lactose", True),
    ("labneh", "dairy", True),
    ("queso fresco", "dairy", True),
    ("ghee", "dairy", True),
    ("whey protein powder", "dairy", True),
    ("sodium caseinate (casein)", "dairy", True),
    ("coconut milk", "dairy", False),
    ("peanut butter", "dairy", False),
    ("butterflied chicken", "dairy", False),
    ("butter beans", "dairy", False),
    ("mixed nuts", "nuts", True),
    ("mixed nuts", "peanuts", True),
    ("mixed nuts", "tree nuts", True),
    ("roasted peanuts", "nuts", True),
    ("almonds", "nuts", True),
    ("almonds", "peanut", False),
    ("peanuts", "tree nuts", False),
    ("nutmeg", "nuts", False),
    ("butternut squash", "nuts", False),
    ("coconut", "tree nut", False),
    ("water chestnuts", "nuts", False),
    ("basil pesto", "tree nuts", True),
    ("basil pesto", "dairy", True),
    ("nut-free pesto", "tree nuts", False),
    ("hummus", "sesame", True),
    ("tahini", "sesame", True),
    ("houmous", "sesame allergy", True),
    ("fish sauce", "fish", True),
    ("nam pla", "fish", True),
    ("Thai red curry paste", "shellfish", True),
    ("green curry paste", "fish", True),
    ("shrimp paste", "shellfish", True),
    ("Worcestershire sauce", "fish", True),
    ("Worcestershire sauce", "seafood", True),
    ("oyster mushrooms", "shellfish", False),
    ("oyster sauce", "shellfish", True),
    ("soy sauce", "soy", True),
    ("soy sauce", "wheat", True),
    ("tamari", "gluten", False),
    ("mayonnaise", "egg", True),
    ("aioli", "eggs", True),
    ("eggplant", "egg", False),
    ("1 bunch coriander", "gluten", False),
    ("rotisserie chicken", "gluten", False),
    ("burger buns", "gluten", True),
    ("pikelets", "fish", False),
    ("beef carpaccio", "fish", False),
    ("smoked cod", "fish", True),
    ("salmon roe", "fish", True),
    ("gluten-free spaghetti", "coeliac", False),
    ("flour, or use gluten-free flour", "gluten", True),
    ("dairy-free cheese", "dairy", False),
    ("Nüsse", "nuts", False),  # unknown words stay unknown, no crash
    ("celery salt", "celery", True),
    ("prawns", "crustaceans", True),
    ("kiwi fruit", "kiwi", True),
]


@pytest.mark.parametrize("text, allergy, flagged", ALLERGEN_CASES)
def test_allergen_synonyms_and_normalising(text, allergy, flagged):
    assert bool(foods.allergy_hits([text], allergy)) is flagged


def test_allergy_wording_and_notes():
    assert foods.allergy_keys("nuts") == ["tree nut", "peanut"]
    assert foods.allergy_keys("Nut allergy") == ["tree nut", "peanut"]
    assert foods.allergy_keys("Tree nuts") == ["tree nut"]
    assert foods.allergy_keys("seafood") == ["fish", "shellfish"]
    assert foods.allergy_keys("allergic to peanuts") == ["peanut"]
    assert foods.normalize("Crème Fraîche") == "creme fraiche" and foods.normalize("Œufs") == "oeufs"
    # The note is read as well as the item.
    ings = [{"item": "oil", "note": "or ghee"}, {"item": "rice", "note": ""}]
    assert foods.allergen_report(ings, ["dairy", "gluten"]) == {"dairy": ["oil, or ghee"]}


def test_frontend_allergen_tables_are_the_same_file():
    """The app imports a copy of foods.json — they must be identical."""
    from pathlib import Path

    front = Path(__file__).resolve().parents[2] / "frontend" / "src" / "items" / "kinds" / "mealplan" / "foods.json"
    if not front.exists():
        pytest.skip("frontend not mounted")
    assert front.read_bytes() == foods.DATA_PATH.read_bytes()


def test_unit_aliases_shared_with_frontend():
    assert foods.DATA["unit_aliases"] == units._ALIASES


async def test_plan_meals_refuses_every_allergen_route():
    d = blank()
    d["preferences"]["allergies"] = ["dairy", "nuts", "sesame"]
    out = await run(d, "add_recipes", {"recipes": [
        {"title": "Creamy mushrooms", "ingredient_lines": ["250 g mushrooms", "100 ml crème fraîche"], "steps": ["Cook."]},
        {"title": "Pesto pasta", "ingredient_lines": ["200 g pasta", "3 tbsp pesto"], "steps": ["Cook."]},
        {"title": "Falafel plate", "ingredient_lines": ["falafel", "hummus"], "steps": ["Serve."]},
        {"title": "Oil rice", "ingredient_lines": ["1 cup rice", "1 tbsp oil, or ghee"], "steps": ["Cook."]},
        {"title": "Plain rice", "ingredient_lines": ["1 cup rice"], "steps": ["Cook."]},
    ]})
    # The re-check is in the summary the person sees, and in the result.
    assert "Allergy warning" in out.summary and "Creamy mushrooms" in out.summary
    assert set(out.result["allergen_conflicts"]) == {"creamy-mushrooms", "pesto-pasta", "falafel-plate", "oil-rice"}
    for rid in ("creamy-mushrooms", "pesto-pasta", "falafel-plate", "oil-rice"):
        with pytest.raises(ActionError) as e:
            await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": rid}]})
        assert "allergen" in str(e.value)
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "title": "Satay noodles with peanuts"}]})
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "title": "Takeaway"}, {"date": "2026-11-06", "title": "Cheese toastie"}]})
    assert d["plan"] == []  # a refused batch plans nothing
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "plain-rice"}]})
    # Editing a planned recipe so it gains an allergen is flagged with the date.
    out = await run(d, "edit_recipe", {"recipe_id": "plain-rice", "ingredient_lines": ["1 cup rice", "1 tbsp butter"]})
    assert "Allergy warning" in out.summary and "2026-11-05" in out.summary
    assert out.result["allergen_conflicts"]["plain-rice"]["planned_on"] == ["2026-11-05"]
    # …and its leftovers can't be planned either.
    with pytest.raises(ActionError):
        await run(d, "plan_meals", {"meals": [{"date": "2026-11-06", "leftovers_of_date": "2026-11-05"}]})
    # plan_summary and to_text flag it.
    res = (await run(d, "plan_summary", {})).result
    assert "dairy" in res["preference_warnings"]["Plain rice"]["allergens"]
    assert "⚠ contains dairy" in SPEC.to_text(d)


async def test_starters_skip_allergens_and_import_warns(monkeypatch):
    d = blank()
    d["preferences"]["allergies"] = ["fish"]
    out = await run(d, "add_starter_recipes", {})
    titles = {r["title"] for r in d["recipes"]}
    assert "Lemon garlic salmon with green beans" not in titles and len(titles) == 5
    assert out.result["skipped_for_allergies"] == ["Lemon garlic salmon with green beans"]

    from app.items.kinds.mealplan import web

    async def fake_page(url):
        return ALLRECIPES_LIKE

    monkeypatch.setattr(web, "fetch_page", fake_page)
    d = blank()
    d["preferences"]["allergies"] = ["legume"]
    d["preferences"]["allergies"] = ["kidney bean"]
    out = await run(d, "import_recipe_url", {"url": "https://www.example.com/chili"})
    assert "Allergy warning" in out.summary and out.result["allergen_conflicts"]


# ----------------------------------------------------------------- pantry


async def test_pantry_matches_full_names_never_loose_subsets():
    d = blank()
    await run(d, "add_recipes", {"recipes": [{"title": "Stew", "servings": 2, "ingredient_lines": [
        "1 pepper, diced", "½ tsp pepper", "freshly ground black pepper", "1 tsp sea salt", "2 eggs", "1 red onion",
        "1 tbsp extra-virgin olive oil", "50 g cheddar cheese",
    ], "steps": ["Cook."]}]})
    await run(d, "set_pantry", {"add": [{"name": "black pepper"}, {"name": "salt"}, {"name": "Eggs"}, {"name": "onion"},
                                        {"name": "olive oil"}, {"name": "cheddar"}]})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "stew"}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    keys = {i["key"] for i in d["grocery"]["items"]}
    # The capsicum is still bought; black pepper (both spellings), salt, eggs, olive oil and cheddar aren't.
    assert "pepper" in keys
    assert not keys & {"black pepper", "salt", "egg", "olive oil", "cheddar"}
    # "onion" doesn't cover "red onion".
    assert "red onion" in keys
    # what_can_i_make: black pepper doesn't stand in for a pepper
    out = await run(d, "what_can_i_make", {"ingredients": ["black pepper", "red onion", "cheddar"], "max_missing": 5})
    assert "pepper" in out.result["recipes"][0]["missing"]


# ----------------------------------------------------------------- parser


@pytest.mark.parametrize(
    "line, qty, unit, item, note, key",
    [
        ("400g/14oz chickpeas", 400, "g", "chickpeas", "14 oz", "chickpea"),
        ("400g can chickpeas, drained", 1, "can", "chickpeas", "400 g can, drained", "chickpea"),
        ("1 x 400g tin chopped tomatoes", 1, "can", "chopped tomatoes", "400 g can", "tomato"),
        ("1,500 ml water", 1500, "ml", "water", "", "water"),
        ("1,5 kg potatoes", 1.5, "kg", "potatoes", "", "potato"),
        ("1 lb 4 oz ground beef", 1.25, "lb", "ground beef", "", "ground beef"),
        ("1 cup 2 tbsp milk", 1.125, "cup", "milk", "", "milk"),
        ("2 tbsp extra-virgin olive oil", 2, "tbsp", "extra-virgin olive oil", "", "olive oil"),
        ("8 oz milk", 8, "floz", "milk", "", "milk"),
        ("8 oz chicken stock", 8, "floz", "chicken stock", "", "chicken stock"),
        ("8 oz cream cheese", 8, "oz", "cream cheese", "", "cream cheese"),
        ("100 g cheddar cheese, grated", 100, "g", "cheddar cheese", "grated", "cheddar"),
        ("2 cups plain flour", 2, "cup", "plain flour", "", "flour"),
        ("1 cup all-purpose flour", 1, "cup", "all-purpose flour", "", "flour"),
    ],
)
def test_parser_fixes(line, qty, unit, item, note, key):
    p = parse.parse_ingredient(line)
    assert p["qty"] == pytest.approx(qty)
    assert (p["unit"], p["item"], p["note"]) == (unit, item, note)
    assert foods.grocery_key(p["item"], p["unit"], p["qty"]) == key


async def test_grocery_merges_synonyms_and_folds_liquid_weights():
    d = blank()
    await run(d, "add_recipes", {"recipes": [
        {"title": "A", "servings": 2, "ingredient_lines": ["100 g cheddar", "200 g plain flour", "200 g milk"], "steps": ["x"]},
        {"title": "B", "servings": 2, "ingredient_lines": ["50 g cheddar cheese", "100 g flour", "1 cup milk", "8 oz whole milk"], "steps": ["x"]},
    ]})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "a"}, {"date": "2026-11-06", "recipe_id": "b"}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-06"})
    items = {i["key"]: i for i in d["grocery"]["items"]}
    assert items["cheddar"]["amounts"] == [{"qty": 150.0, "unit": "g"}]
    assert items["flour"]["amounts"] == [{"qty": 300.0, "unit": "g"}]
    # 200 g milk ≈ 194 ml + 1 cup (237 ml) + 8 fl oz (237 ml) → one volume
    assert items["milk"]["amounts"] == [{"qty": 670.0, "unit": "ml"}]


# --------------------------------------------------- update from the plan


async def test_update_from_plan_keeps_edits_and_deletions():
    d = blank()
    await run(d, "add_recipes", {"recipes": [{"title": "Curry", "servings": 2, "ingredient_lines": [
        "2 onions", "400 ml coconut milk", "1 tbsp curry powder", "300 g chicken thighs"], "steps": ["x"]}]})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "curry"}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    items = {i["key"]: i for i in d["grocery"]["items"]}
    # The person renames one, notes another, edits an amount, deletes one.
    items["onion"].update(name="Brown onions", renamed=True)
    items["coconut milk"]["note"] = "the light one"
    items["chicken thigh"].update(amounts=[{"qty": 500, "unit": "g"}], qty_edited=True)
    d["grocery"]["items"] = [i for i in d["grocery"]["items"] if i["key"] != "curry powder"]
    d["grocery"]["removed"] = ["curry powder"]
    d = SPEC.validate(d)
    out = await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    items = {i["key"]: i for i in d["grocery"]["items"]}
    assert items["onion"]["name"] == "Brown onions" and items["onion"]["renamed"]
    assert items["coconut milk"]["note"] == "the light one"
    assert items["chicken thigh"]["amounts"] == [{"qty": 500, "unit": "g"}]
    assert "curry powder" not in items and d["grocery"]["removed"] == ["curry powder"]
    assert "you removed left off" in out.summary
    # Bring it back on request…
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05", "restore_removed": True})
    assert "curry powder" in {i["key"] for i in d["grocery"]["items"]} and d["grocery"]["removed"] == []
    # …and a new range starts fresh.
    d["grocery"]["removed"] = ["curry powder"]
    await run(d, "generate_grocery_list", {"start": "2026-11-02", "end": "2026-11-08"})
    assert "curry powder" in {i["key"] for i in d["grocery"]["items"]} and d["grocery"]["removed"] == []


def test_model_links_keys_and_household_reminders():
    clean = SPEC.validate({
        "recipes": [{"id": "r", "title": "x", "source_url": "javascript:alert(1)", "image_url": "example.com/a.jpg"}],
        "grocery": {"items": [{"id": "m1", "name": "2 Large Onions"}]},
    })
    assert clean["recipes"][0]["source_url"] == "" and clean["recipes"][0]["image_url"] == "https://example.com/a.jpg"
    # An item added offline without a key gets one on save.
    assert clean["grocery"]["items"][0]["key"] == "onion"
    assert clean["grocery"]["removed"] == [] and clean["grocery"]["items"][0]["renamed"] is False
    assert SPEC.remind_collaborators is True
    assert "AnyList" not in SPEC.replaces and "Paprika" not in SPEC.replaces


async def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = blank()
    await run(d, "add_starter_recipes", {})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-02", "recipe_id": "red-lentil-spinach-dal"},
                                          {"date": "2026-11-05", "recipe_id": "beef-broccoli-stir-fry"}]})
    token = _TEXT_NOW.set(NOW)
    try:
        t = SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    assert t.startswith("Today: Wednesday 2026-11-04")
    assert t.index("today onwards") < t.index("2026-11-05") < t.index("Earlier meals") < t.index("2026-11-02")


async def test_adding_to_a_plan_item_survives_update_from_plan():
    d = blank()
    await run(d, "add_recipes", {"recipes": [{"title": "Toast", "servings": 2, "ingredient_lines": ["2 slices bread", "500 ml milk"], "steps": ["x"]}]})
    await run(d, "plan_meals", {"meals": [{"date": "2026-11-05", "recipe_id": "toast"}]})
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    out = await run(d, "add_grocery_items", {"lines": ["1 l milk"]})
    assert out.result["merged_into_existing"] == ["Milk"]
    await run(d, "generate_grocery_list", {"start": "2026-11-05", "end": "2026-11-05"})
    milk = next(i for i in d["grocery"]["items"] if i["key"] == "milk")
    assert milk["amounts"] == [{"qty": 1.5, "unit": "l"}] and milk["qty_edited"]
