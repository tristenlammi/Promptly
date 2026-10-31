"""Units: aliases, conversion, scaling with sensible rounding, formatting.

Ingredients store a canonical unit key (``g``, ``tbsp``, ``clove``…) or ``""``
for a plain count ("2 onions"). Mass and volume convert through a base
(grams / millilitres); everything else is a *count unit* that only sums
with itself.

The frontend has a port of :func:`present` / :func:`fmt_qty`
(``frontend/src/items/kinds/mealplan/units.ts``) for live scaling — keep
the two in step.
"""
from __future__ import annotations

import math
from typing import Literal

System = Literal["metric", "imperial"]

# key: (dimension, factor to base, singular, plural, system)
#   dimension "mass" → grams, "volume" → millilitres, "count" → itself.
#   system "both" = spoons, used everywhere.
UNITS: dict[str, tuple[str, float, str, str, str]] = {
    "mg": ("mass", 0.001, "mg", "mg", "metric"),
    "g": ("mass", 1.0, "g", "g", "metric"),
    "kg": ("mass", 1000.0, "kg", "kg", "metric"),
    "oz": ("mass", 28.3495, "oz", "oz", "imperial"),
    "lb": ("mass", 453.592, "lb", "lb", "imperial"),
    "ml": ("volume", 1.0, "ml", "ml", "metric"),
    "cl": ("volume", 10.0, "cl", "cl", "metric"),
    "dl": ("volume", 100.0, "dl", "dl", "metric"),
    "l": ("volume", 1000.0, "l", "l", "metric"),
    "tsp": ("volume", 4.92892, "tsp", "tsp", "both"),
    "tbsp": ("volume", 14.7868, "tbsp", "tbsp", "both"),
    "floz": ("volume", 29.5735, "fl oz", "fl oz", "imperial"),
    "cup": ("volume", 236.588, "cup", "cups", "imperial"),
    "pint": ("volume", 473.176, "pint", "pints", "imperial"),
    "quart": ("volume", 946.353, "quart", "quarts", "imperial"),
    "gallon": ("volume", 3785.41, "gallon", "gallons", "imperial"),
}
COUNT_UNITS: dict[str, tuple[str, str]] = {
    "pinch": ("pinch", "pinches"),
    "dash": ("dash", "dashes"),
    "drop": ("drop", "drops"),
    "clove": ("clove", "cloves"),
    "can": ("can", "cans"),
    "jar": ("jar", "jars"),
    "bottle": ("bottle", "bottles"),
    "package": ("pack", "packs"),
    "bag": ("bag", "bags"),
    "box": ("box", "boxes"),
    "slice": ("slice", "slices"),
    "bunch": ("bunch", "bunches"),
    "sprig": ("sprig", "sprigs"),
    "head": ("head", "heads"),
    "stalk": ("stalk", "stalks"),
    "stick": ("stick", "sticks"),
    "piece": ("piece", "pieces"),
    "handful": ("handful", "handfuls"),
    "fillet": ("fillet", "fillets"),
    "sheet": ("sheet", "sheets"),
    "leaf": ("leaf", "leaves"),
    "cube": ("cube", "cubes"),
    "scoop": ("scoop", "scoops"),
    "sachet": ("sachet", "sachets"),
    "rasher": ("rasher", "rashers"),
    "knob": ("knob", "knobs"),
    "ear": ("ear", "ears"),
    "loaf": ("loaf", "loaves"),
    "dozen": ("dozen", "dozen"),
    "serving": ("serving", "servings"),
}

