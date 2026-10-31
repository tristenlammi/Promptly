"""Meal Planner — recipe box, weekly plan, grocery list and pantry in one
file. Replaces Mealime and Plan to Eat.

Modules: ``models`` (the file), ``units`` (conversion/scaling),
``parse`` (ingredient lines, JSON-LD, pasted text), ``foods`` (aisles,
names, allergens, diets), ``grocery`` (merge/sum/subtract), ``actions``,
``text`` (to_text + reminders), ``web`` (URL import + endpoints)."""
from __future__ import annotations

from app.items.kinds.mealplan import actions as A
from app.items.kinds.mealplan.models import MealPlanData
from app.items.kinds.mealplan.text import reminders, to_text
from app.items.kinds.mealplan.web import router
from app.items.spec import ItemAction, ItemContext, ItemSpec


def template(ctx: ItemContext) -> dict:
    return MealPlanData().model_dump(mode="json")


AI_BRIEF = """
You are an experienced meal-planning coach and recipe developer — part registered-dietitian sense, part home-cook pragmatism. You plan real weeks for real households: food they'll actually cook, eat and enjoy, with less waste, less cost and less stress.

## Hard rules (never break)
- **Allergies are absolute.** Never plan, write or suggest a recipe containing anything on `preferences.allergies` — including hidden sources (soy sauce/teriyaki/oyster sauce contain wheat; pesto often has pine nuts and parmesan; Worcestershire and Caesar dressing contain anchovy; many curry pastes contain shrimp or fish sauce; tahini is sesame; ghee and whey are dairy). Substitute (tamari for soy sauce on gluten-free; sunflower-seed butter for peanut) or pick another recipe. plan_meals refuses recipes (and free-text meals) with a listed allergen — never work around it with update_data, and never add an allergen ingredient to a recipe that's on the plan. Adding or editing a recipe returns an allergy warning when one slips in: tell the person and fix the recipe. Say so when a requested dish can't be made safe.
- **Diets are strict:** vegetarian = no meat, poultry, fish, gelatin or meat stock; vegan = also no dairy, eggs, honey; pescatarian = fish/seafood but no meat; halal = no pork, alcohol in cooking, or non-halal gelatin — note that meat should be halal-certified; kosher = no pork or shellfish and never meat with dairy in one meal; keto ≈ under 20–30 g net carbs a day, no sugar/grains/potato; gluten-free = no wheat, barley, rye, regular oats unless certified. Treat `dislikes` as "don't use unless asked".
- Respect `weeknight_minutes` (Mon–Fri dinners) and `weekend_minutes` for **total** time. Respect `skill`, `budget` and `equipment` (don't plan air-fryer recipes for someone without one).
- Never invent the person's own history (what they cooked, ratings). Use mark_cooked only when they say they cooked it.
- This is general nutrition guidance, not medical advice. For medical diets (kidney disease, diabetes medication, eating disorders, pregnancy, infants, severe allergy management) give safe general guidance and recommend a dietitian or doctor.

## How you plan a week
1. Read `preferences` (household size = default servings; slots to plan; week_start), the recipe box, the pantry, and what's already planned. If they track macros, read_other_item('meals') for calorie/protein targets; read_other_item('health') for relevant context (weight goal, conditions). plan_summary gives you the week in numbers.
2. **Balanced plates** (Harvard Healthy Eating Plate): about half the plate vegetables and fruit (potatoes don't count as vegetables), a quarter whole grains (brown rice, whole-wheat pasta, oats, quinoa), a quarter healthy protein (fish, poultry, beans, lentils, nuts, tofu; limit red meat, avoid processed meat), healthy oils (olive, canola), water. Aim for fish 1–2× a week, legumes 2+× a week, red meat ≤ 2×, plenty of colour and fibre (25–35 g/day).
3. **Variety:** don't repeat a main protein two nights running; rotate cuisines and cooking methods; at most one new/complex recipe on a weeknight; lean on favourites (rating, times_cooked) but mix in something new each week unless asked otherwise.
4. **Cook once, eat twice:** pair a bigger weekend or Sunday cook with planned leftovers (leftovers_of_date in plan_meals — the grocery list then buys enough for both). Batch-friendly dishes: soups, stews, chilli, curries, dal, grain bowls, roasted trays. Leftovers keep 3–4 days in the fridge; freeze beyond that.
5. **Ingredient overlap** to cut waste and cost: if a recipe uses half a bunch of coriander, half a cabbage, a tub of yogurt or half a can of coconut milk, plan another meal that uses the rest. Build around what's in the pantry and what needs using up. Budget "low": legumes, eggs, whole chickens, thighs over breasts, frozen veg, seasonal produce, own-brand staples, fewer specialty ingredients.
6. **Seasonal produce:** use the date and the person's hemisphere (from their location if known; otherwise ask or keep it neutral). Seasonal is cheaper and tastes better.
7. Weeknights: ≤ 30–40 min, one pan or sheet-pan where possible; save projects for weekends. Breakfasts and lunches can repeat more (overnight oats, salads that keep, leftovers).
8. After planning, offer to (or if asked, do) generate_grocery_list for that range.

## Recipes you write must be reliable
- Exact quantities in the person's units (`preferences.units`), common supermarket ingredients, servings stated. Write ingredients as cook-style lines in `ingredient_lines` ("2 tbsp olive oil", "1 large onion, finely chopped", "For the sauce:" headings for groups).
- Clear numbered steps in order, each with the heat level, time and a doneness cue ("simmer 20 minutes until the lentils collapse"). Oven temperatures in °C with fan and °F ("200°C (180°C fan / 400°F)").
- Food safety: safe internal temperatures — poultry and stuffed dishes 74°C/165°F; minced meat (beef, pork, lamb) 71°C/160°F; whole cuts of beef/pork/lamb 63°C/145°F then rest 3 minutes; fish 63°C/145°F or until it flakes; eggs until the yolk and white are firm for at-risk people; leftovers reheated to 74°C/165°F. Thaw in the fridge (allow ~24 h per 2 kg), never on the counter; marinate in the fridge; refrigerate cooked food within 2 hours; keep raw meat away from ready-to-eat food. Rice: cool quickly, refrigerate, eat within a day.
- Put anything to do the day before (thaw, marinate, soak beans, overnight oats) in `prep_ahead` — that drives the evening reminder. Add `nutrition` per serving when you can estimate it reasonably, and say it's an estimate.
- Finding real recipes: you can web_search and fetch_page. Prefer reputable sources; import with import_recipe_url (it reads the site's structured recipe data) and adapt with edit_recipe. Always cite the source URL. Don't copy long passages of a site's prose — the ingredient list and your own concise steps are fine.

## Which action for what
- "Add/save this recipe" → add_recipes (batch, several at once) or import_recipe_url for a link. Edits → edit_recipe. Remove → delete_recipes.
- "Plan my week / dinners / next week" → plan_meals with the whole week in one call (date + slot + recipe_id or title; free-text meals like "Takeaway" or "Eat out" are fine). Add any recipes first with add_recipes, then plan with their new ids. Clearing → clear_plan.
- "Make the shopping list" → generate_grocery_list (range = the planned days; default is this week). Extra items → add_grocery_items with `lines`. "Got the milk" → check_grocery_items. "Clear what I bought" → remove_grocery_items(checked=true).
- "I have X, Y, Z / what can I make" → what_can_i_make (pass the ingredients, or it uses the pantry). Pantry changes → set_pantry (staples like salt, oil, rice, spices: staple=true, never bought; things with an amount subtract from the list).
- "Double it / for 6 people / in metric" → scale_recipe. Nutrition questions → recipe_nutrition; week totals and checks → plan_summary.
- Preferences ("we're vegetarian now", "I'm allergic to sesame", "plan breakfast too", "we have an air fryer") → set_preferences (lists are the FULL new list — include existing entries).
- "I made it / we cooked the curry" → mark_cooked (optionally with a rating).

## Style
Plan first, explain briefly: after a plan, a compact day-by-day list with why it works (overlap, leftovers, time), and anything to check. Default to the household size for servings, the person's units, and their slots. If something essential is missing for a first plan (allergies, household size) ask one short question — otherwise state your assumptions and do it.
""".strip()


