"""The shape of a ``.meals`` file.

Canonical units everywhere: energy in kcal, macros in grams, sodium and most
minerals in mg, water in ml, body weight in kg, height in cm. Display units
live in ``settings``. Every field has a default so old files keep loading;
every list is bounded so a file stays well under the 8 MB limit after years
of logging.

Diary entries carry a **snapshot** of their nutrition (totals for the
portion eaten), so editing or deleting a food never rewrites history.
"""
from __future__ import annotations

import re
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field, SerializationInfo, field_validator, model_serializer, model_validator

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

# Optional micronutrients (and a few extras), canonical unit in the key.
# label, unit, daily reference value (FDA %DV / common limits; None = no DV).
MICROS: dict[str, tuple[str, str, float | None]] = {
    "potassium_mg": ("Potassium", "mg", 4700),
    "calcium_mg": ("Calcium", "mg", 1300),
    "iron_mg": ("Iron", "mg", 18),
    "magnesium_mg": ("Magnesium", "mg", 420),
    "zinc_mg": ("Zinc", "mg", 11),
    "vitamin_a_ug": ("Vitamin A", "µg", 900),
    "vitamin_c_mg": ("Vitamin C", "mg", 90),
    "vitamin_d_ug": ("Vitamin D", "µg", 20),
    "vitamin_b12_ug": ("Vitamin B12", "µg", 2.4),
    "folate_ug": ("Folate", "µg", 400),
    "cholesterol_mg": ("Cholesterol", "mg", 300),
    "added_sugar_g": ("Added sugar", "g", 50),
    "mono_fat_g": ("Monounsaturated fat", "g", None),
    "poly_fat_g": ("Polyunsaturated fat", "g", None),
    "trans_fat_g": ("Trans fat", "g", None),
    "omega3_g": ("Omega-3", "g", None),
    "caffeine_mg": ("Caffeine", "mg", 400),
    "alcohol_g": ("Alcohol", "g", None),
}

MACRO_KEYS = ("kcal", "protein", "carbs", "sugar", "fibre", "fat", "sat_fat", "sodium")

ACTIVITY_LEVELS = ("sedentary", "light", "moderate", "active", "very_active")
DIET_STYLES = ("balanced", "high_protein", "low_carb", "keto", "low_fat")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_VISIBLE_SLOTS = 8


def _r1(v: float) -> float:
    return round(float(v), 1)


def _compact_num(v: Any) -> Any:
    """``105.0`` → ``105`` in the stored JSON (two bytes a number, times
    tens of thousands of numbers over years of logging)."""
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    return v


def _full(info: SerializationInfo) -> bool:
    ctx = info.context
    return bool(isinstance(ctx, dict) and ctx.get("full"))


# Nutrient fields left out of the stored JSON when they're zero. Energy and
# the three macros are always written (everything reads them).
_SLIM_NUTRIENTS = ("sugar", "fibre", "sat_fat", "sodium")


class _SlimDefaults(BaseModel):
    """Leaves the fields named in ``SLIM_FIELDS`` out of the stored JSON while they
    hold their default (an empty brand, no note, not an estimate…). Loading
    fills the defaults back in, so old and new files read the same; code that
    works on the raw dict calls :func:`hydrate` first."""

    SLIM_FIELDS: ClassVar[tuple[str, ...]] = ()

    @model_serializer(mode="wrap")
    def _slim(self, handler: Any, info: SerializationInfo) -> Any:
        out = handler(self)
        if _full(info) or not isinstance(out, dict):
            return out
        fields = type(self).model_fields
        for k in self.SLIM_FIELDS:
            if k not in out:
                continue
            d = fields[k].get_default(call_default_factory=True)
            v = out[k]
            num = isinstance(v, (int, float)) and isinstance(d, (int, float)) and not isinstance(v, bool) and not isinstance(d, bool)
            if v == d and (type(v) is type(d) or num):
                del out[k]
        for k in ("amount", "grams"):
            if k in out:
                out[k] = _compact_num(out[k])
        return out