# Alias → key. Matched case-insensitively except the two one-letter
# spoons ("T" = tablespoon, "t" = teaspoon), handled in :func:`unit_key`.
_ALIASES: dict[str, str] = {
    "milligram": "mg", "milligrams": "mg", "milligramme": "mg", "mg": "mg",
    "g": "g", "gr": "g", "grs": "g", "gram": "g", "grams": "g", "gramme": "g", "grammes": "g", "gm": "g", "gms": "g",
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg", "kilogramme": "kg",
    "oz": "oz", "ozs": "oz", "ounce": "oz", "ounces": "oz",
    "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb", "#": "lb",
    "ml": "ml", "mls": "ml", "milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "millilitres": "ml", "cc": "ml",
    "cl": "cl", "centiliter": "cl", "centilitre": "cl", "centiliters": "cl", "centilitres": "cl",
    "dl": "dl", "deciliter": "dl", "decilitre": "dl", "deciliters": "dl", "decilitres": "dl",
    "l": "l", "lt": "l", "ltr": "l", "liter": "l", "liters": "l", "litre": "l", "litres": "l",
    "tsp": "tsp", "tsps": "tsp", "teaspoon": "tsp", "teaspoons": "tsp", "tspn": "tsp", "teasp": "tsp",
    "tbsp": "tbsp", "tbsps": "tbsp", "tbs": "tbsp", "tbl": "tbsp", "tbls": "tbsp", "tblsp": "tbsp", "tblspn": "tbsp",
    "tablespoon": "tbsp", "tablespoons": "tbsp", "tbspn": "tbsp",
    "fl oz": "floz", "floz": "floz", "fl. oz": "floz", "fluid ounce": "floz", "fluid ounces": "floz", "fl oz.": "floz",
    "cup": "cup", "cups": "cup", "c": "cup", "cp": "cup",
    "pint": "pint", "pints": "pint", "pt": "pint", "pts": "pint",
    "quart": "quart", "quarts": "quart", "qt": "quart", "qts": "quart",
    "gallon": "gallon", "gallons": "gallon", "gal": "gallon", "gals": "gallon",
    "pinch": "pinch", "pinches": "pinch",
    "dash": "dash", "dashes": "dash",
    "drop": "drop", "drops": "drop",
    "clove": "clove", "cloves": "clove",
    "can": "can", "cans": "can", "tin": "can", "tins": "can",
    "jar": "jar", "jars": "jar",
    "bottle": "bottle", "bottles": "bottle",
    "package": "package", "packages": "package", "pkg": "package", "pkgs": "package", "pack": "package",
    "packs": "package", "packet": "package", "packets": "package", "punnet": "package", "punnets": "package",
    "bag": "bag", "bags": "bag",
    "box": "box", "boxes": "box",
    "slice": "slice", "slices": "slice",
    "bunch": "bunch", "bunches": "bunch",
    "sprig": "sprig", "sprigs": "sprig",
    "head": "head", "heads": "head",
    "stalk": "stalk", "stalks": "stalk", "rib": "stalk", "ribs": "stalk",
    "stick": "stick", "sticks": "stick",
    "piece": "piece", "pieces": "piece", "pc": "piece", "pcs": "piece",
    "handful": "handful", "handfuls": "handful",
    "fillet": "fillet", "fillets": "fillet", "filet": "fillet", "filets": "fillet",
    "sheet": "sheet", "sheets": "sheet",
    "leaf": "leaf", "leaves": "leaf",
    "cube": "cube", "cubes": "cube",
    "scoop": "scoop", "scoops": "scoop",
    "sachet": "sachet", "sachets": "sachet", "envelope": "sachet", "envelopes": "sachet",
    "rasher": "rasher", "rashers": "rasher",
    "knob": "knob", "knobs": "knob",
    "ear": "ear", "ears": "ear",
    "loaf": "loaf", "loaves": "loaf",
    "dozen": "dozen",
    "serving": "serving", "servings": "serving",
}
# Longest first, so "fl oz" beats "fl" and "tablespoons" beats "tablespoon".
ALIASES_BY_LENGTH = sorted(_ALIASES, key=len, reverse=True)


def unit_key(raw: str | None) -> str:
    """The canonical key for a unit as written, or "" for none. Unknown
    units come back lowercased as they are ("envelope" is known; "punnet"
    too; "thingy" stays "thingy")."""
    s = (raw or "").strip().rstrip(".")
    if not s:
        return ""
    if s == "T" or s == "Tb" or s == "TB":
        return "tbsp"
    if s == "t":
        return "tsp"
    low = " ".join(s.lower().replace(".", " ").split())
    if low in _ALIASES:
        return _ALIASES[low]
    if low in UNITS or low in COUNT_UNITS:
        return low
    return low[:20]