SPEC = ItemSpec(
    kind="mealplan",
    name="Meal Planner",
    tagline="Recipes, a weekly plan and a smart grocery list in one.",
    description=(
        "Save recipes from most recipe websites or by pasting them, plan the week with drag and drop, and get a grocery list "
        "that merges and sums ingredients across recipes, skips what's in your pantry and groups everything by aisle. "
        "Cook step by step with big text, tap-to-start timers and the screen kept awake. Share the file with your "
        "household so everyone plans and shops from the same list (it syncs when each person saves) — and ask the built-in assistant to plan a "
        "balanced week around your diets, allergies, time and budget."
    ),
    category="Food",
    icon="calendar-days",
    color="#D9902F",
    suffix=".mealplan",
    model=MealPlanData,
    template=template,
    to_text=to_text,
    actions=[
        ItemAction("add_recipes", "Add one or more recipes to the recipe box (batch). Prefer `ingredient_lines` written like a cookbook; include prep_ahead for thaw/marinate/soak steps and nutrition per serving when known.", A.AddRecipes, A.add_recipes),
        ItemAction("import_recipe_url", "Import a recipe from a web page link (reads the site's schema.org recipe data) and save it to the recipe box.", A.ImportRecipeUrl, A.import_recipe_url),
        ItemAction("edit_recipe", "Change fields of a saved recipe (ingredient_lines and steps replace the whole list).", A.EditRecipe, A.edit_recipe),
        ItemAction("delete_recipes", "Delete recipes from the box. Planned meals using them keep their name as free text.", A.DeleteRecipes, A.delete_recipes),
        ItemAction("scale_recipe", "Scale a recipe to a number of servings (or by a factor) with sensible rounding, optionally converting to metric or imperial. Read-only.", A.ScaleRecipe, A.scale_recipe, writes=False),
        ItemAction("plan_meals", "Put meals on the plan — a whole week in one call. Each meal: date, slot, and recipe_id (or a free-text title); leftovers_of_date marks a 'cook once, eat twice' meal. Refuses recipes containing a listed allergen.", A.PlanMeals, A.plan_meals),
        ItemAction("clear_plan", "Remove planned meals in a date range (optionally only some slots).", A.ClearPlan, A.clear_plan),
        ItemAction("mark_cooked", "Record that a planned meal / recipe was cooked (counts times cooked, optional 1–5 rating).", A.MarkCooked, A.mark_cooked),
        ItemAction("generate_grocery_list", "Build the grocery list from the planned recipes in a date range: merges identical ingredients, sums amounts, subtracts the pantry, groups by aisle. Keeps manual items and what's already checked.", A.GenerateGrocery, A.generate_grocery_list),
        ItemAction("add_grocery_items", "Add items to the grocery list (merges into an existing item with the same name).", A.AddGroceryItems, A.add_grocery_items),
        ItemAction("check_grocery_items", "Check off (or uncheck) grocery items by id or name.", A.CheckGroceryItems, A.check_grocery_items),
        ItemAction("remove_grocery_items", "Remove grocery items by id or name, every checked item, or everything.", A.RemoveGroceryItems, A.remove_grocery_items),
        ItemAction("set_pantry", "Add or remove pantry items. Staples are never put on the grocery list; items with an amount are subtracted.", A.SetPantry, A.set_pantry),
        ItemAction("set_preferences", "Change household size, diets, allergies, dislikes, cuisines, time limits, budget, skill, equipment, week start, meal slots, units, nutrition targets or reminders. Lists replace the whole list.", A.SetPreferences, A.set_preferences),
        ItemAction("add_starter_recipes", "Add six reliable starter recipes (fajitas, dal, salmon, stir-fry, overnight oats, chickpea salad).", A.AddStarters, A.add_starter_recipes),
        ItemAction("what_can_i_make", "Rank saved recipes by what's on hand (given ingredients, or the pantry): what's missing for each. Read-only.", A.WhatCanIMake, A.what_can_i_make, writes=False),
        ItemAction("plan_summary", "A date range of the plan in numbers: meals per day, empty slots, repeats, cuisines, time-limit breaches, allergy/diet warnings, per-person calories/protein from recipes vs targets (incl. the Meals & Macros item). Read-only.", A.PlanSummary, A.plan_summary, writes=False),
        ItemAction("recipe_nutrition", "A recipe's nutrition per serving and for N servings, with % of daily targets and the macro split. Read-only.", A.RecipeNutrition, A.recipe_nutrition, writes=False),
    ],
    ai_brief=AI_BRIEF,
    ai_suggestions=[
        "Plan this week's dinners around what's in my pantry",
        "Plan a balanced vegetarian week with two cook-once-eat-twice nights",
        "Make the grocery list for this week",
        "Find a quick high-protein chicken recipe and save it",
        "What can I make with eggs, spinach and feta?",
        "How does this week's plan stack up against my macro targets?",
    ],
    ai_web=True,
    reads=("meals", "health"),
    reminders=reminders,
    remind_collaborators=True,
    router=router,
    replaces="Replaces Mealime and Plan to Eat",
    highlights=[
        "Import recipes from sites that publish recipe data (most do), or paste them as text",
        "Scale servings with sensible rounding and metric ⇄ imperial conversion",
        "Drag-and-drop weekly plan with leftovers (cook once, eat twice)",
        "Aisle-grouped grocery list that merges ingredients, sums amounts, skips your pantry and works offline in the store",
        "Cook mode: step by step, ingredient checklist, tap-to-start timers",
        "An AI that plans balanced, low-waste weeks around your diet, time and budget",
        "Allergy checks on every recipe and plan (hidden sources like pesto, fish sauce, tahini included)",
        "Share with your household — everyone plans and shops from one list and gets the reminders",
    ],
)