class Nutrients(BaseModel):
    """Energy and nutrients — per 100 g on a food, totals on an entry."""

    kcal: float = Field(default=0, ge=0, le=100_000)
    protein: float = Field(default=0, ge=0, le=10_000)
    carbs: float = Field(default=0, ge=0, le=10_000)
    sugar: float = Field(default=0, ge=0, le=10_000)
    fibre: float = Field(default=0, ge=0, le=10_000)
    fat: float = Field(default=0, ge=0, le=10_000)
    sat_fat: float = Field(default=0, ge=0, le=10_000)
    sodium: float = Field(default=0, ge=0, le=1_000_000, description="mg")
    micros: dict[str, float] = Field(default_factory=dict)

    @field_validator("kcal", "protein", "carbs", "sugar", "fibre", "fat", "sat_fat", "sodium")
    @classmethod
    def _round(cls, v: float) -> float:
        return _r1(v)

    @field_validator("micros")
    @classmethod
    def _known_micros(cls, v: dict[str, float]) -> dict[str, float]:
        out: dict[str, float] = {}
        for k, n in (v or {}).items():
            if k in MICROS and isinstance(n, (int, float)) and 0 <= n <= 1_000_000:
                # 3 significant figures (422.44 → 422, 0.534 stays): label
                # precision, and fewer bytes over years of entries.
                out[k] = float(f"{round(float(n), 2):.3g}")
        return out

    @model_serializer(mode="wrap")
    def _slim(self, handler: Any, info: SerializationInfo) -> Any:
        out = handler(self)
        if _full(info) or not isinstance(out, dict):
            return out
        for k in _SLIM_NUTRIENTS:
            if not out.get(k):
                out.pop(k, None)
        if not out.get("micros"):
            out.pop("micros", None)
        else:
            out["micros"] = {k: _compact_num(v) for k, v in out["micros"].items()}
        for k in ("kcal", "protein", "carbs", "fat", *_SLIM_NUTRIENTS):
            if k in out:
                out[k] = _compact_num(out[k])
        return out


class Serving(BaseModel):
    id: str = Field(max_length=40)
    label: str = Field(max_length=60)  # "1 large egg", "1 cup"
    grams: float = Field(gt=0, le=5000)