def dimension(unit: str) -> str:
    if unit in UNITS:
        return UNITS[unit][0]
    return "count"


def to_base(qty: float, unit: str) -> float:
    """``qty`` of ``unit`` in grams / millilitres (counts unchanged)."""
    if unit in UNITS:
        return qty * UNITS[unit][1]
    return qty


def unit_label(unit: str, qty: float | None) -> str:
    if not unit:
        return ""
    plural = qty is not None and qty > 1 + 1e-9
    if unit in UNITS:
        _d, _f, one, many, _s = UNITS[unit]
        return many if plural else one
    if unit in COUNT_UNITS:
        one, many = COUNT_UNITS[unit]
        return many if plural else one
    return unit


# ------------------------------------------------------------------ rounding

_FRACTIONS = [(0.0, ""), (0.125, "⅛"), (0.25, "¼"), (1 / 3, "⅓"), (0.375, "⅜"), (0.5, "½"),
              (0.625, "⅝"), (2 / 3, "⅔"), (0.75, "¾"), (0.875, "⅞"), (1.0, "")]
_COMMON = [0.0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1.0]


def round_fraction(x: float, fine: bool = False) -> float:
    """Round to a kitchen fraction: quarters / thirds (eighths when
    ``fine``); whole numbers above 10."""
    if x <= 0:
        return 0.0
    if x >= 10:
        return float(round(x))
    whole = math.floor(x)
    frac = x - whole
    opts = [f for f, _ in _FRACTIONS] if fine else _COMMON
    best = min(opts, key=lambda f: abs(f - frac))
    out = whole + best
    if out == 0:
        out = opts[1]  # never round a real amount away to nothing
    return out


def round_metric(x: float) -> float:
    """Sensible metric rounding: 1 g/ml under 100, 5 under 250, 10 under 1000."""
    if x <= 0:
        return 0.0
    if x < 1:
        return round(x, 1) or 0.1
    if x < 10:
        return round(x * 2) / 2
    if x < 100:
        return float(round(x))
    if x < 250:
        return float(round(x / 5) * 5)
    if x < 1000:
        return float(round(x / 10) * 10)
    return float(round(x / 50) * 50)


def fmt_number(x: float) -> str:
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return f"{x:.2f}".rstrip("0").rstrip(".")


def fmt_fraction(x: float) -> str:
    """1.5 → "1 ½", 0.333 → "⅓", 2 → "2"."""
    if x <= 0:
        return "0"
    whole = math.floor(x + 1e-9)
    frac = x - whole
    glyph = ""
    for f, g in _FRACTIONS:
        if abs(frac - f) < 0.02:
            if f == 1.0:
                whole += 1
            glyph = g
            break
    else:
        return fmt_number(round(x, 2))
    if whole and glyph:
        return f"{whole} {glyph}"
    if glyph:
        return glyph
    return str(whole)


def fmt_qty(qty: float | None, unit: str, qty_max: float | None = None) -> str:
    """The amount as a cook writes it: "250 g", "1 ½ cups", "2–3"."""
    if qty is None:
        return ""
    metric = unit in UNITS and UNITS[unit][4] == "metric"
    f = fmt_number if metric else fmt_fraction
    num = f(qty)
    if qty_max is not None and qty_max > qty:
        num = f"{num}–{f(qty_max)}"
    lab = unit_label(unit, qty_max if qty_max is not None else qty)
    return f"{num} {lab}".strip()


# --------------------------------------------------------------- presenting


def _best_metric(base: float, dim: str) -> tuple[float, str]:
    if dim == "mass":
        if base >= 1000:
            return round(base / 1000 * 20) / 20, "kg"
        return round_metric(base), "g"
    if base >= 1000:
        return round(base / 1000 * 20) / 20, "l"
    return round_metric(base), "ml"


def _best_imperial_volume(base: float) -> tuple[float, str]:
    cup = UNITS["cup"][1]
    tbsp = UNITS["tbsp"][1]
    tsp = UNITS["tsp"][1]
    if base >= cup / 4 - 0.5:
        return round_fraction(base / cup), "cup"
    if base >= tbsp - 0.2:
        return round_fraction(base / tbsp), "tbsp"
    return round_fraction(base / tsp, fine=True), "tsp"


