"""The Meal Planner file: preferences, a recipe box, the plan, the grocery
list and the pantry. Every field has a default so old files keep loading;
every list is bounded so a file stays well under the size limit."""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError, field_validator, model_validator

from app.items.kinds.mealplan import foods, units
from app.items.spec import SafeUrl

Slot = Literal["breakfast", "lunch", "dinner", "snack"]
SLOTS: tuple[str, ...] = ("breakfast", "lunch", "dinner", "snack")
DAY_RE = r"^\d{4}-\d{2}-\d{2}$"
TIME_RE = r"^([01]\d|2[0-3]):[0-5]\d$"


def _valid_day(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    date.fromisoformat(v)
    return v


_SAFE_URL = TypeAdapter(SafeUrl)


def safe_link(v) -> str:
    """A link safe to render (http(s)/mailto/tel) — anything else becomes ""
    instead of failing the whole file (old files must keep loading)."""
    try:
        return _SAFE_URL.validate_python(str(v or ""))
    except ValidationError:
        return ""


def _str_list(v: list[str], limit: int = 60) -> list[str]:
    out: list[str] = []
    for x in v or []:
        t = " ".join(str(x).split())[:limit]
        if t and t.lower() not in (o.lower() for o in out):
            out.append(t)
    return out


class Preferences(BaseModel):
    household_size: int = Field(2, ge=1, le=20)
    diets: list[str] = Field(default_factory=list, max_length=12)
    allergies: list[str] = Field(default_factory=list, max_length=20)
    dislikes: list[str] = Field(default_factory=list, max_length=40)
    cuisines: list[str] = Field(default_factory=list, max_length=20)
    weeknight_minutes: int | None = Field(45, ge=5, le=600)
    weekend_minutes: int | None = Field(None, ge=5, le=900)
    budget: Literal["low", "medium", "high"] = "medium"
    skill: Literal["beginner", "intermediate", "advanced"] = "intermediate"
    equipment: list[str] = Field(default_factory=list, max_length=30)
    # 0 = Sunday … 6 = Saturday (as JavaScript's getDay)
    week_start: int = Field(1, ge=0, le=6)
    slots: list[Slot] = Field(default_factory=lambda: ["dinner"], max_length=4)
    units: Literal["metric", "imperial"] = "metric"
    calories_per_day: int | None = Field(None, ge=800, le=6000)
    protein_g_per_day: int | None = Field(None, ge=10, le=400)
    prep_reminders: bool = True
    prep_reminder_time: str = Field("19:00", pattern=TIME_RE)
    shopping_reminder: bool = False
    shopping_day: int = Field(6, ge=0, le=6)
    shopping_time: str = Field("09:00", pattern=TIME_RE)
    aisle_order: list[str] = Field(default_factory=lambda: list(foods.AISLE_ORDER), max_length=30)
    keep_awake: bool = True
    onboarded: bool = False

    @field_validator("diets", "allergies", "dislikes", "cuisines", "equipment", mode="before")
    @classmethod
    def _tidy(cls, v):
        return _str_list(v or [])

    @field_validator("slots")
    @classmethod
    def _slots(cls, v):
        seen = [s for s in SLOTS if s in v]
        return seen or ["dinner"]

    @field_validator("aisle_order")
    @classmethod
    def _aisles(cls, v):
        out = [a for a in v if a in foods.AISLES]
        out = list(dict.fromkeys(out))
        return out + [a for a in foods.AISLE_ORDER if a not in out]


class Ingredient(BaseModel):
    id: str = Field("", max_length=40)
    qty: float | None = Field(None, ge=0, le=100_000)
    qty_max: float | None = Field(None, ge=0, le=100_000)
    unit: str = Field("", max_length=20)
    item: str = Field("", max_length=200)
    note: str = Field("", max_length=300)
    optional: bool = False
    group: str = Field("", max_length=80)
    aisle: str = Field("", max_length=30)

    @field_validator("unit", mode="before")
    @classmethod
    def _unit(cls, v):
        return units.unit_key(v or "")

    @field_validator("aisle")
    @classmethod
    def _aisle(cls, v):
        return v if (not v or v in foods.AISLES) else "other"


class Nutrition(BaseModel):
    """Per serving."""

    calories: float | None = Field(None, ge=0, le=10_000)
    protein_g: float | None = Field(None, ge=0, le=1000)
    carbs_g: float | None = Field(None, ge=0, le=2000)
    fat_g: float | None = Field(None, ge=0, le=1000)
    fiber_g: float | None = Field(None, ge=0, le=500)
    sugar_g: float | None = Field(None, ge=0, le=1000)
    saturated_fat_g: float | None = Field(None, ge=0, le=500)
    sodium_mg: float | None = Field(None, ge=0, le=50_000)


class Recipe(BaseModel):
    id: str = Field(max_length=40)
    title: str = Field("Untitled recipe", min_length=1, max_length=200)
    servings: float = Field(4, gt=0, le=100)
    ingredients: list[Ingredient] = Field(default_factory=list, max_length=150)
    steps: list[str] = Field(default_factory=list, max_length=100)
    prep_min: int | None = Field(None, ge=0, le=20_000)
    cook_min: int | None = Field(None, ge=0, le=20_000)
    total_min: int | None = Field(None, ge=0, le=40_000)
    tags: list[str] = Field(default_factory=list, max_length=25)
    cuisine: str = Field("", max_length=60)
    source_url: SafeUrl = Field("", max_length=1000)
    image_url: SafeUrl = Field("", max_length=2000)
    notes: str = Field("", max_length=5000)
    # Done the day before: thaw, marinate, soak — drives the evening reminder.
    prep_ahead: str = Field("", max_length=300)
    rating: int = Field(0, ge=0, le=5)
    favorite: bool = False
    times_cooked: int = Field(0, ge=0, le=100_000)
    last_cooked: str | None = Field(None, pattern=DAY_RE)
    nutrition: Nutrition | None = None
    added: str | None = Field(None, pattern=DAY_RE)

    @field_validator("steps", mode="before")
    @classmethod
    def _steps(cls, v):
        return [str(s).strip()[:3000] for s in (v or []) if str(s).strip()]

    @field_validator("tags", mode="before")
    @classmethod
    def _tags(cls, v):
        return [t.lower() for t in _str_list(v or [], 40)]

    @field_validator("last_cooked", "added")
    @classmethod
    def _days(cls, v):
        return _valid_day(v)

    @field_validator("source_url", "image_url", mode="before")
    @classmethod
    def _links(cls, v, info):
        return safe_link(v)[: 1000 if info.field_name == "source_url" else 2000]


class PlanEntry(BaseModel):
    id: str = Field(max_length=40)
    date: str = Field(pattern=DAY_RE)
    slot: Slot = "dinner"
    recipe_id: str | None = Field(None, max_length=40)
    # Free-text meal ("Pizza night out") or the recipe's title at planning time.
    title: str = Field("", max_length=200)
    servings: float | None = Field(None, gt=0, le=100)
    # "Cook once, eat twice": this meal is the leftovers of another entry.
    leftovers_of: str | None = Field(None, max_length=40)
    note: str = Field("", max_length=300)
    cooked: bool = False

    @field_validator("date")
    @classmethod
    def _day(cls, v):
        return _valid_day(v)


class Amount(BaseModel):
    qty: float | None = Field(None, ge=0, le=1_000_000)
    unit: str = Field("", max_length=20)


class GroceryItem(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=200)
    key: str = Field("", max_length=80)
    amounts: list[Amount] = Field(default_factory=list, max_length=6)
    aisle: str = Field("other", max_length=30)
    checked: bool = False
    source: Literal["plan", "manual"] = "manual"
    recipes: list[str] = Field(default_factory=list, max_length=12)
    note: str = Field("", max_length=300)
    # The person renamed it / changed its amount: "Update from plan" keeps
    # their version.
    renamed: bool = False
    qty_edited: bool = False

    @field_validator("aisle")
    @classmethod
    def _aisle(cls, v):
        return v if v in foods.AISLES else "other"

    @model_validator(mode="after")
    def _key(self):
        # Items added offline in the app may arrive without a key.
        if not self.key:
            from app.items.kinds.mealplan.grocery import manual_key

            self.key = manual_key(self.name)[:80]
        return self


class GroceryList(BaseModel):
    items: list[GroceryItem] = Field(default_factory=list, max_length=600)
    start: str | None = Field(None, pattern=DAY_RE)
    end: str | None = Field(None, pattern=DAY_RE)
    generated_at: str | None = Field(None, max_length=40)
    # Planned ingredients the pantry covered (shown as "you have these").
    covered: list[str] = Field(default_factory=list, max_length=200)
    # Keys of plan items the person deleted from this range's list — kept off
    # when the list is updated from the plan again.
    removed: list[str] = Field(default_factory=list, max_length=400)


class PantryItem(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=120)
    qty: float | None = Field(None, ge=0, le=1_000_000)
    unit: str = Field("", max_length=20)
    # Always on hand (salt, oil, rice): never added to the grocery list.
    staple: bool = True

    @field_validator("unit", mode="before")
    @classmethod
    def _unit(cls, v):
        return units.unit_key(v or "")


class AisleOverride(BaseModel):
    key: str = Field(max_length=80)
    aisle: str = Field(max_length=30)


class MealPlanData(BaseModel):
    preferences: Preferences = Field(default_factory=Preferences)
    recipes: list[Recipe] = Field(default_factory=list, max_length=1500)
    plan: list[PlanEntry] = Field(default_factory=list, max_length=3000)
    grocery: GroceryList = Field(default_factory=GroceryList)
    pantry: list[PantryItem] = Field(default_factory=list, max_length=400)
    # The aisle someone moved an item to — remembered for next time.
    aisle_overrides: list[AisleOverride] = Field(default_factory=list, max_length=500)