class Food(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=120)
    brand: str = Field(default="", max_length=80)
    barcode: str | None = Field(default=None, max_length=20)
    servings: list[Serving] = Field(default_factory=list, max_length=12)
    default_serving: str | None = Field(default=None, max_length=40)
    per100: Nutrients = Field(default_factory=Nutrients)
    liquid: bool = False  # labelled per 100 ml (1 ml ≈ 1 g)
    density: float | None = Field(default=None, ge=0.3, le=3, description="g per ml, for cup/spoon measures")
    source: Literal["custom", "off", "ai", "recipe", "copy"] = "custom"
    notes: str = Field(default="", max_length=500)
    created: str | None = Field(default=None, max_length=40)

    @field_validator("barcode")
    @classmethod
    def _digits(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = "".join(ch for ch in v if ch.isdigit())
        return v or None


EntrySource = Literal["food", "quick", "ai", "meal", "mealplan", "copy", "barcode", "online"]


class Portion(_SlimDefaults):
    """What was eaten: a food (or a free-text item) and how much. Empty /
    default fields aren't stored (see :class:`_SlimDefaults`)."""

    SLIM_FIELDS: ClassVar[tuple[str, ...]] = ("brand", "food_ref", "amount", "unit", "serving_id", "serving_label", "grams", "estimate")

    name: str = Field(min_length=1, max_length=120)
    brand: str = Field(default="", max_length=80)
    food_ref: str | None = Field(default=None, max_length=60)  # custom food id or "b:<slug>"
    amount: float = Field(default=1, gt=0, le=100_000)
    unit: Literal["g", "ml", "oz", "serving", "kcal", "cup", "tbsp", "tsp", "floz"] = "serving"
    serving_id: str | None = Field(default=None, max_length=40)
    serving_label: str = Field(default="", max_length=60)
    grams: float | None = Field(default=None, ge=0, le=100_000)
    n: Nutrients = Field(default_factory=Nutrients)  # totals for this portion
    estimate: bool = False


class Entry(Portion):
    SLIM_FIELDS: ClassVar[tuple[str, ...]] = (*Portion.SLIM_FIELDS, "source", "time", "note")

    id: str = Field(max_length=40)
    slot: str = Field(default="snacks", max_length=40)
    source: EntrySource = "food"
    time: str | None = Field(default=None, max_length=5)
    note: str = Field(default="", max_length=200)

    @field_validator("time")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        return v if v and TIME_RE.match(v) else None


class Day(BaseModel):
    entries: list[Entry] = Field(default_factory=list, max_length=80)
    water_ml: int = Field(default=0, ge=0, le=20_000)
    note: str = Field(default="", max_length=2000)
    complete: bool = False


class SavedMeal(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=80)
    slot: str | None = Field(default=None, max_length=40)
    items: list[Portion] = Field(default_factory=list, max_length=40)
    created: str | None = Field(default=None, max_length=40)


class WeighIn(BaseModel):
    date: str
    kg: float = Field(ge=20, le=400)

    @field_validator("date")
    @classmethod
    def _day(cls, v: str) -> str:
        if not DAY_RE.match(v):
            raise ValueError("date must be YYYY-MM-DD")
        return v


class MealSlot(BaseModel):
    """A meal of the day. The id is stable: renaming changes only ``name``,
    and removing a meal that has history only hides it (``hidden``) so past
    days still show those entries under it."""

    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=40)
    remind_at: str | None = Field(default=None, max_length=5)  # "HH:MM" local
    hidden: bool = False

    @field_validator("remind_at")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        return v if v and TIME_RE.match(v) else None


def default_slots() -> list[MealSlot]:
    return [
        MealSlot(id="breakfast", name="Breakfast"),
        MealSlot(id="lunch", name="Lunch"),
        MealSlot(id="dinner", name="Dinner"),
        MealSlot(id="snacks", name="Snacks"),
    ]