def _best_imperial_mass(base: float) -> tuple[float, str]:
    lb = UNITS["lb"][1]
    if base >= lb - 1:
        return round(base / lb * 4) / 4, "lb"
    oz = base / UNITS["oz"][1]
    return (round(oz * 2) / 2 if oz < 10 else float(round(oz))) or 0.5, "oz"


WHOLE_ONLY = ("egg", "lemon", "lime", "avocado", "orange", "apple", "banana", "tortilla", "bun", "roll")


def round_count(qty: float, item: str = "") -> float:
    low = item.lower()
    if any(w in low for w in WHOLE_ONLY):
        return float(max(1, round(qty)))
    if qty >= 5:
        return float(round(qty))
    return round_fraction(qty)


def present(qty: float, unit: str, system: str = "keep", item: str = "") -> tuple[float, str]:
    """``qty`` ``unit`` rounded and in sensible units for ``system``
    ("keep" = the recipe's own system, "metric", "imperial")."""
    if qty is None:
        return qty, unit
    dim = dimension(unit)
    if dim == "count":
        if unit in ("", "piece") or unit not in COUNT_UNITS:
            return round_count(qty, item), unit
        return round_fraction(qty), unit
    base = to_base(qty, unit)
    own = UNITS[unit][4]
    if dim == "mass":
        target = own if system == "keep" else system
        return _best_metric(base, dim) if target == "metric" else _best_imperial_mass(base)
    # volume
    if unit in ("tsp", "tbsp"):
        if system == "metric" and base >= 58:
            return _best_metric(base, dim)
        return _best_imperial_volume(base)
    if own == "metric":
        return _best_imperial_volume(base) if system == "imperial" else _best_metric(base, dim)
    if system == "metric":
        return _best_metric(base, dim)
    if unit == "cup":
        return _best_imperial_volume(base)
    return round_fraction(qty), unit


def _round_in(value: float, unit: str, item: str = "") -> float:
    if unit in UNITS and UNITS[unit][4] == "metric":
        return round(value / 1000 * 20) / 20 if unit in ("kg", "l") else round_metric(value)
    if unit == "lb":
        return round(value * 4) / 4
    if unit == "oz":
        return round(value * 2) / 2 if value < 10 else float(round(value))
    if unit in UNITS:
        return round_fraction(value, fine=unit == "tsp")
    return round_count(value, item) if unit in ("", "piece") or unit not in COUNT_UNITS else round_fraction(value)


def present_base(base: float, dim: str, system: str, prefer_spoons: bool = False) -> tuple[float, str]:
    """A summed base amount (grams / ml) in the person's system — the
    grocery list's amounts."""
    if dim == "mass":
        return _best_metric(base, dim) if system == "metric" else _best_imperial_mass(base)
    if prefer_spoons and base < 60:
        return _best_imperial_volume(base)
    return _best_metric(base, dim) if system == "metric" else _best_imperial_volume(base)


def scale_line(ing: dict, factor: float, system: str = "keep") -> dict:
    """One structured ingredient scaled by ``factor`` and presented."""
    out = dict(ing)
    q = ing.get("qty")
    if q is None:
        return out
    unit = ing.get("unit") or ""
    item = ing.get("item", "")
    nq, nu = present(q * factor, unit, system, item)
    out["qty"], out["unit"] = nq, nu
    qm = ing.get("qty_max")
    if qm is not None:
        raw = qm * factor
        if nu != unit and nu in UNITS and unit in UNITS:
            raw = to_base(raw, unit) / UNITS[nu][1]
        mq = _round_in(raw, nu, item)
        out["qty_max"] = mq if mq > nq else None
    return out


def ingredient_text(ing: dict) -> str:
    """"1 ½ cups flour, sifted (optional)"."""
    amt = fmt_qty(ing.get("qty"), ing.get("unit") or "", ing.get("qty_max"))
    item = ing.get("item", "")
    s = f"{amt} {item}".strip()
    if ing.get("note"):
        s += f", {ing['note']}"
    if ing.get("optional") and "optional" not in s.lower():
        s += " (optional)"
    return s
