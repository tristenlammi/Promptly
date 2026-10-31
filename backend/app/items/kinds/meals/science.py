"""Nutrition maths: energy needs, targets, portions, and the adaptive TDEE.

* **BMR** — Mifflin-St Jeor (1990): 10·kg + 6.25·cm − 5·age + 5 (men) / −161
  (women); with no sex given, the midpoint (−78).
* **Activity** — the classic multipliers (1.2 sedentary … 1.9 very active).
* **Goal** — a weekly rate as % of body weight, at ~7700 kcal per kg of
  tissue; deficits capped at 25 % of TDEE, surpluses at 15 %, and never
  below a floor (1200 women / 1500 men / 1350 unspecified).
* **Protein** — 1.6–2.2 g/kg for active people (2.0 in a deficit), 1.2
  minimum for older adults; with BMI over 30 it's based on the weight at
  BMI 27 (so it isn't inflated by fat mass).
* **Fat** — the style's share of energy, never below 0.5 g/kg.
* **Fibre** — 14 g per 1000 kcal (Dietary Guidelines), 25–38 g.
* **Adaptive TDEE** — like MacroFactor: energy in minus the energy in the
  weight change. TDEE ≈ mean intake − (kg/day slope of the smoothed EWMA
  trend weight × 7700), over the last 2–4 weeks, counting only whole days
  (marked complete, or all main meals / ≥ 80 % of a typical day), blended
  with the formula when data is thin.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.items.kinds.meals.foods_db import builtin_foods
from app.items.kinds.meals.models import MACRO_KEYS, WEEKDAYS

KCAL_PER_KG = 7700.0
ACTIVITY = {"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725, "very_active": 1.9}
ACTIVITY_LABEL = {
    "sedentary": "Sedentary (desk job, little exercise)",
    "light": "Lightly active (1–3 sessions a week)",
    "moderate": "Moderately active (3–5 sessions a week)",
    "active": "Very active (6–7 sessions a week)",
    "very_active": "Extremely active (physical job + training)",
}
FLOOR = {"female": 1200, "male": 1500, None: 1350}
OZ = 28.3495
# Household measures (ml). A cup is the US 240 ml (the label says so).
HOUSEHOLD_ML = {"cup": 240.0, "tbsp": 15.0, "tsp": 5.0, "floz": 29.5735}
HOUSEHOLD_LABEL = {"cup": "cup (240 ml)", "tbsp": "tbsp (15 ml)", "tsp": "tsp (5 ml)", "floz": "fl oz"}


def density_of(food: dict | None) -> float | None:
    """Grams per ml, when a volume measure makes sense for the food: drinks
    (labelled per 100 ml, so 1), or a known density (oils, honey, milk…)."""
    if food is None:
        return 1.0  # a described item: the person's own estimate
    d = food.get("density")
    if isinstance(d, (int, float)) and d > 0:
        return float(d)
    if food.get("liquid"):
        return 1.0
    return None


# ------------------------------------------------------------------ energy


def age_of(profile: dict, today: date) -> int | None:
    by = profile.get("birth_year")
    return (today.year - int(by)) if by else None


def bmr(sex: str | None, age: int, height_cm: float, kg: float) -> float:
    s = 5 if sex == "male" else -161 if sex == "female" else -78
    return 10 * kg + 6.25 * height_cm - 5 * age + s


def formula_tdee(profile: dict, today: date, kg: float | None = None) -> dict | None:
    """BMR × activity, or None when the profile lacks height/weight/age."""
    kg = kg or profile.get("weight_kg")
    age = age_of(profile, today)
    h = profile.get("height_cm")
    if not (kg and age and h):
        return None
    b = bmr(profile.get("sex"), age, float(h), float(kg))
    mult = ACTIVITY.get(profile.get("activity") or "light", 1.375)
    return {"bmr": round(b), "multiplier": mult, "tdee": round(b * mult)}


def goal_delta(profile: dict, kg: float, tdee: float) -> tuple[float, list[str]]:
    """Daily kcal change for the goal (negative = deficit), and notes."""
    notes: list[str] = []
    goal = profile.get("goal") or "maintain"
    rate = float(profile.get("rate_pct") or 0)
    if goal == "maintain" or rate <= 0:
        return 0.0, notes
    if goal == "lose":
        if rate > 1.0:
            notes.append("Rate capped at 1% of body weight a week — faster loss costs muscle and is hard to sustain.")
            rate = 1.0
        d = kg * rate / 100 * KCAL_PER_KG / 7
        cap = 0.25 * tdee
        if d > cap:
            notes.append("Deficit capped at 25% of maintenance.")
            d = cap
        return -d, notes
    if rate > 0.5:
        notes.append("Gain rate capped at 0.5% a week — beyond that, most of the extra is fat.")
        rate = 0.5
    d = kg * rate / 100 * KCAL_PER_KG / 7
    cap = 0.15 * tdee
    if d > cap:
        d = cap
    return d, notes


def _round10(x: float) -> float:
    return float(int(round(x / 10.0)) * 10)


def compute_targets(profile: dict, today: date, *, tdee_override: float | None = None) -> dict:
    """Targets from a profile (raises ValueError when it's incomplete)."""
    kg = profile.get("weight_kg")
    f = formula_tdee(profile, today)
    if tdee_override is None and f is None:
        missing = [k for k, v in (("weight", kg), ("height", profile.get("height_cm")), ("birth year", profile.get("birth_year"))) if not v]
        raise ValueError(f"I need your {', '.join(missing)} to work out targets.")
    if not kg:
        raise ValueError("I need your weight to work out targets.")
    kg = float(kg)
    tdee = float(tdee_override) if tdee_override else float(f["tdee"])  # type: ignore[index]
    delta, notes = goal_delta(profile, kg, tdee)
    sex = profile.get("sex")
    floor = FLOOR.get(sex, 1350)
    kcal = tdee + delta
    if kcal < floor:
        notes.append(f"Raised to a {floor} kcal floor — going lower needs medical supervision.")
        kcal = floor
    kcal = _round10(kcal)

    age = age_of(profile, today) or 35
    goal = profile.get("goal") or "maintain"
    activity = profile.get("activity") or "light"
    style = profile.get("diet_style") or "balanced"
    if profile.get("protein_per_kg"):
        ppk = float(profile["protein_per_kg"])
    else:
        ppk = {"lose": 2.0, "maintain": 1.6, "gain": 1.8}[goal]
        if activity == "sedentary" and goal == "maintain":
            ppk = 1.2
        if style == "high_protein":
            ppk = max(ppk, 2.2)
    if age >= 65:
        ppk = max(ppk, 1.2)
    ref_kg = kg
    h = profile.get("height_cm")
    if h:
        m = float(h) / 100
        if kg / (m * m) > 30:
            ref_kg = 27 * m * m
            notes.append("Protein is based on a reference weight (BMI 27), not total weight.")
    protein = round(ref_kg * ppk)
    fat_min = 0.5 * kg
    if style == "keto":
        carbs = 30.0
        fat = max((kcal - protein * 4 - carbs * 4) / 9, fat_min)
    elif style == "low_carb":
        carbs = min(100.0, max(0.0, (kcal - protein * 4 - fat_min * 9) / 4))
        fat = max((kcal - protein * 4 - carbs * 4) / 9, fat_min)
    else:
        share = 0.20 if style == "low_fat" else 0.30
        fat = max(kcal * share / 9, fat_min)
        carbs = (kcal - protein * 4 - fat * 9) / 4
    if carbs < 0:
        carbs = 0.0
        protein = max(round((kcal - fat * 9) / 4), round(kg * 1.2))
    fibre = min(38.0, max(25.0, round(kcal / 1000 * 14)))
    water = int(min(4000, max(1500, round(kg * 35 / 50) * 50)))
    return {
        "kcal": kcal,
        "protein": float(round(protein)),
        "carbs": float(round(carbs)),
        "fat": float(round(fat)),
        "fibre": float(fibre),
        "water_ml": water,
        "basis": {
            "bmr": f["bmr"] if f else None,
            "multiplier": f["multiplier"] if f else None,
            "tdee": round(tdee),
            "tdee_source": "adaptive" if tdee_override else "formula",
            "delta": round(delta),
            "protein_per_kg": round(ppk, 2),
            "style": style,
            "notes": " ".join(notes) or None,
        },
    }


def targets_for(targets: dict, day: str) -> dict:
    """The day's targets: the main ones with its weekday override applied."""
    out = {k: targets.get(k) for k in ("kcal", "protein", "carbs", "fat", "fibre", "sodium", "sugar", "water_ml")}
    try:
        wd = WEEKDAYS[date.fromisoformat(day).weekday()]
    except ValueError:
        return out
    over = (targets.get("weekday") or {}).get(wd) or {}
    for k in ("kcal", "protein", "carbs", "fat"):
        if over.get(k) is not None:
            out[k] = over[k]
    return out


# ---------------------------------------------------------------- portions


def resolve_food(data: dict, ref: str | None) -> dict | None:
    if not ref:
        return None
    if ref.startswith("b:"):
        return builtin_foods().get(ref)
    return next((f for f in data.get("foods", []) if f["id"] == ref), None)


def serving_of(food: dict, serving_id: str | None) -> dict | None:
    servings = food.get("servings") or []
    if serving_id:
        s = next((s for s in servings if s["id"] == serving_id), None)
        if s:
            return s
    if food.get("default_serving"):
        s = next((s for s in servings if s["id"] == food["default_serving"]), None)
        if s:
            return s
    return servings[0] if servings else None


def grams_for(food: dict | None, amount: float, unit: str, serving_id: str | None) -> tuple[float | None, str]:
    """(grams, serving label) for an amount of a food."""
    if unit == "ml" and food is not None and isinstance(food.get("density"), (int, float)) and food["density"] > 0:
        return amount * float(food["density"]), ""
    if unit in ("g", "ml"):
        return amount, ""
    if unit == "oz":
        return amount * OZ, ""
    if unit in HOUSEHOLD_ML:
        dens = density_of(food)
        if dens is None:
            return None, ""
        return amount * HOUSEHOLD_ML[unit] * dens, HOUSEHOLD_LABEL[unit]
    if unit == "serving" and food is not None:
        s = serving_of(food, serving_id)
        if s:
            return amount * float(s["grams"]), s["label"]
        return amount * 100.0, "100 g"
    return None, ""


def scale(per100: dict, grams: float) -> dict:
    f = grams / 100.0
    out: dict[str, Any] = {k: round(float(per100.get(k) or 0) * f, 1) for k in MACRO_KEYS}
    out["micros"] = {k: round(float(v) * f, 2) for k, v in (per100.get("micros") or {}).items()}
    return out


def scale_totals(n: dict, factor: float) -> dict:
    out: dict[str, Any] = {k: round(float(n.get(k) or 0) * factor, 1) for k in MACRO_KEYS}
    out["micros"] = {k: round(float(v) * factor, 2) for k, v in (n.get("micros") or {}).items()}
    return out


def add(a: dict, b: dict) -> dict:
    out: dict[str, Any] = {k: round(float(a.get(k) or 0) + float(b.get(k) or 0), 1) for k in MACRO_KEYS}
    micros = dict(a.get("micros") or {})
    for k, v in (b.get("micros") or {}).items():
        micros[k] = round(float(micros.get(k, 0)) + float(v), 2)
    out["micros"] = micros
    return out


def zero() -> dict:
    return {**{k: 0.0 for k in MACRO_KEYS}, "micros": {}}


def total(entries: list[dict]) -> dict:
    t = zero()
    for e in entries:
        t = add(t, e.get("n") or {})
    return t


def kcal_from_macros(protein: float, carbs: float, fat: float, alcohol: float = 0) -> float:
    return round(protein * 4 + carbs * 4 + fat * 9 + alcohol * 7, 1)


# ------------------------------------------------------------- weight data


def _day_of(v: Any) -> str | None:
    if not isinstance(v, str) or len(v) < 10:
        return None
    s = v[:10]
    try:
        date.fromisoformat(s)
    except ValueError:
        return None
    return s


_KG_KEYS = ("weight_kg", "kg", "body_weight_kg", "bodyweight_kg", "weight", "body_weight", "bodyweight")
_DATE_KEYS = ("date", "day", "at", "time", "ts", "when", "measured_at", "logged_at")


def _kg_from(item: dict, in_weight_list: bool) -> float | None:
    unit = str(item.get("unit") or item.get("units") or "kg").lower()
    for k in _KG_KEYS:
        v = item.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            kg = float(v) * (0.45359237 if (unit in ("lb", "lbs") and not k.endswith("kg")) else 1)
            return kg
    kind = str(item.get("metric") or item.get("type") or item.get("kind") or item.get("key") or "").lower()
    if ("weight" in kind or in_weight_list) and isinstance(item.get("value"), (int, float)):
        return float(item["value"]) * (0.45359237 if unit in ("lb", "lbs") else 1)
    return None


def weights_from_health(health: Any) -> list[tuple[str, float]]:
    """Weigh-ins from a Body & Health file, whatever its exact shape: any
    list of records with a day and a weight (``weight_kg`` / ``kg`` /
    ``{"metric": "weight", "value"}``…), or a ``{day: {...}}`` map."""
    found: dict[str, list[float]] = {}

    def take(item: dict, in_weight_list: bool, day_hint: str | None = None) -> None:
        day = day_hint
        if day is None:
            for k in _DATE_KEYS:
                day = _day_of(item.get(k))
                if day:
                    break
        if not day:
            return
        kg = _kg_from(item, in_weight_list)
        if kg is not None and 20 <= kg <= 400:
            found.setdefault(day, []).append(kg)

    def walk(node: Any, depth: int, key: str) -> None:
        if depth > 5:
            return
        weighty = "weigh" in key.lower()
        if isinstance(node, list):
            for it in node[:20000]:
                if isinstance(it, dict):
                    take(it, weighty)
                    for k, v in it.items():
                        if isinstance(v, (list, dict)):
                            walk(v, depth + 1, k)
        elif isinstance(node, dict):
            for k, v in node.items():
                if _day_of(k) and isinstance(v, dict):
                    take(v, weighty, _day_of(k))
                elif _day_of(k) and weighty and isinstance(v, (int, float)):
                    if 20 <= float(v) <= 400:
                        found.setdefault(k[:10], []).append(float(v))
                elif isinstance(v, (list, dict)):
                    walk(v, depth + 1, k)

    walk(health, 0, "")
    return sorted((d, round(sum(v) / len(v), 2)) for d, v in found.items())


def merge_weights(*series: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Later series win on the same day."""
    by: dict[str, float] = {}
    for s in series:
        for d, kg in s:
            by[d] = kg
    return sorted(by.items())


def trend(weights: list[tuple[str, float]], alpha: float = 0.1) -> list[tuple[str, float]]:
    """A daily exponentially smoothed trend weight (Hacker's Diet), with
    straight-line interpolation over days without a weigh-in."""
    if not weights:
        return []
    days = [(date.fromisoformat(d), kg) for d, kg in weights]
    out: list[tuple[str, float]] = []
    t = days[0][1]
    for i, (d, kg) in enumerate(days):
        if i == 0:
            out.append((d.isoformat(), round(t, 2)))
            continue
        pd, pkg = days[i - 1]
        gap = (d - pd).days
        for j in range(1, gap + 1):
            x = pkg + (kg - pkg) * j / gap
            t = t + alpha * (x - t)
            out.append(((pd + timedelta(days=j)).isoformat(), round(t, 2)))
    return out


def _slope(points: list[tuple[float, float]]) -> float | None:
    n = len(points)
    if n < 2:
        return None
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    den = sum((p[0] - mx) ** 2 for p in points)
    if den == 0:
        return None
    return sum((p[0] - mx) * (p[1] - my) for p in points) / den


def day_kcal(data: dict) -> dict[str, float]:
    return {d: round(sum((e.get("n") or {}).get("kcal") or 0 for e in day.get("entries", [])), 1) for d, day in (data.get("days") or {}).items()}


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def main_slots(data: dict) -> set[str]:
    """The day's main meals: the shown slots that aren't snacks."""
    slots = [s for s in (data.get("settings") or {}).get("meal_slots") or [] if not s.get("hidden")]
    main = {s["id"] for s in slots if "snack" not in s["id"].lower() and "snack" not in str(s.get("name", "")).lower()}
    return main or {s["id"] for s in slots}


def typical_day_kcal(data: dict, end: date, lookback: int = 60) -> float | None:
    """A typical fully logged day's intake: the median of the last
    ``lookback`` days marked complete (or, with fewer than 3 of those, of
    days with every main meal logged too)."""
    days = data.get("days") or {}
    start = (end - timedelta(days=lookback)).isoformat()
    main = main_slots(data)
    complete: list[float] = []
    full: list[float] = []
    for d, day in days.items():
        if not (start <= d <= end.isoformat()) or not day.get("entries"):
            continue
        kcal = sum((e.get("n") or {}).get("kcal") or 0 for e in day["entries"])
        if day.get("complete"):
            complete.append(kcal)
        elif main <= {e.get("slot") for e in day["entries"]}:
            full.append(kcal)
    if len(complete) >= 3:
        return _median(complete)
    return _median(complete + full) if len(complete) + len(full) >= 3 else None


def day_is_whole(data: dict, day: dict, kcal: float, typical: float | None, target: float) -> bool:
    """Whether a day's log can be trusted as the whole day's intake: marked
    complete; or every main meal logged and at least 60 % of a typical day;
    or at least 80 % of a typical day (the target when there's no history)."""
    if day.get("complete"):
        return True
    ref = typical or target
    if main_slots(data) <= {e.get("slot") for e in day.get("entries", [])} and kcal >= 0.6 * ref:
        return True
    return kcal >= 0.8 * ref


def _theil_sen(points: list[tuple[float, float]]) -> float | None:
    """The median of pairwise slopes: robust to a one-off salty-day spike."""
    slopes = [
        (y2 - y1) / (x2 - x1)
        for i, (x1, y1) in enumerate(points)
        for x2, y2 in points[i + 1:]
        if x2 != x1
    ]
    return _median(slopes)


def trend_slope(weights: list[tuple[str, float]], start: date, end: date) -> tuple[float | None, str | None]:
    """kg/day over ``start..end`` from the smoothed trend weight (EWMA, the
    Hacker's Diet method), fitted on the daily trend rather than raw
    weigh-ins so water swings don't steer it. The EWMA needs warming up (10+
    days of weigh-ins before ``start``); without that it lags, so this falls
    back to a robust (Theil-Sen) slope over the raw weigh-ins in the window."""
    upto = [(d, kg) for d, kg in weights if d <= end.isoformat()]
    if not upto:
        return None, None
    first = date.fromisoformat(upto[0][0])
    if (start - first).days >= 10:
        tr = trend(upto)
        pts = [((date.fromisoformat(d) - start).days, kg) for d, kg in tr if start.isoformat() <= d <= end.isoformat()]
        if len(pts) >= 7:
            return _slope(pts), "trend"
    raw = [((date.fromisoformat(d) - start).days, kg) for d, kg in upto if d >= start.isoformat()]
    return _theil_sen(raw), "robust"


def estimate_tdee(
    data: dict,
    weights: list[tuple[str, float]],
    today: date,
    window: int = 21,
) -> dict:
    """The adaptive expenditure estimate (see the module docstring).

    Only whole days count (``day_is_whole``): a forgotten dinner would
    otherwise read as a deficit and drag the estimate down. Weight change is
    the slope of the smoothed trend (``trend_slope``)."""
    window = max(14, min(28, int(window)))
    days = data.get("days") or {}
    end = today if (days.get(today.isoformat()) or {}).get("complete") else today - timedelta(days=1)
    start = end - timedelta(days=window - 1)
    targets = data.get("targets") or {}
    typical = typical_day_kcal(data, end)
    logged: list[tuple[str, float]] = []
    skipped = 0
    for i in range(window):
        d = (start + timedelta(days=i)).isoformat()
        day = days.get(d)
        if not day or not day.get("entries"):
            continue
        kcal = sum((e.get("n") or {}).get("kcal") or 0 for e in day["entries"])
        tgt = float(targets_for(targets, d).get("kcal") or 2000)
        if not day_is_whole(data, day, kcal, typical, tgt):
            skipped += 1  # probably a partly logged day
            continue
        logged.append((d, kcal))
    pts = [((date.fromisoformat(d) - start).days, kg) for d, kg in weights if start.isoformat() <= d <= end.isoformat()]
    span = (max(p[0] for p in pts) - min(p[0] for p in pts)) if len(pts) >= 2 else 0
    latest_kg = weights[-1][1] if weights else data.get("profile", {}).get("weight_kg")
    f = formula_tdee(data.get("profile") or {}, today, latest_kg)
    avg_intake = round(sum(k for _, k in logged) / len(logged)) if logged else None
    slope, method = trend_slope(weights, start, end) if len(pts) >= 3 and span >= 7 else (None, None)
    out: dict[str, Any] = {
        "window_days": window,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "logged_days": len(logged),
        "partial_days_skipped": skipped,
        "typical_day_kcal": round(typical) if typical else None,
        "weigh_ins": len(pts),
        "avg_intake_kcal": avg_intake,
        "weight_change_kg_per_week": round(slope * 7, 2) if slope is not None else None,
        "weight_method": method,
        "formula_tdee": f["tdee"] if f else None,
        "latest_weight_kg": latest_kg,
    }
    if avg_intake is None or slope is None or len(logged) < 7:
        need = []
        if len(logged) < 7:
            need.append(f"{7 - len(logged)} more fully logged day(s)")
        if slope is None:
            need.append("at least 3 weigh-ins spread over a week or more")
        out.update(
            adaptive_tdee=None,
            tdee=f["tdee"] if f else None,
            confidence="none",
            source="formula" if f else None,
            needs=need,
        )
        return out
    adaptive = avg_intake - slope * KCAL_PER_KG
    adaptive = max(1000.0, min(6000.0, adaptive))
    w = min(1.0, len(logged) / (0.8 * window)) * min(1.0, len(pts) / 8)
    blended = w * adaptive + (1 - w) * f["tdee"] if f else adaptive
    out.update(
        adaptive_tdee=round(adaptive),
        tdee=round(blended),
        confidence="high" if w >= 0.75 else "medium" if w >= 0.4 else "low",
        source="adaptive" if not f or w >= 0.999 else "blended",
        needs=[],
    )
    return out