class Profile(BaseModel):
    onboarded: bool = False
    sex: Literal["male", "female"] | None = None
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    height_cm: float | None = Field(default=None, ge=90, le=250)
    weight_kg: float | None = Field(default=None, ge=25, le=350)
    activity: Literal["sedentary", "light", "moderate", "active", "very_active"] = "light"
    goal: Literal["lose", "maintain", "gain"] = "maintain"
    rate_pct: float = Field(default=0.5, ge=0, le=1.5, description="% of body weight per week")
    goal_weight_kg: float | None = Field(default=None, ge=25, le=350)
    diet_style: Literal["balanced", "high_protein", "low_carb", "keto", "low_fat"] = "balanced"
    protein_per_kg: float | None = Field(default=None, ge=0.6, le=3.3)
    diet_tags: list[str] = Field(default_factory=list, max_length=20)
    allergies: str = Field(default="", max_length=300)
    dislikes: str = Field(default="", max_length=300)

    @field_validator("diet_tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for t in v or []:
            t = str(t).strip().lower()[:30]
            if t and t not in out:
                out.append(t)
        return out


class DayTarget(BaseModel):
    """A weekday's override (anything left out uses the main target)."""

    kcal: float | None = Field(default=None, ge=0, le=15_000)
    protein: float | None = Field(default=None, ge=0, le=1000)
    carbs: float | None = Field(default=None, ge=0, le=2000)
    fat: float | None = Field(default=None, ge=0, le=1000)


class Targets(BaseModel):
    mode: Literal["auto", "custom"] = "auto"
    kcal: float = Field(default=2000, ge=0, le=15_000)
    protein: float = Field(default=120, ge=0, le=1000)
    carbs: float = Field(default=220, ge=0, le=2000)
    fat: float = Field(default=70, ge=0, le=1000)
    fibre: float = Field(default=30, ge=0, le=200)
    sodium: float = Field(default=2300, ge=0, le=20_000, description="mg, an upper limit")
    sugar: float | None = Field(default=None, ge=0, le=1000, description="g, optional upper limit")
    water_ml: int = Field(default=2000, ge=0, le=10_000)
    weekday: dict[str, DayTarget] = Field(default_factory=dict)
    # How the auto targets were made (for the UI's explanation).
    basis: dict[str, float | str | None] = Field(default_factory=dict)
    updated: str | None = Field(default=None, max_length=40)

    @field_validator("weekday")
    @classmethod
    def _days(cls, v: dict[str, DayTarget]) -> dict[str, DayTarget]:
        return {k: t for k, t in (v or {}).items() if k in WEEKDAYS}

    @field_validator("basis")
    @classmethod
    def _basis(cls, v: dict) -> dict:
        return dict(list((v or {}).items())[:30])


class Settings(BaseModel):
    energy_unit: Literal["kcal", "kJ"] = "kcal"
    weight_unit: Literal["kg", "lb"] = "kg"
    water_unit: Literal["ml", "floz"] = "ml"
    # Up to 8 shown meals plus hidden (removed, with history) ones.
    meal_slots: list[MealSlot] = Field(default_factory=default_slots, min_length=1, max_length=24)
    reminders: bool = False
    close_day_at: str | None = Field(default=None, max_length=5)
    water_step_ml: int = Field(default=250, ge=50, le=1000)
    show_micros: bool = True

    @field_validator("close_day_at")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        return v if v and TIME_RE.match(v) else None

    @model_validator(mode="after")
    def _unique_slots(self) -> "Settings":
        seen: set[str] = set()
        slots = []
        for s in self.meal_slots:
            if s.id not in seen:
                seen.add(s.id)
                slots.append(s)
        if not any(not s.hidden for s in slots):
            slots[0].hidden = False  # always at least one meal to log into
        if sum(1 for s in slots if not s.hidden) > MAX_VISIBLE_SLOTS:
            raise ValueError(f"at most {MAX_VISIBLE_SLOTS} meals a day")
        self.meal_slots = slots
        return self


class MealsData(BaseModel):
    profile: Profile = Field(default_factory=Profile)
    targets: Targets = Field(default_factory=Targets)
    settings: Settings = Field(default_factory=Settings)
    days: dict[str, Day] = Field(default_factory=dict, max_length=4000)
    foods: list[Food] = Field(default_factory=list, max_length=3000)
    favourites: list[str] = Field(default_factory=list, max_length=500)
    meals: list[SavedMeal] = Field(default_factory=list, max_length=300)
    weighins: list[WeighIn] = Field(default_factory=list, max_length=4000)

    @field_validator("days")
    @classmethod
    def _day_keys(cls, v: dict[str, Day]) -> dict[str, Day]:
        for k in v:
            if not DAY_RE.match(k):
                raise ValueError(f"day key {k!r} must be YYYY-MM-DD")
        return dict(sorted(v.items()))

    @field_validator("favourites")
    @classmethod
    def _favs(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for f in v or []:
            if isinstance(f, str) and f and len(f) <= 60 and f not in out:
                out.append(f)
        return out

    @field_validator("weighins")
    @classmethod
    def _weighins(cls, v: list[WeighIn]) -> list[WeighIn]:
        by_day: dict[str, WeighIn] = {}
        for w in v:
            by_day[w.date] = w  # last one for a day wins
        return [by_day[k] for k in sorted(by_day)]


def hydrate(data: dict) -> dict:
    """The file with every default filled in (the stored JSON leaves empty
    fields out) — what actions, ``to_text`` and the trends feed work on."""
    return MealsData.model_validate(data).model_dump(mode="json", context={"full": True})
