"""The numbers behind Body & Health: the metric catalogue, unit conversion,
daily series, the smoothed trend, regression, correlation and the recognised
reference ranges (AHA blood pressure, WHO BMI, ADA glucose…).

Pure functions over plain dicts — shared by the actions, ``to_text`` and the
reminders, and mirrored in the frontend (``metrics.ts``).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

# --------------------------------------------------------------- catalogue


@dataclass(frozen=True)
class Metric:
    id: str
    label: str
    unit: str  # canonical
    dim: str  # weight / length / glucose / temp / water / none
    agg: str  # how a day's readings combine: avg / sum / last / max / min
    decimals: int
    lo: float
    hi: float
    higher_is_better: bool | None = None
    smooth: bool = False  # show an EWMA trend (weight-like, noisy)


BUILTIN: dict[str, Metric] = {
    m.id: m
    for m in [
        Metric("weight", "Weight", "kg", "weight", "avg", 1, 2, 400, None, True),
        Metric("body_fat", "Body fat", "%", "none", "avg", 1, 2, 75, None, True),
        Metric("waist", "Waist", "cm", "length", "last", 1, 10, 300, None, True),
        Metric("hip", "Hips", "cm", "length", "last", 1, 10, 300, None, True),
        Metric("chest", "Chest", "cm", "length", "last", 1, 10, 300, None, True),
        Metric("arm", "Arm", "cm", "length", "last", 1, 5, 150, None, True),
        Metric("thigh", "Thigh", "cm", "length", "last", 1, 10, 200, None, True),
        Metric("bp", "Blood pressure", "mmHg", "none", "avg", 0, 40, 320),
        Metric("resting_hr", "Resting heart rate", "bpm", "none", "avg", 0, 20, 250, False, True),
        Metric("glucose", "Blood glucose", "mmol/L", "glucose", "avg", 1, 0.5, 50),
        Metric("sleep", "Sleep", "h", "none", "sum", 1, 0, 24, True),
        Metric("steps", "Steps", "steps", "none", "max", 0, 0, 200_000, True),
        Metric("water", "Water", "ml", "water", "sum", 0, 0, 10_000, True),
        Metric("mood", "Mood", "/5", "none", "avg", 1, 1, 5, True),
        Metric("energy", "Energy", "/5", "none", "avg", 1, 1, 5, True),
        Metric("temperature", "Temperature", "°C", "temp", "max", 1, 30, 45),
        Metric("spo2", "Blood oxygen", "%", "none", "avg", 0, 50, 100, True),
    ]
}

# Derived series that can be summarised / correlated but aren't logged directly.
DERIVED = {
    "bp_sys": "Systolic BP",
    "bp_dia": "Diastolic BP",
    "pulse": "Pulse (with BP)",
    "sleep_quality": "Sleep quality",
    "symptoms": "Worst symptom severity",
}

ALIASES = {
    "bodyfat": "body_fat", "fat": "body_fat", "body_fat_percent": "body_fat",
    "blood_pressure": "bp", "bloodpressure": "bp",
    "heart_rate": "resting_hr", "hr": "resting_hr", "rhr": "resting_hr", "resting_heart_rate": "resting_hr",
    "blood_glucose": "glucose", "sugar": "glucose", "blood_sugar": "glucose", "bg": "glucose",
    "temp": "temperature", "oxygen": "spo2", "sp02": "spo2", "o2": "spo2",
    "hips": "hip", "waist_circumference": "waist", "thighs": "thigh", "arms": "arm", "bicep": "arm",
    "step": "steps", "systolic": "bp_sys", "diastolic": "bp_dia", "symptom": "symptoms",
}


def metric_info(data: dict, mid: str) -> dict[str, Any] | None:
    """Catalogue entry (built-in or custom) as a dict, or None."""
    if mid in BUILTIN:
        m = BUILTIN[mid]
        return {
            "id": m.id, "label": m.label, "unit": m.unit, "dim": m.dim, "agg": m.agg, "decimals": m.decimals,
            "lo": m.lo, "hi": m.hi, "higher_is_better": m.higher_is_better, "smooth": m.smooth, "custom": False,
        }
    for c in data.get("custom_metrics", []):
        if c["id"] == mid:
            return {
                "id": c["id"], "label": c["name"], "unit": c.get("unit", ""), "dim": "none",
                "agg": c.get("aggregate", "avg"), "decimals": c.get("decimals", 1), "lo": -1e6, "hi": 1e7,
                "higher_is_better": c.get("higher_is_better"), "smooth": c.get("aggregate") in ("avg", "last"),
                "custom": True,
            }
    if mid in DERIVED:
        unit = {"bp_sys": "mmHg", "bp_dia": "mmHg", "pulse": "bpm", "sleep_quality": "/5", "symptoms": "/10"}[mid]
        return {
            "id": mid, "label": DERIVED[mid], "unit": unit, "dim": "none", "agg": "avg", "decimals": 0,
            "lo": 0, "hi": 400, "higher_is_better": None, "smooth": False, "custom": False,
        }
    return None


def resolve_metric(data: dict, raw: str) -> str | None:
    """A metric id from what someone typed ("Blood pressure", "body fat",
    "symptom:headache", a custom metric's name)."""
    s = (raw or "").strip().lower()
    if s.startswith("symptom:"):
        return "symptom:" + s.split(":", 1)[1].strip()
    key = "".join(ch if ch.isalnum() else "_" for ch in s).strip("_")
    while "__" in key:
        key = key.replace("__", "_")
    key = ALIASES.get(key, key)
    if key in BUILTIN or key in DERIVED:
        return key
    for c in data.get("custom_metrics", []):
        if c["id"] == key or c["name"].strip().lower() == s:
            return c["id"]
    for m in BUILTIN.values():
        if m.label.lower() == s:
            return m.id
    return None


# ------------------------------------------------------------------ units

LB_PER_KG = 2.2046226218
CM_PER_IN = 2.54
MGDL_PER_MMOL = 18.0182  # glucose (molar mass 180.16 g/mol)
ML_PER_OZ = 29.5735

INPUT_UNITS: dict[str, tuple[str, Any]] = {
    # unit as typed → (dimension, function to canonical)
    "kg": ("weight", lambda v: v),
    "kgs": ("weight", lambda v: v),
    "lb": ("weight", lambda v: v / LB_PER_KG),
    "lbs": ("weight", lambda v: v / LB_PER_KG),
    "pound": ("weight", lambda v: v / LB_PER_KG),
    "pounds": ("weight", lambda v: v / LB_PER_KG),
    "st": ("weight", lambda v: v * 14 / LB_PER_KG),
    "stone": ("weight", lambda v: v * 14 / LB_PER_KG),
    "g": ("weight", lambda v: v / 1000),
    "cm": ("length", lambda v: v),
    "mm": ("length", lambda v: v / 10),
    "m": ("length", lambda v: v * 100),
    "in": ("length", lambda v: v * CM_PER_IN),
    "inch": ("length", lambda v: v * CM_PER_IN),
    "inches": ("length", lambda v: v * CM_PER_IN),
    "mmol": ("glucose", lambda v: v),
    "mmol/l": ("glucose", lambda v: v),
    "mgdl": ("glucose", lambda v: v / MGDL_PER_MMOL),
    "mg/dl": ("glucose", lambda v: v / MGDL_PER_MMOL),
    "c": ("temp", lambda v: v),
    "°c": ("temp", lambda v: v),
    "celsius": ("temp", lambda v: v),
    "f": ("temp", lambda v: (v - 32) * 5 / 9),
    "°f": ("temp", lambda v: (v - 32) * 5 / 9),
    "fahrenheit": ("temp", lambda v: (v - 32) * 5 / 9),
    "ml": ("water", lambda v: v),
    "l": ("water", lambda v: v * 1000),
    "litre": ("water", lambda v: v * 1000),
    "liter": ("water", lambda v: v * 1000),
    "oz": ("water", lambda v: v * ML_PER_OZ),
    "floz": ("water", lambda v: v * ML_PER_OZ),
    "cup": ("water", lambda v: v * 250),
    "cups": ("water", lambda v: v * 250),
    "glass": ("water", lambda v: v * 250),
    "glasses": ("water", lambda v: v * 250),
    "h": ("time", lambda v: v),
    "hr": ("time", lambda v: v),
    "hours": ("time", lambda v: v),
    "min": ("time", lambda v: v / 60),
    "minutes": ("time", lambda v: v / 60),
}


def display_unit(settings: dict, dim: str) -> str:
    return {
        "weight": "lb" if settings.get("weight_unit") == "lb" else "kg",
        "length": "in" if settings.get("length_unit") == "in" else "cm",
        "glucose": "mgdl" if settings.get("glucose_unit") == "mgdl" else "mmol",
        "temp": "f" if settings.get("temp_unit") == "f" else "c",
        "water": "oz" if settings.get("water_unit") == "oz" else "ml",
    }.get(dim, "")


def to_canonical(value: float, dim: str, unit: str | None, settings: dict) -> float:
    """``value`` in ``unit`` (or, when None, the person's display unit for
    ``dim``) → the stored unit. Raises ValueError for a unit that doesn't fit."""
    u = (unit or "").strip().lower().replace(" ", "")
    if dim in ("none", ""):
        conv = INPUT_UNITS.get(u)
        if conv is not None and conv[0] == "time":
            return conv[1](value)
        return value
    if not u:
        u = display_unit(settings, dim)
    conv = INPUT_UNITS.get(u)
    if conv is None or conv[0] != dim:
        raise ValueError(f"{unit!r} isn't a unit for this metric")
    return conv[1](value)


def from_canonical(value: float, dim: str, settings: dict) -> float:
    u = display_unit(settings, dim)
    if u == "lb":
        return value * LB_PER_KG
    if u == "in":
        return value / CM_PER_IN
    if u == "mgdl":
        return value * MGDL_PER_MMOL
    if u == "f":
        return value * 9 / 5 + 32
    if u == "oz":
        return value / ML_PER_OZ
    return value


UNIT_LABEL = {"kg": "kg", "lb": "lb", "cm": "cm", "in": "in", "mmol": "mmol/L", "mgdl": "mg/dL", "c": "°C", "f": "°F", "ml": "ml", "oz": "oz"}


def fmt_value(data: dict, mid: str, value: float | None) -> str:
    """A canonical value in the person's units, with the unit ("80.2 kg")."""
    if value is None:
        return "–"
    info = metric_info(data, mid) or {"dim": "none", "unit": "", "decimals": 1}
    s = data.get("settings", {})
    v = from_canonical(value, info["dim"], s)
    unit = UNIT_LABEL.get(display_unit(s, info["dim"]), info["unit"]) if info["dim"] != "none" else info["unit"]
    dec = info["decimals"]
    if info["dim"] == "glucose":
        v = glucose_shown(value, display_unit(s, "glucose"))
        dec = 0 if display_unit(s, "glucose") == "mgdl" else 1
    if info["dim"] == "water" and display_unit(s, "water") == "oz":
        dec = 0
    txt = f"{v:,.{dec}f}" if dec else f"{round(v):,}"
    if mid == "sleep":
        h = int(value)
        m = int(round((value - h) * 60))
        if m == 60:
            h, m = h + 1, 0
        return f"{h} h {m:02d} min"
    return f"{txt} {unit}".strip() if unit not in ("/5",) else f"{txt}/5"


# -------------------------------------------------------------- moments


def parse_moment(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def day_of(at: str) -> str:
    """The person's local calendar day of an ISO moment (the offset is theirs)."""
    return at[:10]


def to_date(day: str) -> date:
    return date.fromisoformat(day)


def age_years(birth: str | None, today: date) -> int | None:
    if not birth:
        return None
    try:
        b = date.fromisoformat(birth)
    except ValueError:
        return None
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


# --------------------------------------------------------------- series


def _readings_value(r: dict, mid: str) -> float | None:
    if mid == "bp_sys":
        return float(r["sys"]) if r.get("sys") is not None else None
    if mid == "bp_dia":
        return float(r["dia"]) if r.get("dia") is not None else None
    if mid == "pulse":
        return float(r["pulse"]) if r.get("pulse") is not None else None
    if mid == "sleep_quality":
        return float(r["quality"]) if r.get("quality") is not None else None
    if mid == "bp":
        return float(r["sys"]) if r.get("sys") is not None else None
    return r.get("value")


def _combine(vals: list[float], agg: str) -> float:
    if agg == "sum":
        return sum(vals)
    if agg == "last":
        return vals[-1]
    if agg == "max":
        return max(vals)
    if agg == "min":
        return min(vals)
    return sum(vals) / len(vals)


def daily(data: dict, mid: str, start: str | None = None, end: str | None = None) -> dict[str, float]:
    """Day → that day's value of ``mid`` (aggregated per the catalogue).
    Also: ``symptoms`` (worst severity that day), ``symptom:<name>``."""
    out: dict[str, list[float]] = {}
    if mid == "symptoms" or mid.startswith("symptom:"):
        want = mid.split(":", 1)[1].strip().lower() if ":" in mid else None
        for s in data.get("symptoms", []):
            if want and s["name"].strip().lower() != want:
                continue
            out.setdefault(day_of(s["at"]), []).append(float(s["severity"]))
        res = {d: max(v) for d, v in out.items()}
    else:
        base = {"bp_sys": "bp", "bp_dia": "bp", "pulse": "bp", "sleep_quality": "sleep"}.get(mid, mid)
        info = metric_info(data, mid)
        agg = "avg" if mid in DERIVED else (info["agg"] if info else "avg")
        rows = sorted((r for r in data.get("readings", []) if r["metric"] == base), key=lambda r: r["at"])
        for r in rows:
            v = _readings_value(r, mid)
            if v is None:
                continue
            out.setdefault(day_of(r["at"]), []).append(float(v))
        res = {d: _combine(v, agg) for d, v in out.items()}
    return {d: v for d, v in sorted(res.items()) if (start is None or d >= start) and (end is None or d <= end)}


def ewma(series: dict[str, float], alpha: float = 0.1) -> dict[str, float]:
    """The smoothed trend, Hacker's-Diet style (what Happy Scale / Libra
    show): each new day pulls the trend ``alpha`` of the way toward it, and a
    gap of n days counts as n steps (``1 - (1-α)^n``), so a sparse log isn't
    over-smoothed."""
    out: dict[str, float] = {}
    trend: float | None = None
    prev: date | None = None
    for d, v in sorted(series.items()):
        cur = to_date(d)
        if trend is None:
            trend = v
        else:
            gap = max(1, (cur - prev).days) if prev else 1
            a = 1 - (1 - alpha) ** gap
            trend = trend + a * (v - trend)
        out[d] = trend
        prev = cur
    return out


def linreg(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Least squares (slope, intercept) of (x, y), or None for < 2 distinct x."""
    n = len(points)
    if n < 2:
        return None
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    if sxx == 0:
        return None
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    slope = sxy / sxx
    return slope, my - slope * mx


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3 or n != len(ys):
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def strength(r: float) -> str:
    a = abs(r)
    if a < 0.1:
        return "none"
    if a < 0.3:
        return "weak"
    if a < 0.5:
        return "moderate"
    if a < 0.7:
        return "strong"
    return "very strong"


def p_value_approx(r: float, n: int) -> float | None:
    """Two-sided p for Pearson r via the t distribution (normal approximation
    for the tail is good enough for a "is this likely chance" hint)."""
    if n < 4 or abs(r) >= 1:
        return 0.0 if n >= 4 else None
    t = abs(r) * math.sqrt((n - 2) / (1 - r * r))
    # Approximate t → z for df = n-2 (Abramowitz–Stegun 26.7.8-ish).
    df = n - 2
    z = t * (1 - 1 / (4 * df)) / math.sqrt(1 + t * t / (2 * df))
    return max(0.0, min(1.0, math.erfc(z / math.sqrt(2))))


# -------------------------------------------------------------- references


def bp_category(sys: int | None, dia: int | None) -> dict[str, str] | None:
    """AHA/ACC 2017 categories (kept in the 2025 guideline). The higher of the
    two numbers decides. Higher than 180 and/or higher than 120 = the
    hypertensive-crisis range (AHA wording)."""
    if sys is None or dia is None:
        return None
    if sys > 180 or dia > 120:
        return {"id": "crisis", "label": "Hypertensive crisis range", "advice": (
            "Higher than 180 and/or higher than 120. Wait a few minutes and measure again. If it's still this high, "
            "contact your doctor now; with chest pain, shortness of breath, back pain, numbness or weakness, a "
            "change in vision or difficulty speaking, call emergency services immediately.")}
    if sys >= 140 or dia >= 90:
        return {"id": "stage2", "label": "Hypertension stage 2", "advice": "Above target — worth discussing with your doctor."}
    if sys >= 130 or dia >= 80:
        return {"id": "stage1", "label": "Hypertension stage 1", "advice": "Above the normal range — track it and mention it at your next visit."}
    if sys >= 120:
        return {"id": "elevated", "label": "Elevated", "advice": "A little above normal."}
    if sys < 90 or dia < 60:
        return {"id": "low", "label": "Low", "advice": "Lower than typical; fine for some people — mention it if you feel dizzy or faint."}
    return {"id": "normal", "label": "Normal", "advice": ""}


def bp_is_crisis(sys: int | None, dia: int | None) -> bool:
    return sys is not None and dia is not None and (sys > 180 or dia > 120)


def bmi(weight_kg: float | None, height_cm: float | None) -> float | None:
    if not weight_kg or not height_cm:
        return None
    m = height_cm / 100
    return weight_kg / (m * m)


def bmi_band(b: float) -> str:
    """WHO adult bands."""
    if b < 18.5:
        return "Underweight"
    if b < 25:
        return "Healthy weight"
    if b < 30:
        return "Overweight"
    if b < 35:
        return "Obesity class I"
    if b < 40:
        return "Obesity class II"
    return "Obesity class III"


def bmr_mifflin(weight_kg: float, height_cm: float, age: int, sex: str) -> float | None:
    """Mifflin–St Jeor (1990) resting energy, kcal/day. None for unspecified sex
    (we give the range between the two equations instead)."""
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    if sex == "male":
        return base + 5
    if sex == "female":
        return base - 161
    return None


# ADA cut points in both units. The mmol/L figures are the ADA's own rounded
# equivalents (70 mg/dL ≈ 3.9 mmol/L), so a reading is classified in the
# unit the person sees, rounded as it's shown — never across a conversion,
# which would make 70 mg/dL "low" or 100 mg/dL "normal fasting".
GLUCOSE_CUTS: dict[str, dict[str, float]] = {
    "mmol": {"very_low": 3.0, "low": 3.9, "fasting_pre": 5.6, "fasting_diabetes": 7.0, "post_normal": 7.8,
             "post_target": 10.0, "random_high": 11.1, "very_high": 13.9, "pre_target": 7.2},
    "mgdl": {"very_low": 54, "low": 70, "fasting_pre": 100, "fasting_diabetes": 126, "post_normal": 140,
             "post_target": 180, "random_high": 200, "very_high": 250, "pre_target": 130},
}


def glucose_shown(mmol: float, unit: str = "mmol") -> float:
    """A stored (mmol/L) glucose as shown: whole mg/dL, or mmol/L to 0.1
    (half up, with a nudge so 70 mg/dL stored and read back stays 70)."""
    if unit == "mgdl":
        return float(math.floor(mmol * MGDL_PER_MMOL + 0.5 + 1e-9))
    return math.floor(mmol * 10 + 0.5 + 1e-9) / 10


def glucose_band(mmol: float, context: str | None, unit: str = "mmol") -> dict[str, str]:
    """ADA reference ranges. Fasting: <100 mg/dL (5.6) normal, 100–125
    (5.6–6.9) prediabetes range, ≥126 (7.0) diabetes range — one reading never
    diagnoses. After meals <140 (7.8) non-diabetic, <180 (10.0) the ADA target
    with diabetes. Pre-meal target with diabetes 80–130 (4.4–7.2). <70 (3.9)
    low, <54 (3.0) level-2 low, ≥250 (13.9) very high. ``unit`` is the
    person's display unit — the reading is judged as they see it."""
    u = "mgdl" if unit == "mgdl" else "mmol"
    c = GLUCOSE_CUTS[u]
    v = glucose_shown(mmol, u)
    lab = (lambda mg, mm: mg if u == "mgdl" else mm)  # noqa: E731
    if v < c["very_low"]:
        return {"id": "very_low", "label": "Very low (level 2 hypoglycaemia)", "advice": "Treat a low now (15 g fast sugar) and get help if you feel unwell or confused."}
    if v < c["low"]:
        return {"id": "low", "label": "Low (hypoglycaemia)", "advice": "Treat with 15 g fast-acting carbohydrate and recheck in 15 minutes."}
    if v >= c["very_high"]:
        return {"id": "very_high", "label": "Very high", "advice": "If you have diabetes, follow your sick-day / ketone plan; seek care if unwell."}
    if context == "fasting":
        if v < c["fasting_pre"]:
            return {"id": "normal", "label": "Normal fasting", "advice": ""}
        if v < c["fasting_diabetes"]:
            return {"id": "elevated", "label": "Prediabetes range (fasting)", "advice": "Worth confirming with a lab test via your doctor."}
        return {"id": "high", "label": "Diabetes range (fasting)", "advice": "One reading doesn't diagnose — talk to your doctor."}
    if context == "post_meal":
        if v < c["post_normal"]:
            return {"id": "normal", "label": "Normal after a meal", "advice": ""}
        if v < c["post_target"]:
            return {"id": "elevated", "label": "Above non-diabetic range after a meal", "advice": ""}
        return {"id": "high", "label": "High after a meal", "advice": ""}
    if v >= c["random_high"]:
        return {"id": "high", "label": "High", "advice": f"A random reading of {lab('200 mg/dL', '11.1 mmol/L')} or more with symptoms needs a doctor's review."}
    if context in ("pre_meal", "bedtime") and v > c["pre_target"]:
        return {"id": "elevated", "label": f"Above the usual pre-meal target ({lab('80–130', '4.4–7.2')})", "advice": ""}
    return {"id": "normal", "label": "In range", "advice": ""}


def sleep_band(hours: float) -> str:
    if hours < 6:
        return "short"
    if hours < 7:
        return "a little short"
    if hours <= 9:
        return "in the recommended 7–9 h"
    return "long"


def spo2_band(p: float) -> str:
    """95–100% typical; 93–94% slightly low; 92% or less → contact a
    clinician; under 90% (or breathless) → urgent."""
    if p >= 95:
        return "normal"
    if p > 92:
        return "slightly low"
    if p >= 90:
        return "low — contact a clinician today (urgently if breathless)"
    return "very low — get urgent medical help"


def temp_band(c: float) -> str:
    if c < 35:
        return "low (hypothermia range)"
    if c < 38:
        return "normal"
    if c < 39.5:
        return "fever"
    return "high fever"


def hr_band(bpm: float) -> str:
    if bpm < 50:
        return "low (normal for some fit people)"
    if bpm <= 100:
        return "normal (60–100 for adults)" if bpm >= 60 else "low-normal"
    return "high (above 100)"


def days_back(today: date, n: int) -> str:
    return (today - timedelta(days=n - 1)).isoformat()


# ------------------------------------------------------------------- cycle


def cycle_forecast(periods: list[dict], today: date) -> dict | None:
    """Calendar-method estimate from logged period days: average cycle and
    period length (last 6), the next period, ovulation ≈ 14 days before it and
    the fertile window (5 days before ovulation to 1 after). An estimate for
    planning — never contraception."""
    days = sorted({p["day"] for p in periods if p.get("flow") != "spotting"})
    if not days:
        return None
    have = set(days)
    starts: list[date] = []
    lengths: list[int] = []
    for d in days:
        dd = to_date(d)
        prev = (dd - timedelta(days=1)).isoformat()
        prev2 = (dd - timedelta(days=2)).isoformat()
        if prev in have or prev2 in have:  # one-day gap still the same period
            if lengths:
                lengths[-1] = (dd - starts[-1]).days + 1
            continue
        starts.append(dd)
        lengths.append(1)
    cycles = [(b - a).days for a, b in zip(starts, starts[1:]) if 15 <= (b - a).days <= 60]
    recent = cycles[-6:]
    avg_cycle = round(sum(recent) / len(recent)) if recent else 28
    avg_len = round(sum(lengths[-6:]) / len(lengths[-6:])) if lengths else 5
    last = starts[-1]
    nxt = last + timedelta(days=avg_cycle)
    ovulation = nxt - timedelta(days=14)
    var = (max(recent) - min(recent)) if len(recent) >= 2 else None
    in_period = (today - last).days < lengths[-1] and today >= last
    return {
        "last_start": last.isoformat(),
        "cycle_day": (today - last).days + 1,
        "avg_cycle_days": avg_cycle,
        "avg_period_days": avg_len,
        "cycles_logged": len(cycles),
        "cycle_variation_days": var,
        "next_period": nxt.isoformat(),
        "days_until_next": (nxt - today).days,
        "late_by_days": max(0, (today - nxt).days) if today > nxt else 0,
        "ovulation_estimate": ovulation.isoformat(),
        "fertile_window": [(ovulation - timedelta(days=5)).isoformat(), (ovulation + timedelta(days=1)).isoformat()],
        "in_period": in_period,
        "confidence": "low" if len(recent) < 3 or (var is not None and var > 7) else "moderate",
    }
