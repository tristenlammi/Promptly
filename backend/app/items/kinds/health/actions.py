"""Body & Health actions — the assistant's (and the UI's) hands.

Every action is deterministic for (data, args, ctx.now): new ids are hashes
of the inputs and the moment, so the AI's writes replay cleanly when the
file changed meanwhile.
"""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import date, datetime, time, timedelta
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import meds as M
from . import science as S
from .models import HHMM, MAX_DOSES, MAX_READINGS, MAX_SYMPTOMS, MAX_PERIOD_DAYS

# ----------------------------------------------------------------- helpers


def _new_id(prefix: str, existing: set[str], *parts: Any) -> str:
    raw = json.dumps(parts, default=str, sort_keys=True)
    h = hashlib.sha1(raw.encode()).hexdigest()
    for i in range(0, 32, 2):
        cand = f"{prefix}{h[i:i + 8]}"
        if cand not in existing:
            existing.add(cand)
            return cand
    n = 2
    while f"{prefix}{h[:8]}{n}" in existing:
        n += 1
    existing.add(f"{prefix}{h[:8]}{n}")
    return f"{prefix}{h[:8]}{n}"


def _ids(rows: list[dict]) -> set[str]:
    return {r["id"] for r in rows if "id" in r}


def _aware(ctx: ItemContext, dt: datetime | None) -> datetime:
    if dt is None:
        return ctx.now.replace(microsecond=0)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ctx.tz)
    return dt.astimezone(ctx.tz).replace(microsecond=0)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _day(ctx: ItemContext, s: str | None) -> str:
    if not s:
        return ctx.today.isoformat()
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError as e:
        raise ActionError(f"{s!r} isn't a date (use YYYY-MM-DD).") from e


def _cap(rows: list[dict], cap: int, what: str) -> None:
    """Refuse past a list's ceiling — never drop old entries silently. The
    way out is archiving older data into its own file (nothing is lost)."""
    if len(rows) > cap:
        raise ActionError(
            f"This file already holds {cap:,} {what} — its limit. Use \"Archive older data\" in the file's menu "
            "to move older entries into an archive file (nothing is deleted), then log again."
        )


def _find_med(data: dict, ref: str) -> dict:
    s = (ref or "").strip().lower()
    meds = data.get("medications", [])
    for m in meds:
        if m["id"] == ref or m["name"].strip().lower() == s:
            return m
    hits = [m for m in meds if s and s in m["name"].lower()]
    active = [m for m in hits if m.get("active", True)]
    if len(active) == 1:
        return active[0]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(f"{m['name']} ({m['id']})" for m in meds[:30]) or "none yet"
    raise ActionError(f"No single medication matches {ref!r}. Medications: {names}.")


def _metric_or_fail(data: dict, raw: str, *, allow_derived: bool = False) -> str:
    mid = S.resolve_metric(data, raw)
    if mid is None or (not allow_derived and (mid in S.DERIVED or mid.startswith("symptom:"))):
        known = ", ".join(list(S.BUILTIN) + [c["id"] for c in data.get("custom_metrics", [])])
        raise ActionError(f"Unknown metric {raw!r}. Known: {known}. Use define_custom_metric for a new one.")
    return mid


def _hhmm_or_iso(ctx: ItemContext, s: str, anchor: date) -> datetime:
    s = s.strip()
    if len(s) <= 5 and ":" in s:
        h, m = (int(x) for x in s.split(":"))
        return datetime.combine(anchor, time(h, m), tzinfo=ctx.tz)
    try:
        return _aware(ctx, datetime.fromisoformat(s))
    except ValueError as e:
        raise ActionError(f"{s!r} isn't a time (HH:MM or ISO).") from e


def _range(ctx: ItemContext, days: int, start: str | None, end: str | None) -> tuple[str, str, int]:
    e = _day(ctx, end) if end else ctx.today.isoformat()
    if start:
        s = _day(ctx, start)
    else:
        s = (date.fromisoformat(e) - timedelta(days=days - 1)).isoformat()
    if s > e:
        raise ActionError("The start is after the end.")
    return s, e, (date.fromisoformat(e) - date.fromisoformat(s)).days + 1


def _goal(data: dict, mid: str) -> dict | None:
    return next((g for g in data.get("goals", []) if g["metric"] == mid), None)


def _latest(data: dict, mid: str) -> dict | None:
    rows = [r for r in data.get("readings", []) if r["metric"] == mid]
    return max(rows, key=lambda r: r["at"]) if rows else None


# ---------------------------------------------------------------- metrics

Arm = Literal["left", "right"]
Position = Literal["sitting", "standing", "lying"]
GlucoseContext = Literal["fasting", "pre_meal", "post_meal", "bedtime", "random"]


class ReadingIn(BaseModel):
    metric: str = Field(
        description="Metric id or name: weight, body_fat, waist, hip, chest, arm, thigh, bp, resting_hr, glucose, "
        "sleep, steps, water, mood, energy, temperature, spo2, or a custom metric's id/name."
    )
    value: float | None = Field(
        default=None,
        description="The number (not for bp). mood/energy 1–5; water is an amount drunk (it adds up over the day); "
        "steps is the day's total; sleep may give hours here instead of bed/wake.",
    )
    unit: str | None = Field(
        default=None,
        description="Unit of value: kg/lb/st, cm/in, mmol/L or mg/dL, C/F, ml/l/oz/cup, hours/min. "
        "Omit to mean the person's own display unit.",
    )
    sys: int | None = Field(default=None, ge=40, le=320, description="bp: systolic")
    dia: int | None = Field(default=None, ge=20, le=220, description="bp: diastolic")
    pulse: int | None = Field(default=None, ge=20, le=260, description="bp: pulse")
    arm: Arm | None = Field(default=None, description="bp: which arm")
    position: Position | None = Field(default=None, description="bp: body position")
    context: GlucoseContext | None = Field(default=None, description="glucose: when it was taken")
    bed: str | None = Field(default=None, description="sleep: bedtime, HH:MM or ISO (the night before the wake day)")
    wake: str | None = Field(default=None, description="sleep: wake time, HH:MM or ISO")
    quality: int | None = Field(default=None, ge=1, le=5, description="sleep: quality 1 (awful) – 5 (great)")
    at: datetime | None = Field(default=None, description="When it was measured (ISO); default now. For sleep, the wake time.")
    note: str = Field(default="", max_length=500)


class LogMetrics(BaseModel):
    readings: list[ReadingIn] = Field(min_length=1, max_length=120, description="One or many readings, logged together.")


def _build_reading(ctx: ItemContext, data: dict, r: ReadingIn) -> dict:
    settings = data["settings"]
    mid = _metric_or_fail(data, r.metric)
    info = S.metric_info(data, mid)
    assert info is not None
    at = _aware(ctx, r.at)
    row: dict[str, Any] = {
        "metric": mid, "at": _iso(at), "value": None, "sys": None, "dia": None, "pulse": None, "arm": None,
        "position": None, "context": None, "bed": None, "quality": None, "note": r.note.strip(),
    }
    if mid == "bp":
        if r.sys is None or r.dia is None:
            raise ActionError("Blood pressure needs both sys and dia.")
        if r.sys <= r.dia:
            raise ActionError(f"{r.sys}/{r.dia} doesn't look right — systolic should be the higher number.")
        row.update(sys=r.sys, dia=r.dia, pulse=r.pulse, arm=r.arm, position=r.position)
        return row
    if mid == "sleep":
        anchor = at.date()
        wake = _hhmm_or_iso(ctx, r.wake, anchor) if r.wake else (at if r.bed else None)
        hours = None
        if r.bed and wake is not None:
            bed = _hhmm_or_iso(ctx, r.bed, anchor)
            if len(r.bed.strip()) <= 5 and bed >= wake:
                bed -= timedelta(days=1)
            hours = (wake - bed).total_seconds() / 3600
            row["bed"] = _iso(bed)
            at = wake
        elif r.value is not None:
            hours = S.to_canonical(r.value, "none", r.unit, settings)
            if r.wake and wake is not None:
                at = wake
        if hours is None:
            if r.quality is None:
                raise ActionError("Sleep needs bed and wake times, the hours slept as value, or at least a quality 1–5.")
            row.update(quality=r.quality)
            return row
        if not 0 < hours <= 24:
            raise ActionError(f"{hours:.1f} hours of sleep isn't possible — check the times.")
        row.update(at=_iso(at), value=round(hours, 2), quality=r.quality)
        return row
    if r.value is None:
        raise ActionError(f"{info['label']} needs a value.")
    try:
        v = S.to_canonical(r.value, info["dim"], r.unit, settings)
    except ValueError as e:
        raise ActionError(f"{info['label']}: {e}.") from e
    if mid in ("mood", "energy"):
        v = round(v)
    if not info["lo"] <= v <= info["hi"]:
        raise ActionError(f"{info['label']} of {S.fmt_value(data, mid, v)} is outside what's possible — check the number and unit.")
    row["value"] = round(v, 4)
    if mid == "glucose":
        row["context"] = r.context
    return row


def _flags(data: dict, row: dict) -> list[str]:
    """Plain warnings for one reading (reference ranges)."""
    mid = row["metric"]
    out = []
    if mid == "bp":
        cat = S.bp_category(row["sys"], row["dia"])
        if cat and cat["id"] == "crisis":
            out.append(f"⚠️ {row['sys']}/{row['dia']} is in the hypertensive-crisis range. {cat['advice']}")
    elif mid == "glucose" and row["value"] is not None:
        band = S.glucose_band(row["value"], row.get("context"), S.display_unit(data["settings"], "glucose"))
        if band["id"] in ("very_low", "low", "very_high"):
            out.append(f"⚠️ Glucose {S.fmt_value(data, 'glucose', row['value'])}: {band['label']}. {band['advice']}")
    elif mid == "spo2" and row["value"] is not None and round(row["value"]) < 90:
        out.append(f"⚠️ Blood oxygen {row['value']:.0f}% is very low — get urgent medical help, especially if you're breathless or unwell.")
    elif mid == "spo2" and row["value"] is not None and round(row["value"]) <= 92:
        out.append(f"⚠️ Blood oxygen {row['value']:.0f}% is low — contact a clinician today (urgently if you're breathless or unwell).")
    elif mid == "temperature" and row["value"] is not None and (row["value"] >= 39.5 or row["value"] < 35):
        out.append(f"⚠️ Temperature {S.fmt_value(data, 'temperature', row['value'])} — {S.temp_band(row['value'])}; seek medical advice.")
    return out


def log_metrics(ctx: ItemContext, data: dict, p: LogMetrics) -> ActionOutcome:
    built = [_build_reading(ctx, data, r) for r in p.readings]
    existing = _ids(data["readings"])
    seen = {(r["metric"], r["at"], r.get("value"), r.get("sys"), r.get("dia")) for r in data["readings"]}
    added, warnings, labels = [], [], []
    for i, row in enumerate(built):
        key = (row["metric"], row["at"], row.get("value"), row.get("sys"), row.get("dia"))
        if key in seen:
            continue
        seen.add(key)
        row = {"id": _new_id("r", existing, "reading", row, i), **row}
        data["readings"].append(row)
        added.append(row)
        warnings += _flags(data, row)
        if row["metric"] == "bp":
            cat = S.bp_category(row["sys"], row["dia"])
            labels.append(f"BP {row['sys']}/{row['dia']}" + (f" ({cat['label']})" if cat else ""))
        else:
            info = S.metric_info(data, row["metric"]) or {"label": row["metric"]}
            labels.append(f"{info['label']} {S.fmt_value(data, row['metric'], row['value'])}")
    data["readings"].sort(key=lambda r: r["at"])
    _cap(data["readings"], MAX_READINGS, "readings")
    if not added:
        return ActionOutcome(summary="Already logged", result={"added": 0, "note": "Those readings were already in the log."})
    summary = "Logged " + ", ".join(labels[:6]) + (f" and {len(labels) - 6} more" if len(labels) > 6 else "")
    return ActionOutcome(
        summary=summary,
        result={
            "added": [{"id": r["id"], "metric": r["metric"], "at": r["at"]} for r in added],
            "warnings": warnings,
        },
    )


# --------------------------------------------------------------- symptoms


class SymptomIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, description="e.g. headache, nausea, back pain, anxiety")
    severity: int = Field(default=5, ge=1, le=10, description="1 barely there – 10 worst imaginable")
    tags: list[str] = Field(default_factory=list, max_length=12, description="Possible factors/context: 'after coffee', 'stress', 'period'")
    note: str = Field(default="", max_length=1000)
    at: datetime | None = Field(default=None, description="When (ISO); default now")


class LogSymptom(BaseModel):
    symptoms: list[SymptomIn] = Field(min_length=1, max_length=40)


RED_FLAG_WORDS = (
    "chest pain", "chest tightness", "crushing", "stroke", "face droop", "slurred", "can't speak",
    "one side", "numb", "weakness on", "suicid", "kill myself", "self harm", "self-harm", "overdose",
    "can't breathe", "cannot breathe", "short of breath", "anaphyla", "throat swelling", "unconscious",
    "fainted", "seizure", "worst headache", "coughing blood", "vomiting blood",
)


def red_flags(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in RED_FLAG_WORDS)


def log_symptom(ctx: ItemContext, data: dict, p: LogSymptom) -> ActionOutcome:
    existing = _ids(data["symptoms"])
    added = []
    urgent = False
    for i, s in enumerate(p.symptoms):
        at = _iso(_aware(ctx, s.at))
        tags = sorted({t.strip().lower()[:40] for t in s.tags if t.strip()})[:12]
        row = {"id": "", "at": at, "name": s.name.strip(), "severity": s.severity, "tags": tags, "note": s.note.strip()}
        row["id"] = _new_id("s", existing, "symptom", row, i)
        data["symptoms"].append(row)
        added.append(row)
        urgent = urgent or red_flags(f"{s.name} {s.note} {' '.join(tags)}")
    data["symptoms"].sort(key=lambda r: r["at"])
    _cap(data["symptoms"], MAX_SYMPTOMS, "symptoms")
    summary = "Logged " + ", ".join(f"{r['name']} ({r['severity']}/10)" for r in added)
    result: dict[str, Any] = {"ids": [r["id"] for r in added]}
    if urgent:
        result["red_flag"] = (
            "This may be an emergency sign. Tell the person to call emergency services (or go to the nearest "
            "emergency department) now — don't wait to see if it passes. For thoughts of suicide or self-harm, "
            "urge them to contact a crisis line or emergency services immediately."
        )
    return ActionOutcome(summary=summary, result=result)


class LogPeriod(BaseModel):
    start: str = Field(description="First day (YYYY-MM-DD)")
    end: str | None = Field(default=None, description="Last day; default the same as start")
    flow: Literal["spotting", "light", "medium", "heavy"] = "medium"
    remove: bool = Field(default=False, description="True to clear those days instead")


def log_period(ctx: ItemContext, data: dict, p: LogPeriod) -> ActionOutcome:
    a = date.fromisoformat(_day(ctx, p.start))
    b = date.fromisoformat(_day(ctx, p.end)) if p.end else a
    if b < a:
        a, b = b, a
    if (b - a).days > 14:
        raise ActionError("That's more than 15 days — log each period separately.")
    days = {(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)}
    data["periods"] = [x for x in data["periods"] if x["day"] not in days]
    enabled_now = False
    if not p.remove:
        data["periods"].extend({"day": d, "flow": p.flow} for d in sorted(days))
        if not data["settings"].get("cycle_tracking"):
            data["settings"]["cycle_tracking"] = True
            enabled_now = True
    data["periods"].sort(key=lambda x: x["day"])
    _cap(data["periods"], MAX_PERIOD_DAYS, "period days")
    fc = S.cycle_forecast(data["periods"], ctx.today)
    verb = "Cleared" if p.remove else "Logged period"
    span = a.isoformat() if a == b else f"{a.isoformat()} – {b.isoformat()}"
    return ActionOutcome(
        summary=f"{verb} {span}" + (" (cycle tracking turned on)" if enabled_now else ""),
        result={"forecast": fc},
    )


# ------------------------------------------------------------ medications

Weekday = Annotated[int, Field(ge=0, le=6)]
Hhmm = Annotated[str, Field(pattern=HHMM)]


class SlotDoseIn(BaseModel):
    time: Hhmm = Field(description="One of the schedule's times (HH:MM)")
    dose: str = Field(default="", max_length=60, description="The amount at that time: '1000 mg'")
    per_dose: float | None = Field(default=None, gt=0, le=1000, description="Units at that time (2 tablets → 2)")


class TaperStep(BaseModel):
    start: str = Field(description="First day of this step, YYYY-MM-DD")
    dose: str | None = Field(default=None, max_length=60, description="The dose from that day: '20 mg'")
    per_dose: float | None = Field(default=None, gt=0, le=1000, description="Units per dose from that day")
    times: list[Hhmm] | None = Field(default=None, max_length=12, description="New times from that day (default unchanged)")


class MedFields(BaseModel):
    kind: Literal["medication", "supplement"] | None = None
    dose: str | None = Field(default=None, max_length=60, description="Strength/amount as written: '500 mg', '2 puffs'")
    form: Literal[
        "tablet", "capsule", "liquid", "injection", "inhaler", "drops", "patch", "cream", "powder", "spray", "other"
    ] | None = None
    per_dose: float | None = Field(default=None, gt=0, le=1000, description="Units used per dose (2 tablets → 2), for the supply count")
    schedule_type: Literal["daily", "days", "interval", "as_needed"] | None = Field(
        default=None, description="daily = every day at times; days = on weekdays; interval = every N days; as_needed"
    )
    times: list[Hhmm] | None = Field(default=None, max_length=12, description="HH:MM times each due day (24 h)")
    weekdays: list[Weekday] | None = Field(default=None, max_length=7, description="For 'days': 0=Mon … 6=Sun")
    every_days: int | None = Field(default=None, ge=1, le=90, description="For 'interval': every N days from interval_start")
    interval_start: str | None = Field(default=None, description="For 'interval': the first due day YYYY-MM-DD (default the start date)")
    slot_doses: list[SlotDoseIn] | None = Field(
        default=None, max_length=12, description="A different amount at some times (500 mg morning, 1000 mg evening); [] clears"
    )
    with_food: Literal["any", "with", "before", "after", "empty"] | None = None
    start: str | None = Field(default=None, description="YYYY-MM-DD")
    end: str | None = Field(default=None, description="YYYY-MM-DD (a course that ends)")
    remaining: float | None = Field(default=None, ge=0, le=100_000, description="Units on hand now (for refill warnings)")
    purpose: str | None = Field(default=None, max_length=200)
    prescriber: str | None = Field(default=None, max_length=120)
    instructions: str | None = Field(default=None, max_length=500)
    max_per_day: int | None = Field(default=None, ge=0, le=48, description="Most doses a day (as-needed limits); 0 = no limit")
    min_hours_between: float | None = Field(default=None, ge=0, le=72, description="Least hours between doses; 0 = no limit")
    taper: list[TaperStep] | None = Field(
        default=None, max_length=20, description="A dose that changes on dates (a taper or titration): each step from its start day"
    )


class AddMedication(MedFields):
    name: str = Field(min_length=1, max_length=120)


class EditMedication(MedFields):
    med: str = Field(description="Medication id or name")
    name: str | None = Field(default=None, min_length=1, max_length=120)
    refill_add: float | None = Field(default=None, gt=0, le=100_000, description="Add this many units (a refill picked up)")
    active: bool | None = Field(default=None, description="False = stop from now (history kept); true = take it again from today")
    effective_from: str | None = Field(
        default=None,
        description="Day schedule/dose changes take effect, YYYY-MM-DD (default today). Earlier days keep the plan "
        "they had, so logged doses never turn into 'missed'; later planned steps are replaced.",
    )


PLAN_FIELDS = ("dose", "per_dose", "schedule_type", "times", "weekdays", "every_days", "interval_start", "slot_doses")


def _plan_from(ctx: ItemContext, med: dict, base: dict, p: MedFields | TaperStep) -> dict:
    """``base`` plan with the plan fields of ``p`` applied, validated."""
    sch = copy.deepcopy(base["schedule"]) or {}
    sch.setdefault("type", "daily")
    sch.setdefault("times", ["08:00"])
    sch.setdefault("weekdays", [])
    sch.setdefault("every_days", 1)
    sch.setdefault("slot_doses", {})
    dose = base.get("dose", "")
    per = float(base.get("per_dose") or 1)
    if getattr(p, "dose", None) is not None:
        dose = p.dose.strip()
    if getattr(p, "per_dose", None) is not None:
        per = p.per_dose
    if getattr(p, "schedule_type", None) is not None:
        sch["type"] = p.schedule_type
    if getattr(p, "times", None) is not None:
        sch["times"] = sorted(set(p.times))
        sch["slot_doses"] = {k: v for k, v in (sch.get("slot_doses") or {}).items() if k in sch["times"]}
    if getattr(p, "weekdays", None) is not None:
        sch["weekdays"] = sorted(set(p.weekdays))
    if getattr(p, "every_days", None) is not None:
        sch["every_days"] = p.every_days
    if getattr(p, "interval_start", None) is not None:
        sch["anchor"] = _day(ctx, p.interval_start) if p.interval_start else None
    if getattr(p, "slot_doses", None) is not None:
        sch["slot_doses"] = {sd.time: {"dose": sd.dose.strip(), "per_dose": sd.per_dose} for sd in p.slot_doses}
        stray = [t for t in sch["slot_doses"] if t not in sch["times"]]
        if stray:
            raise ActionError(f"slot_doses at {', '.join(stray)} — that isn't one of the times ({', '.join(sch['times'])}).")
    if sch["type"] == "days" and not sch.get("weekdays"):
        raise ActionError("A 'days' schedule needs weekdays (0=Mon … 6=Sun).")
    if sch["type"] != "as_needed" and not sch.get("times"):
        raise ActionError("A scheduled medication needs at least one time (HH:MM).")
    if sch["type"] == "interval" and not sch.get("anchor"):
        if not med.get("start"):
            raise ActionError("An every-N-days schedule needs a day to count from — give interval_start or a start date.")
        sch["anchor"] = med["start"]
    return {"schedule": sch, "dose": dose, "per_dose": per}


def _apply_med_fields(ctx: ItemContext, med: dict, p: MedFields) -> None:
    """The fields that aren't part of the dose plan (those go through
    :func:`meds.change_plan` so the past keeps its plan)."""
    for f in ("kind", "form", "with_food", "purpose", "prescriber", "instructions"):
        v = getattr(p, f)
        if v is not None:
            med[f] = v.strip() if isinstance(v, str) else v
    if p.start is not None:
        med["start"] = _day(ctx, p.start) if p.start else None
    if p.end is not None:
        med["end"] = _day(ctx, p.end) if p.end else None
    if med.get("start") and med.get("end") and med["end"] < med["start"]:
        raise ActionError("The end date is before the start date.")
    if p.remaining is not None:
        med["remaining"] = p.remaining
    if p.max_per_day is not None:
        med["max_per_day"] = p.max_per_day or None
    if p.min_hours_between is not None:
        med["min_hours_between"] = p.min_hours_between or None


def _apply_taper(ctx: ItemContext, med: dict, steps: list[TaperStep]) -> int:
    n = 0
    for st in sorted(steps, key=lambda x: x.start):
        day = date.fromisoformat(_day(ctx, st.start))
        if med.get("start") and day.isoformat() < med["start"]:
            raise ActionError(f"The step from {day.isoformat()} is before the medicine's start ({med['start']}).")
        plan = _plan_from(ctx, med, M.plan_on(med, day), st)
        n += M.change_plan(med, day, plan)
    return n


def _when(med: dict, day: date) -> str:
    plan = M.plan_on(med, day)
    sch = plan["schedule"]
    if sch.get("type") == "as_needed":
        return "as needed"
    sds = sch.get("slot_doses") or {}
    return ", ".join(f"{t} ({sds[t]['dose']})" if t in sds and sds[t].get("dose") else t for t in sch.get("times", []))


def add_medication(ctx: ItemContext, data: dict, p: AddMedication) -> ActionOutcome:
    name = p.name.strip()
    if any(m["name"].strip().lower() == name.lower() and m.get("active", True) for m in data["medications"]):
        raise ActionError(f"{name} is already on the list — use edit_medication to change it.")
    med: dict[str, Any] = {
        "id": _new_id("m", _ids(data["medications"]), "med", name),
        "name": name, "kind": "medication", "dose": "", "form": "tablet", "per_dose": 1,
        "schedule": {"type": "daily", "times": ["08:00"], "weekdays": [], "every_days": 1, "anchor": None, "slot_doses": {}},
        "with_food": "any", "start": ctx.today.isoformat(), "end": None, "remaining": None, "purpose": "",
        "prescriber": "", "instructions": "", "active": True, "stopped_at": None, "color": "",
        "max_per_day": None, "min_hours_between": None, "schedule_history": [],
    }
    _apply_med_fields(ctx, med, p)
    plan = _plan_from(ctx, med, M.own_plan(med), p)
    med.update(schedule=plan["schedule"], dose=plan["dose"], per_dose=plan["per_dose"])
    if p.taper:
        _apply_taper(ctx, med, p.taper)
    data["medications"].append(med)
    when = _when(med, ctx.today)
    steps = f" · {len(med['schedule_history'])} dose step(s) before the final plan" if med["schedule_history"] else ""
    shown = M.plan_on(med, ctx.today)["dose"]
    return ActionOutcome(summary=f"Added {name}{(' ' + shown) if shown else ''} · {when}{steps}", result={"id": med["id"]})


def edit_medication(ctx: ItemContext, data: dict, p: EditMedication) -> ActionOutcome:
    med = _find_med(data, p.med)
    if p.name:
        med["name"] = p.name.strip()
    _apply_med_fields(ctx, med, p)
    changed = 0
    if any(getattr(p, f) is not None for f in PLAN_FIELDS):
        eff = date.fromisoformat(_day(ctx, p.effective_from)) if p.effective_from else ctx.today
        if med.get("start") and eff.isoformat() < med["start"]:
            eff = date.fromisoformat(med["start"])
        plan = _plan_from(ctx, med, M.plan_on(med, eff), p)
        changed += M.change_plan(med, eff, plan)
    if p.taper:
        changed += _apply_taper(ctx, med, p.taper)
    if p.refill_add:
        med["remaining"] = round((med.get("remaining") or 0) + p.refill_add, 2)
    if p.active is False and med.get("active", True):
        M.stop(med, ctx.now)
    elif p.active is True and not med.get("active", True):
        M.resume(med, ctx.today, data)
    sup = M.supply(med, ctx.today)
    return ActionOutcome(
        summary=f"Updated {med['name']}" + (" — the new plan applies from then on; earlier days keep theirs" if changed else ""),
        result={"id": med["id"], "supply": sup, "plan_today": _when(med, ctx.today), "plan_steps": med.get("schedule_history", [])},
    )


class RemoveMedication(BaseModel):
    med: str = Field(description="Medication id or name")
    mode: Literal["stop", "delete"] = Field(
        default="stop", description="stop = mark stopped today, keep its history (default); delete = remove it and its dose log"
    )


def remove_medication(ctx: ItemContext, data: dict, p: RemoveMedication) -> ActionOutcome:
    med = _find_med(data, p.med)
    if p.mode == "delete":
        data["medications"] = [m for m in data["medications"] if m["id"] != med["id"]]
        data["doses"] = [d for d in data["doses"] if d["med_id"] != med["id"]]
        return ActionOutcome(summary=f"Deleted {med['name']} and its dose history")
    if not med.get("active", True):
        raise ActionError(f"{med['name']} is already stopped.")
    M.stop(med, ctx.now)
    return ActionOutcome(summary=f"Stopped {med['name']} — its history stays")


class DoseIn(BaseModel):
    med: str = Field(description="Medication id or name, or 'all' for every dose due so far today")
    status: Literal["taken", "late", "skipped"] | None = Field(
        default=None, description="Default taken (or late when more than 1 h after the scheduled time)"
    )
    slot: Hhmm | None = Field(default=None, description="Which scheduled time (HH:MM); default the nearest unlogged one")
    day: str | None = Field(default=None, description="YYYY-MM-DD; default the day of 'at' or today")
    at: datetime | None = Field(default=None, description="When it was taken; default now")
    note: str = Field(default="", max_length=300)


class LogDose(BaseModel):
    doses: list[DoseIn] = Field(min_length=1, max_length=60)


def _record_dose(ctx: ItemContext, data: dict, med: dict, day: date, slot: str | None, status: str | None,
                 at: datetime, note: str, existing: set[str]) -> tuple[dict, list[str]]:
    if status is None:
        status = "taken"
        if slot is not None and at - M.slot_moment(day, slot, ctx.tz) > M.LATE_AFTER:
            status = "late"
    prev = None
    if slot is not None:
        prev = next((d for d in data["doses"] if d["med_id"] == med["id"] and d["day"] == day.isoformat() and d.get("slot") == slot), None)
    was_taken = prev is not None and prev["status"] in ("taken", "late")
    now_taken = status in ("taken", "late")
    limits = M.limit_warnings(data, med, at) if now_taken and not was_taken else []
    if prev is not None:
        prev.update(status=status, at=_iso(at) if now_taken else None, note=note or prev.get("note", ""))
        rec = prev
    else:
        rec = {
            "id": _new_id("d", existing, "dose", med["id"], day.isoformat(), slot, _iso(at)),
            "med_id": med["id"], "day": day.isoformat(), "slot": slot, "status": status,
            "at": _iso(at) if now_taken else None, "note": note,
        }
        data["doses"].append(rec)
    if med.get("remaining") is not None and was_taken != now_taken:
        delta = M.slot_units(med, day, slot) * (-1 if now_taken else 1)
        med["remaining"] = max(0.0, round(med["remaining"] + delta, 2))
    warn = list(limits)
    sup = M.supply(med, ctx.today)
    if sup and sup.get("days_left") is not None and sup["days_left"] <= data["settings"].get("refill_days", 7):
        warn.append(f"{med['name']}: about {sup['days_left']:.0f} days left ({sup['remaining']:g} units) — time to refill.")
    return rec, warn


def log_dose(ctx: ItemContext, data: dict, p: LogDose) -> ActionOutcome:
    existing = _ids(data["doses"])
    done: list[tuple[dict, dict]] = []
    warns: list[str] = []
    for item in p.doses:
        at = _aware(ctx, item.at)
        day = date.fromisoformat(_day(ctx, item.day)) if item.day else at.date()
        if item.med.strip().lower() in ("all", "all_due", "everything"):
            due = [r for r in M.due_today(data, at) if r["state"] == "due"] if day == at.date() else []
            if not due:
                raise ActionError("Nothing is due right now — every dose so far today is already logged.")
            for r in due:
                med = _find_med(data, r["med_id"])
                rec, w = _record_dose(ctx, data, med, day, r["time"], item.status, at, item.note, existing)
                done.append((med, rec))
                warns += [x for x in w if x not in warns]
            continue
        med = _find_med(data, item.med)
        times = M.times_on(med, day)
        slot = item.slot
        if M.is_as_needed_on(med, day):
            slot = None
        elif slot is not None:
            if slot not in times:
                raise ActionError(f"{med['name']} isn't scheduled at {slot} on {day.isoformat()} (times: {', '.join(times) or 'none that day'}).")
        else:
            logged = {d.get("slot") for d in data["doses"] if d["med_id"] == med["id"] and d["day"] == day.isoformat()}
            open_slots = [t for t in times if t not in logged]
            if not times:
                slot = None  # an extra dose on an off day: record as taken outside the schedule
            elif not open_slots:
                raise ActionError(f"Every {med['name']} dose on {day.isoformat()} is already logged.")
            else:
                minutes = at.hour * 60 + at.minute if day == at.date() else 12 * 60
                slot = min(open_slots, key=lambda t: abs(int(t[:2]) * 60 + int(t[3:]) - minutes))
        rec, w = _record_dose(ctx, data, med, day, slot, item.status, at, item.note, existing)
        done.append((med, rec))
        warns += [x for x in w if x not in warns]
    data["doses"].sort(key=lambda d: (d["day"], d.get("slot") or "99"))
    _cap(data["doses"], MAX_DOSES, "dose records")
    words = [f"{m['name']} {r['slot'] or ''} {r['status']}".replace("  ", " ") for m, r in done]
    return ActionOutcome(
        summary="Logged " + ", ".join(words[:6]) + (f" and {len(words) - 6} more" if len(words) > 6 else ""),
        result={
            "doses": [{"id": r["id"], "med": m["name"], "slot": r["slot"], "status": r["status"]} for m, r in done],
            "refill_warnings": [w for w in warns if "time to refill" in w],
            "limit_warnings": [w for w in warns if "time to refill" not in w],
        },
    )


# ----------------------------------------------------------------- records


class AddAppointment(BaseModel):
    at: datetime = Field(description="Date and time (ISO)")
    title: str = Field(default="", max_length=160, description="Why — 'Annual check-up', 'Knee follow-up'")
    who: str = Field(default="", max_length=120, description="Doctor / clinic name")
    provider_id: str | None = Field(default=None, description="A care-team id from the profile, if it's one of theirs")
    location: str = Field(default="", max_length=300)
    questions: list[str] = Field(default_factory=list, max_length=40, description="Questions to ask")
    notes: str = Field(default="", max_length=4000)


def add_appointment(ctx: ItemContext, data: dict, p: AddAppointment) -> ActionOutcome:
    at = _aware(ctx, p.at)
    who = p.who.strip()
    if p.provider_id:
        prov = next((c for c in data["profile"]["care_team"] if c["id"] == p.provider_id), None)
        if prov is None:
            raise ActionError(f"No care-team entry with id {p.provider_id!r}.")
        who = who or prov["name"]
    row = {
        "id": _new_id("a", _ids(data["appointments"]), "appt", _iso(at), p.title, who),
        "at": _iso(at), "title": p.title.strip(), "who": who, "provider_id": p.provider_id,
        "location": p.location.strip(), "questions": [q.strip() for q in p.questions if q.strip()],
        "notes": p.notes.strip(), "done": False,
    }
    data["appointments"].append(row)
    data["appointments"].sort(key=lambda a: a["at"])
    return ActionOutcome(summary=f"Added appointment {at.strftime('%a %d %b %H:%M')}{' · ' + who if who else ''}", result={"id": row["id"]})


class UpdateAppointment(BaseModel):
    id: str
    at: datetime | None = None
    title: str | None = Field(default=None, max_length=160)
    who: str | None = Field(default=None, max_length=120)
    location: str | None = Field(default=None, max_length=300)
    add_questions: list[str] = Field(default_factory=list, max_length=40)
    questions: list[str] | None = Field(default=None, max_length=40, description="Replace the whole list")
    notes: str | None = Field(default=None, max_length=4000, description="Replace the notes (what was said, the plan)")
    done: bool | None = None


def update_appointment(ctx: ItemContext, data: dict, p: UpdateAppointment) -> ActionOutcome:
    a = next((x for x in data["appointments"] if x["id"] == p.id), None)
    if a is None:
        raise ActionError(f"No appointment with id {p.id!r}.")
    if p.at is not None:
        a["at"] = _iso(_aware(ctx, p.at))
    for f in ("title", "who", "location", "notes", "done"):
        v = getattr(p, f)
        if v is not None:
            a[f] = v.strip() if isinstance(v, str) else v
    if p.questions is not None:
        a["questions"] = [q.strip() for q in p.questions if q.strip()]
    for q in p.add_questions:
        if q.strip() and q.strip() not in a["questions"]:
            a["questions"].append(q.strip())
    a["questions"] = a["questions"][:40]
    data["appointments"].sort(key=lambda x: x["at"])
    return ActionOutcome(summary=f"Updated the appointment on {a['at'][:10]}", result={"id": a["id"]})


class LabIn(BaseModel):
    test: str = Field(min_length=1, max_length=120, description="'HbA1c', 'LDL cholesterol', 'Ferritin'")
    value: float | None = None
    value_text: str = Field(default="", max_length=120, description="For non-numeric results: 'negative'")
    unit: str = Field(default="", max_length=30)
    ref_low: float | None = Field(default=None, description="The lab's own reference range, as printed")
    ref_high: float | None = None
    flag: Literal["", "normal", "low", "high", "critical", "abnormal"] = Field(
        default="", description="As the lab flagged it; default worked out from the range"
    )
    day: str | None = Field(default=None, description="The date it was COLLECTED, YYYY-MM-DD, not the date it was reported or printed; default today")
    time: str = Field(default="", pattern=r"^(|([01]\d|2[0-3]):[0-5]\d)$", description="The time it was collected, 24-hour HH:MM, if the report gives one")
    panel: str = Field(default="", max_length=80)
    note: str = Field(default="", max_length=500)
    source: str = Field(default="", max_length=200, description="The file name of the report it came from")


class AddLabResults(BaseModel):
    results: list[LabIn] = Field(min_length=1, max_length=80)


def _auto_flag(r: dict) -> str:
    if r.get("flag"):
        return r["flag"]
    v = r.get("value")
    if v is None:
        return ""
    if r.get("ref_low") is not None and v < r["ref_low"]:
        return "low"
    if r.get("ref_high") is not None and v > r["ref_high"]:
        return "high"
    if r.get("ref_low") is not None or r.get("ref_high") is not None:
        return "normal"
    return ""


def add_lab_result(ctx: ItemContext, data: dict, p: AddLabResults) -> ActionOutcome:
    existing = _ids(data["labs"])
    out = []
    # The same report sent twice isn't two blood tests.
    def same(r: dict) -> tuple:
        return (r["day"], r["test"].strip().casefold(), r["value"], r["value_text"].strip().casefold(), r["unit"].strip().casefold())

    logged = {same(r) for r in data["labs"]}
    repeats = 0
    for i, r in enumerate(p.results):
        if r.value is None and not r.value_text.strip():
            raise ActionError(f"{r.test}: give a value or value_text.")
        if r.ref_low is not None and r.ref_high is not None and r.ref_low > r.ref_high:
            raise ActionError(f"{r.test}: the reference range is back to front.")
        row = {
            "day": _day(ctx, r.day), "test": r.test.strip(), "value": r.value, "value_text": r.value_text.strip(),
            "unit": r.unit.strip(), "ref_low": r.ref_low, "ref_high": r.ref_high, "flag": r.flag,
            "panel": r.panel.strip(), "note": r.note.strip(), "time": r.time, "source": r.source.strip(),
        }
        if same(row) in logged:
            repeats += 1
            continue
        logged.add(same(row))
        row["flag"] = _auto_flag(row)
        row = {"id": _new_id("l", existing, "lab", row, i), **row}
        data["labs"].append(row)
        out.append(row)
    data["labs"].sort(key=lambda x: x["day"])
    flagged = [f"{r['test']} {r['flag']}" for r in out if r["flag"] in ("low", "high", "critical", "abnormal")]
    return ActionOutcome(
        summary=f"Added {len(out)} lab result{'s' if len(out) != 1 else ''}"
        + (f" · {repeats} already logged" if repeats else "")
        + (f" · flagged: {', '.join(flagged)}" if flagged else ""),
        result={"ids": [r["id"] for r in out], "flagged": flagged, "already_logged": repeats},
    )


class AddVaccination(BaseModel):
    name: str = Field(min_length=1, max_length=120, description="'Influenza', 'COVID-19', 'Tetanus (Tdap)'")
    day: str | None = Field(default=None, description="YYYY-MM-DD; default today")
    dose_label: str = Field(default="", max_length=60)
    next_due: str | None = Field(default=None, description="When the next dose/booster is due, YYYY-MM-DD")
    provider: str = Field(default="", max_length=120)
    lot: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=500)


def add_vaccination(ctx: ItemContext, data: dict, p: AddVaccination) -> ActionOutcome:
    row = {
        "day": _day(ctx, p.day), "name": p.name.strip(), "dose_label": p.dose_label.strip(),
        "next_due": _day(ctx, p.next_due) if p.next_due else None, "provider": p.provider.strip(),
        "lot": p.lot.strip(), "note": p.note.strip(),
    }
    row = {"id": _new_id("v", _ids(data["vaccinations"]), "vax", row), **row}
    data["vaccinations"].append(row)
    data["vaccinations"].sort(key=lambda x: x["day"])
    return ActionOutcome(summary=f"Added vaccination {row['name']} ({row['day']})", result={"id": row["id"]})


# ---------------------------------------------------------------- profile


class SetProfile(BaseModel):
    height: float | None = Field(default=None, gt=0, description="Height in height_unit (default the person's length unit)")
    height_unit: str | None = Field(default=None, description="cm / in / m")
    birth_date: str | None = Field(default=None, description="YYYY-MM-DD")
    sex: Literal["female", "male", "intersex", "unspecified"] | None = Field(default=None, description="Sex for BMR/reference ranges")
    blood_type: Literal["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] | None = None
    conditions: list[str] | None = Field(default=None, max_length=60, description="Replace the list")
    add_conditions: list[str] = Field(default_factory=list, max_length=20)
    allergies: list[str] | None = Field(default=None, max_length=60, description="Replace the list")
    add_allergies: list[str] = Field(default_factory=list, max_length=20)
    emergency_contact: str | None = Field(default=None, max_length=300)
    emergency_notes: str | None = Field(default=None, max_length=2000)
    # Preferences
    weight_unit: Literal["kg", "lb"] | None = None
    length_unit: Literal["cm", "in"] | None = None
    glucose_unit: Literal["mmol", "mgdl"] | None = None
    temp_unit: Literal["c", "f"] | None = None
    water_unit: Literal["ml", "oz"] | None = None
    cycle_tracking: bool | None = None
    med_reminders: bool | None = None
    refill_reminders: bool | None = None
    refill_days: int | None = Field(default=None, ge=1, le=60)
    appointment_reminders: bool | None = None
    weigh_in_time: str | None = Field(default=None, description="HH:MM for a daily weigh-in reminder; '' turns it off")
    discreet_reminders: bool | None = Field(default=None, description="Notifications without medicine names")
    today_tiles: list[str] | None = Field(default=None, max_length=24, description="Metric ids shown as Today tiles, in order")


def _merge_list(cur: list[str], add: list[str]) -> list[str]:
    low = {c.lower() for c in cur}
    out = list(cur)
    for a in add:
        a = a.strip()[:120]
        if a and a.lower() not in low:
            out.append(a)
            low.add(a.lower())
    return out[:60]


def set_profile(ctx: ItemContext, data: dict, p: SetProfile) -> ActionOutcome:
    prof, st = data["profile"], data["settings"]
    changed = []
    if p.height is not None:
        u = p.height_unit or ("in" if st.get("length_unit") == "in" else "cm")
        try:
            cm = S.to_canonical(p.height, "length", u, st)
        except ValueError as e:
            raise ActionError(f"Height: {e}.") from e
        if not 40 <= cm <= 260:
            raise ActionError("That height doesn't look right — check the unit.")
        prof["height_cm"] = round(cm, 1)
        changed.append("height")
    if p.birth_date is not None:
        d = _day(ctx, p.birth_date) if p.birth_date else None
        if d and d > ctx.today.isoformat():
            raise ActionError("The birth date is in the future.")
        prof["birth_date"] = d
        changed.append("date of birth")
    for f in ("sex", "blood_type", "emergency_contact", "emergency_notes"):
        v = getattr(p, f)
        if v is not None:
            prof[f] = v.strip() if isinstance(v, str) else v
            changed.append(f.replace("_", " "))
    if p.conditions is not None:
        prof["conditions"] = _merge_list([], p.conditions)
        changed.append("conditions")
    if p.add_conditions:
        prof["conditions"] = _merge_list(prof["conditions"], p.add_conditions)
        changed.append("conditions")
    if p.allergies is not None:
        prof["allergies"] = _merge_list([], p.allergies)
        changed.append("allergies")
    if p.add_allergies:
        prof["allergies"] = _merge_list(prof["allergies"], p.add_allergies)
        changed.append("allergies")
    for f in ("weight_unit", "length_unit", "glucose_unit", "temp_unit", "water_unit", "cycle_tracking",
              "med_reminders", "refill_reminders", "refill_days", "appointment_reminders", "discreet_reminders"):
        v = getattr(p, f)
        if v is not None:
            st[f] = v
            changed.append(f.replace("_", " "))
    if p.weigh_in_time is not None:
        t = p.weigh_in_time.strip()
        if t and (len(t) != 5 or t[2] != ":" or not t.replace(":", "").isdigit() or int(t[:2]) > 23 or int(t[3:]) > 59):
            raise ActionError("weigh_in_time must be HH:MM (or '' to turn it off).")
        st["weigh_in_time"] = t or None
        changed.append("weigh-in reminder")
    if p.today_tiles is not None:
        tiles = []
        for t in p.today_tiles:
            mid = S.resolve_metric(data, t)
            if mid and (mid in S.BUILTIN or any(c["id"] == mid for c in data["custom_metrics"])) and mid not in tiles:
                tiles.append(mid)
        st["today_tiles"] = tiles
        changed.append("Today tiles")
    st["onboarded"] = True
    if not changed:
        return ActionOutcome(summary="Nothing to change", result={"profile": prof, "settings": st})
    return ActionOutcome(summary="Updated " + ", ".join(dict.fromkeys(changed)), result={"changed": list(dict.fromkeys(changed))})


class SaveCareProvider(BaseModel):
    id: str | None = Field(default=None, description="Existing id to edit; omit to add")
    name: str = Field(min_length=1, max_length=120)
    role: str = Field(default="", max_length=80, description="GP, Cardiologist, Dentist, Physio…")
    clinic: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=60)
    email: str = Field(default="", max_length=160)
    address: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=1000)


def save_care_provider(ctx: ItemContext, data: dict, p: SaveCareProvider) -> ActionOutcome:
    team = data["profile"]["care_team"]
    fields = p.model_dump(exclude={"id"})
    fields = {k: v.strip() for k, v in fields.items()}
    if p.id:
        row = next((c for c in team if c["id"] == p.id), None)
        if row is None:
            raise ActionError(f"No care-team entry with id {p.id!r}.")
        row.update(fields)
        return ActionOutcome(summary=f"Updated {row['name']}", result={"id": row["id"]})
    row = {"id": _new_id("c", _ids(team), "care", fields["name"], fields["role"]), **fields}
    team.append(row)
    return ActionOutcome(summary=f"Added {row['name']} to your care team", result={"id": row["id"]})


class SetGoal(BaseModel):
    metric: str = Field(description="Metric id or name")
    target: float | None = Field(default=None, description="Target value (weight 75; water 2000 a day; steps 8000 a day)")
    low: float | None = Field(default=None, description="Lower edge of a healthy band (glucose 4)")
    high: float | None = Field(default=None, description="Upper edge of a band (glucose 7, BP systolic 130)")
    unit: str | None = Field(default=None, description="Unit of target/low/high; default the person's own")
    target_date: str | None = Field(default=None, description="Optional YYYY-MM-DD to reach it by")
    remove: bool = False


def set_goal(ctx: ItemContext, data: dict, p: SetGoal) -> ActionOutcome:
    mid = _metric_or_fail(data, p.metric)
    info = S.metric_info(data, mid)
    assert info is not None
    data["goals"] = [g for g in data["goals"] if g["metric"] != mid] if p.remove else data["goals"]
    if p.remove:
        return ActionOutcome(summary=f"Removed the {info['label'].lower()} goal")
    if p.target is None and p.low is None and p.high is None:
        raise ActionError("Give a target, or a low/high band.")

    def conv(v: float | None) -> float | None:
        if v is None:
            return None
        try:
            return round(S.to_canonical(v, info["dim"], p.unit, data["settings"]), 3)
        except ValueError as e:
            raise ActionError(f"{info['label']}: {e}.") from e

    target, low, high = conv(p.target), conv(p.low), conv(p.high)
    if low is not None and high is not None and low > high:
        raise ActionError("low is above high.")
    series = S.daily(data, mid)
    current = None
    if series:
        current = list(S.ewma(series, data["settings"].get("smoothing", 0.1)).values())[-1] if info["smooth"] else list(series.values())[-1]
    if info["agg"] == "sum" or mid == "steps" or (info["custom"] and info["agg"] in ("sum", "max")):
        direction = "daily"
    elif target is None:
        direction = "range"
    elif current is not None:
        direction = "down" if target < current else "up"
    else:
        direction = "down" if info["higher_is_better"] is False else "up"
    goal = {
        "metric": mid, "target": target, "low": low, "high": high, "direction": direction,
        "target_date": _day(ctx, p.target_date) if p.target_date else None,
        "start_value": round(current, 3) if current is not None else None, "start_day": ctx.today.isoformat(),
    }
    data["goals"] = [g for g in data["goals"] if g["metric"] != mid] + [goal]
    shown = S.fmt_value(data, mid, target) if target is not None else f"{S.fmt_value(data, mid, low)} – {S.fmt_value(data, mid, high)}"
    return ActionOutcome(summary=f"Goal: {info['label'].lower()} {shown}{' a day' if direction == 'daily' else ''}", result={"goal": goal})


class DefineCustomMetric(BaseModel):
    name: str = Field(min_length=1, max_length=60, description="'Caffeine', 'Pain-free minutes', 'Peak flow'")
    unit: str = Field(default="", max_length=20, description="Free text shown after values: 'mg', 'L/min'")
    aggregate: Literal["sum", "avg", "last", "max", "min"] = Field(
        default="avg", description="How a day's entries combine: sum (caffeine), avg (peak flow), last, max, min"
    )
    decimals: int = Field(default=1, ge=0, le=3)
    higher_is_better: bool | None = None
    goal: float | None = Field(default=None, description="Optional daily target")
    add_to_today: bool = Field(default=True, description="Show it as a quick-log tile on Today")


def define_custom_metric(ctx: ItemContext, data: dict, p: DefineCustomMetric) -> ActionOutcome:
    name = p.name.strip()
    base = "".join(ch if ch.isalnum() else "_" for ch in name.lower()).strip("_")[:30] or "metric"
    while "__" in base:
        base = base.replace("__", "_")
    if any(c["name"].strip().lower() == name.lower() for c in data["custom_metrics"]):
        raise ActionError(f"There's already a metric called {name}.")
    if S.resolve_metric(data, name) in S.BUILTIN:
        raise ActionError(f"{name} is a built-in metric already — log it directly.")
    mid, n = f"x_{base}"[:40], 2
    while any(c["id"] == mid for c in data["custom_metrics"]) or mid in S.BUILTIN:
        mid, n = f"x_{base}{n}"[:40], n + 1
    data["custom_metrics"].append({
        "id": mid, "name": name, "unit": p.unit.strip(), "aggregate": p.aggregate, "decimals": p.decimals,
        "higher_is_better": p.higher_is_better,
    })
    if p.goal is not None:
        direction = "daily" if p.aggregate in ("sum", "max") else ("down" if p.higher_is_better is False else "up")
        data["goals"].append({"metric": mid, "target": p.goal, "low": None, "high": None, "direction": direction,
                              "target_date": None, "start_value": None, "start_day": ctx.today.isoformat()})
    if p.add_to_today and mid not in data["settings"]["today_tiles"] and len(data["settings"]["today_tiles"]) < 24:
        data["settings"]["today_tiles"].append(mid)
    return ActionOutcome(summary=f"Added the metric {name}{' (' + p.unit + ')' if p.unit else ''}", result={"id": mid})


class EntryRef(BaseModel):
    type: Literal["reading", "symptom", "dose", "appointment", "lab", "vaccination", "period", "custom_metric", "care_provider", "goal"]
    id: str = Field(description="The entry's id (for period: the day YYYY-MM-DD; for goal: the metric id)")


class DeleteEntry(BaseModel):
    entries: list[EntryRef] = Field(min_length=1, max_length=200)


_TABLES = {
    "reading": "readings", "symptom": "symptoms", "dose": "doses", "appointment": "appointments",
    "lab": "labs", "vaccination": "vaccinations",
}


def delete_entry(ctx: ItemContext, data: dict, p: DeleteEntry) -> ActionOutcome:
    gone = 0
    for e in p.entries:
        if e.type in _TABLES:
            rows = data[_TABLES[e.type]]
            hit = next((r for r in rows if r["id"] == e.id), None)
            if hit is None:
                raise ActionError(f"No {e.type} with id {e.id!r}.")
            if e.type == "dose" and hit["status"] in ("taken", "late"):
                med = next((m for m in data["medications"] if m["id"] == hit["med_id"]), None)
                if med and med.get("remaining") is not None:
                    med["remaining"] = round(med["remaining"] + M.slot_units(med, date.fromisoformat(hit["day"]), hit.get("slot")), 2)
            rows.remove(hit)
        elif e.type == "period":
            before = len(data["periods"])
            data["periods"] = [x for x in data["periods"] if x["day"] != e.id]
            if len(data["periods"]) == before:
                raise ActionError(f"No period logged on {e.id}.")
        elif e.type == "custom_metric":
            if not any(c["id"] == e.id for c in data["custom_metrics"]):
                raise ActionError(f"No custom metric {e.id!r}.")
            data["custom_metrics"] = [c for c in data["custom_metrics"] if c["id"] != e.id]
            data["readings"] = [r for r in data["readings"] if r["metric"] != e.id]
            data["goals"] = [g for g in data["goals"] if g["metric"] != e.id]
            data["settings"]["today_tiles"] = [t for t in data["settings"]["today_tiles"] if t != e.id]
        elif e.type == "care_provider":
            team = data["profile"]["care_team"]
            if not any(c["id"] == e.id for c in team):
                raise ActionError(f"No care-team entry {e.id!r}.")
            data["profile"]["care_team"] = [c for c in team if c["id"] != e.id]
        elif e.type == "goal":
            if not any(g["metric"] == e.id for g in data["goals"]):
                raise ActionError(f"No goal for {e.id!r}.")
            data["goals"] = [g for g in data["goals"] if g["metric"] != e.id]
        gone += 1
    return ActionOutcome(summary=f"Deleted {gone} entr{'y' if gone == 1 else 'ies'}", result={"deleted": gone})


# ------------------------------------------------------------- read-only


class MetricSummary(BaseModel):
    metric: str = Field(description="Metric id or name; also bp_sys, bp_dia, pulse, sleep_quality, symptoms, symptom:<name>")
    days: int = Field(default=30, ge=1, le=3650, description="Range: the last N days (7, 30, 90, 365)")
    start: str | None = Field(default=None, description="Or an explicit range start YYYY-MM-DD")
    end: str | None = Field(default=None, description="Range end; default today")


def _rate(v: float, dim: str, settings: dict) -> float:
    """A canonical rate (per week) in display units (offset-free, for °F)."""
    return round(S.from_canonical(v, dim, settings) - S.from_canonical(0, dim, settings), 3)


def summarise_metric(data: dict, mid: str, start: str, end: str, today: date) -> dict | None:
    info = S.metric_info(data, mid) or {"label": mid, "unit": "/10", "dim": "none", "smooth": False, "decimals": 0, "agg": "max"}
    series = S.daily(data, mid, start, end)
    if not series:
        return None
    alpha = data["settings"].get("smoothing", 0.1)
    vals = list(series.values())
    disp = lambda v: round(S.from_canonical(v, info["dim"], data["settings"]), 2)  # noqa: E731
    out: dict[str, Any] = {
        "metric": mid, "label": info["label"],
        "unit": S.UNIT_LABEL.get(S.display_unit(data["settings"], info["dim"]), info["unit"]) if info["dim"] != "none" else info["unit"],
        "from": start, "to": end, "days_logged": len(series),
        "avg": disp(sum(vals) / len(vals)), "min": disp(min(vals)), "max": disp(max(vals)),
        "first": {"day": next(iter(series)), "value": disp(vals[0])},
        "last": {"day": list(series)[-1], "value": disp(vals[-1])},
    }
    pts = [((S.to_date(d) - S.to_date(start)).days, v) for d, v in series.items()]
    fit = S.linreg(pts)
    if fit:
        out["slope_per_week"] = _rate(fit[0] * 7, info["dim"], data["settings"])
    if info.get("smooth"):
        full = S.daily(data, mid, None, end)
        tr = S.ewma(full, alpha)
        in_range = {d: v for d, v in tr.items() if d >= start}
        if in_range:
            tv = list(in_range.values())
            out["trend_now"] = disp(tv[-1])
            out["trend_change"] = round(disp(tv[-1]) - disp(tv[0]), 2)
            # Weekly rate from the trend over its last 4 weeks (or the range, if shorter).
            span_start = max(start, (S.to_date(end) - timedelta(days=27)).isoformat())
            tpts = [((S.to_date(d) - S.to_date(span_start)).days, v) for d, v in in_range.items() if d >= span_start]
            tfit = S.linreg(tpts)
            if tfit:
                out["weekly_rate"] = _rate(tfit[0] * 7, info["dim"], data["settings"])
    goal = _goal(data, mid)
    if goal:
        g: dict[str, Any] = {k: (disp(goal[k]) if goal.get(k) is not None else None) for k in ("target", "low", "high")}
        g["direction"] = goal["direction"]
        cur = out.get("trend_now", out["last"]["value"])
        if goal["direction"] == "daily" and goal.get("target"):
            g["days_met"] = sum(1 for v in vals if v >= goal["target"])
        elif goal["direction"] in ("down", "up") and goal.get("target") is not None:
            tgt = disp(goal["target"])
            g["remaining"] = round(tgt - cur, 2)
            rate = out.get("weekly_rate", out.get("slope_per_week"))
            if rate and (tgt - cur) * rate > 0:
                weeks = (tgt - cur) / rate
                g["projected_date"] = (today + timedelta(days=round(weeks * 7))).isoformat()
            if goal.get("start_value") is not None and goal["target"] != goal["start_value"]:
                g["progress_pct"] = round(100 * (S.from_canonical(goal["start_value"], info["dim"], data["settings"]) - cur) / (S.from_canonical(goal["start_value"], info["dim"], data["settings"]) - tgt), 0)
        elif goal["direction"] == "range":
            lo, hi = goal.get("low"), goal.get("high")
            g["days_in_range_pct"] = round(100 * sum(1 for v in vals if (lo is None or v >= lo) and (hi is None or v <= hi)) / len(vals))
        out["goal"] = g
    if mid == "bp":
        rows = [r for r in data["readings"] if r["metric"] == "bp" and start <= r["at"][:10] <= end]
        cats: dict[str, int] = {}
        for r in rows:
            c = S.bp_category(r["sys"], r["dia"])
            if c:
                cats[c["label"]] = cats.get(c["label"], 0) + 1
        sys_avg = sum(r["sys"] for r in rows) / len(rows)
        dia_avg = sum(r["dia"] for r in rows) / len(rows)
        pulses = [r["pulse"] for r in rows if r.get("pulse")]
        out.update(
            readings=len(rows), avg_sys=round(sys_avg), avg_dia=round(dia_avg),
            avg_pulse=round(sum(pulses) / len(pulses)) if pulses else None,
            avg_category=(S.bp_category(round(sys_avg), round(dia_avg)) or {}).get("label"),
            categories=cats, crisis_readings=[f"{r['at'][:16]} {r['sys']}/{r['dia']}" for r in rows if S.bp_is_crisis(r["sys"], r["dia"])],
        )
        for k in ("avg", "min", "max", "first", "last", "slope_per_week"):
            out.pop(k, None)
        out["note"] = "avg/min/max are systolic; use bp_dia for the diastolic series."
    if mid == "glucose":
        rows = [r for r in data["readings"] if r["metric"] == "glucose" and start <= r["at"][:10] <= end and r["value"] is not None]
        by: dict[str, list[float]] = {}
        for r in rows:
            by.setdefault(r.get("context") or "unspecified", []).append(r["value"])
        out["by_context"] = {k: {"avg": disp(sum(v) / len(v)), "n": len(v)} for k, v in by.items()}
        unit = S.display_unit(data["settings"], "glucose")
        out["lows"] = sum(1 for r in rows if S.glucose_band(r["value"], r.get("context"), unit)["id"] in ("low", "very_low"))
    if mid == "sleep":
        out["nights_under_7h"] = sum(1 for v in vals if v < 7)
        q = list(S.daily(data, "sleep_quality", start, end).values())
        if q:
            out["avg_quality"] = round(sum(q) / len(q), 1)
    return out


def metric_summary(ctx: ItemContext, data: dict, p: MetricSummary) -> ActionOutcome:
    mid = _metric_or_fail(data, p.metric, allow_derived=True)
    start, end, n = _range(ctx, p.days, p.start, p.end)
    out = summarise_metric(data, mid, start, end, ctx.today)
    if out is None:
        return ActionOutcome(summary="", result={"metric": mid, "from": start, "to": end, "days_logged": 0, "note": "Nothing logged in that range."})
    return ActionOutcome(summary="", result=out)


class Correlate(BaseModel):
    metric_a: str = Field(description="e.g. sleep, steps, mood, caffeine (custom), symptom:headache, symptoms")
    metric_b: str
    lag_days: int = Field(default=0, ge=-14, le=14, description="Compare a on day d with b on day d+lag (1 = does a predict tomorrow's b?)")
    days: int = Field(default=90, ge=7, le=3650)


def correlate(ctx: ItemContext, data: dict, p: Correlate) -> ActionOutcome:
    a_id = _metric_or_fail(data, p.metric_a, allow_derived=True)
    b_id = _metric_or_fail(data, p.metric_b, allow_derived=True)
    start, end, _n = _range(ctx, p.days, None, None)
    a = S.daily(data, a_id, start, end)
    b = S.daily(data, b_id, (S.to_date(start) + timedelta(days=p.lag_days)).isoformat(), (S.to_date(end) + timedelta(days=p.lag_days)).isoformat())
    # Symptoms: a day with none logged counts as 0 (only on days the other metric was logged).
    if a_id == "symptoms" or a_id.startswith("symptom:"):
        for d in b:
            k = (S.to_date(d) - timedelta(days=p.lag_days)).isoformat()
            if start <= k <= end:
                a.setdefault(k, 0.0)
    if b_id == "symptoms" or b_id.startswith("symptom:"):
        for d in a:
            b.setdefault((S.to_date(d) + timedelta(days=p.lag_days)).isoformat(), 0.0)
    xs, ys = [], []
    for d, v in sorted(a.items()):
        k = (S.to_date(d) + timedelta(days=p.lag_days)).isoformat()
        if k in b:
            xs.append(v)
            ys.append(b[k])
    res: dict[str, Any] = {"metric_a": a_id, "metric_b": b_id, "lag_days": p.lag_days, "from": start, "to": end, "paired_days": len(xs)}
    r = S.pearson(xs, ys)
    if r is None or len(xs) < 7:
        res["note"] = "Not enough days with both logged (need at least 7 with some variation)."
        return ActionOutcome(summary="", result=res)
    pv = S.p_value_approx(r, len(xs))
    res.update(
        r=round(r, 3), strength=S.strength(r), direction="positive" if r > 0 else "negative",
        p_approx=round(pv, 4) if pv is not None else None,
        likely_chance=(pv is None or pv > 0.05),
        caveat="Correlation over self-logged days, not causation; other factors (stress, illness, season, what gets logged on bad days) can drive both.",
    )
    return ActionOutcome(summary="", result=res)


class AdherenceReport(BaseModel):
    days: int = Field(default=30, ge=1, le=365)
    med: str | None = Field(default=None, description="One medication (id or name); default all")


def adherence_report(ctx: ItemContext, data: dict, p: AdherenceReport) -> ActionOutcome:
    med_id = _find_med(data, p.med)["id"] if p.med else None
    rep = M.adherence(data, ctx.now, p.days, med_id)
    rep["supply"] = []
    for m in data["medications"]:
        if (med_id and m["id"] != med_id) or not m.get("active", True):
            continue
        sup = M.supply(m, ctx.today)
        if sup:
            sup = {"name": m["name"], **sup, "refill_now": sup["days_left"] is not None and sup["days_left"] <= data["settings"].get("refill_days", 7)}
            rep["supply"].append(sup)
    return ActionOutcome(summary="", result=rep)


class RangeArgs(BaseModel):
    days: int = Field(default=90, ge=7, le=3650, description="How far back to look")


def doctor_visit_summary(ctx: ItemContext, data: dict, p: RangeArgs) -> ActionOutcome:
    start, end, _ = _range(ctx, p.days, None, None)
    prof = data["profile"]
    age = S.age_years(prof.get("birth_date"), ctx.today)
    metrics = {}
    for mid in ["bp", "weight", "resting_hr", "glucose", "sleep", "body_fat", "waist", "spo2", "temperature", "mood", "energy", "steps"] + [c["id"] for c in data["custom_metrics"]]:
        s = summarise_metric(data, mid, start, end, ctx.today)
        if s:
            metrics[mid] = s
    sym: dict[str, dict] = {}
    for s in data["symptoms"]:
        if start <= s["at"][:10] <= end:
            row = sym.setdefault(s["name"].strip().lower(), {"name": s["name"], "times": 0, "sev": [], "last": s["at"][:10], "tags": {}})
            row["times"] += 1
            row["sev"].append(s["severity"])
            row["last"] = max(row["last"], s["at"][:10])
            for t in s["tags"]:
                row["tags"][t] = row["tags"].get(t, 0) + 1
    symptoms = sorted(
        ({"name": r["name"], "times": r["times"], "avg_severity": round(sum(r["sev"]) / len(r["sev"]), 1), "worst": max(r["sev"]),
          "last": r["last"], "common_tags": [t for t, _ in sorted(r["tags"].items(), key=lambda x: -x[1])[:3]]} for r in sym.values()),
        key=lambda r: -r["times"],
    )[:15]
    adh = M.adherence(data, ctx.now, min(p.days, 90))
    meds_out = []
    for m in data["medications"]:
        if not m.get("active", True) and not (m.get("end") and m["end"] >= start):
            continue
        sch = m["schedule"]
        a = next((r for r in adh["medications"] if r["med_id"] == m["id"]), None)
        meds_out.append({
            "name": m["name"], "dose": m.get("dose", ""), "kind": m.get("kind"), "active": m.get("active", True),
            "schedule": "as needed" if sch["type"] == "as_needed" else f"{sch['type']} at {_when(m, min(ctx.today, date.fromisoformat(m['end'])) if m.get('end') else ctx.today)}",
            "dose_changes": [{"until": st["until"], "dose": st.get("dose", ""), "stopped": st.get("stopped", False)} for st in m.get("schedule_history", [])][-10:],
            "since": m.get("start"), "until": m.get("end"), "adherence_pct": a["adherence_pct"] if a else None,
            "purpose": m.get("purpose", ""),
        })
    labs = [
        {k: r[k] for k in ("day", "test", "value", "value_text", "unit", "ref_low", "ref_high", "flag")}
        for r in data["labs"] if start <= r["day"] <= end
    ]
    upcoming = [a for a in data["appointments"] if a["at"] >= _iso(ctx.now) and not a.get("done")]
    nxt = upcoming[0] if upcoming else None
    vax_due = [{"name": v["name"], "next_due": v["next_due"]} for v in data["vaccinations"] if v.get("next_due") and v["next_due"] <= (ctx.today + timedelta(days=90)).isoformat()]
    out = {
        "period": {"from": start, "to": end},
        "about": {
            "age": age, "sex": prof.get("sex"), "height_cm": prof.get("height_cm"),
            "conditions": prof.get("conditions", []), "allergies": prof.get("allergies", []),
        },
        "medications": meds_out,
        "metrics": metrics,
        "symptoms": symptoms,
        "labs": labs,
        "vaccinations_due": vax_due,
        "next_appointment": {"at": nxt["at"], "with": nxt["who"], "why": nxt["title"], "questions": nxt["questions"]} if nxt else None,
        "cycle": S.cycle_forecast(data["periods"], ctx.today) if data["settings"].get("cycle_tracking") else None,
        "format_hint": "Present as a one-page summary: About → Current medications (+adherence) → Key readings (averages, trend, AHA category) → Symptoms → Recent labs (flagged first) → Questions to ask. Facts only, no diagnosis.",
    }
    return ActionOutcome(summary="", result=out)


class NoArgs(BaseModel):
    pass


def bmi_and_ranges(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    prof, st = data["profile"], data["settings"]
    h = prof.get("height_cm")
    w_series = S.daily(data, "weight")
    weight = list(S.ewma(w_series, st.get("smoothing", 0.1)).values())[-1] if w_series else None
    age = S.age_years(prof.get("birth_date"), ctx.today)
    out: dict[str, Any] = {"height_cm": h, "weight_trend_kg": round(weight, 2) if weight else None, "age": age, "sex": prof.get("sex")}
    missing = [n for n, v in (("height", h), ("a weight", weight)) if not v]
    if not missing:
        b = S.bmi(weight, h)
        out["bmi"] = round(b, 1)
        out["bmi_band"] = S.bmi_band(b)
        lo, hi = 18.5 * (h / 100) ** 2, 24.9 * (h / 100) ** 2
        out["healthy_weight_range"] = f"{S.fmt_value(data, 'weight', lo)} – {S.fmt_value(data, 'weight', hi)} (BMI 18.5–24.9)"
        out["bmi_caveats"] = (
            "BMI is a population screening tool: it can't tell muscle from fat (athletes read high), under-reads "
            "risk in older adults and people of South/East Asian heritage (WHO suggests action points of 23 and 27.5), "
            "and doesn't apply in pregnancy or under 18 (use age percentiles). Waist measures add information."
        )
        if age:
            bmr = S.bmr_mifflin(weight, h, age, prof.get("sex", "unspecified"))
            if bmr:
                out["bmr_kcal"] = round(bmr)
            else:
                m, f = S.bmr_mifflin(weight, h, age, "male"), S.bmr_mifflin(weight, h, age, "female")
                out["bmr_kcal_range"] = [round(f), round(m)]
            out["bmr_note"] = "Mifflin–St Jeor resting energy; daily needs ≈ BMR × 1.2 (sedentary) to 1.9 (very active)."
    else:
        out["missing"] = f"Add {' and '.join(missing)} for BMI."
    waist = _latest(data, "waist")
    hip = _latest(data, "hip")
    if waist and h:
        whtr = waist["value"] / h
        out["waist_to_height"] = {"ratio": round(whtr, 2), "band": "healthy (<0.5)" if whtr < 0.5 else ("increased (0.5–0.6)" if whtr < 0.6 else "high (≥0.6)"), "source": "NICE 2022"}
    if waist and hip and hip["value"]:
        whr = waist["value"] / hip["value"]
        cut = 0.90 if prof.get("sex") == "male" else 0.85
        out["waist_to_hip"] = {"ratio": round(whr, 2), "who_threshold": cut, "above_threshold": whr > cut}
    bp = _latest(data, "bp")
    if bp:
        out["latest_bp"] = {"reading": f"{bp['sys']}/{bp['dia']}", "at": bp["at"], "aha_category": (S.bp_category(bp["sys"], bp["dia"]) or {}).get("label")}
    rhr = _latest(data, "resting_hr")
    if rhr:
        out["resting_hr"] = {"bpm": rhr["value"], "band": S.hr_band(rhr["value"])}
    out["references"] = {
        "bp_aha": "Normal <120/<80 · Elevated 120–129/<80 · Stage 1 130–139 or 80–89 · Stage 2 ≥140 or ≥90 · Crisis higher than 180 and/or higher than 120",
        "glucose_ada": "Fasting normal <100 mg/dL (5.6 mmol/L), prediabetes 100–125 (5.6–6.9), diabetes range ≥126 (7.0); "
                       "after meals normal <140 (7.8); with diabetes: pre-meal 80–130 (4.4–7.2), 1–2 h after meals <180 (10.0); low <70 (3.9), level 2 <54 (3.0)",
        "sleep": "Adults 7–9 h (AASM/NSF)",
        "resting_hr": "Adults 60–100 bpm (lower is common in fit people)",
        "spo2": "Typically 95–100%; 93–94% slightly low; 92% or less contact a clinician; under 90% urgent",
    }
    return ActionOutcome(summary="", result=out)


def today_overview(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    day = ctx.today.isoformat()
    numbers = {}
    for mid in list(S.BUILTIN) + [c["id"] for c in data["custom_metrics"]]:
        if mid == "bp":
            rows = [r for r in data["readings"] if r["metric"] == "bp" and r["at"][:10] == day]
            if rows:
                numbers["bp"] = [f"{r['sys']}/{r['dia']}" for r in rows]
            continue
        s = S.daily(data, mid, day, day)
        if s:
            numbers[mid] = S.fmt_value(data, mid, s[day])
    goals = []
    for g in data["goals"]:
        if g["direction"] == "daily" and g.get("target"):
            v = S.daily(data, g["metric"], day, day).get(day, 0)
            goals.append({"metric": g["metric"], "today": S.fmt_value(data, g["metric"], v), "target": S.fmt_value(data, g["metric"], g["target"]), "met": v >= g["target"]})
    out = {
        "day": day, "numbers": numbers, "daily_goals": goals, "meds": M.due_today(data, ctx.now),
        "symptoms_today": [f"{s['name']} {s['severity']}/10" for s in data["symptoms"] if s["at"][:10] == day],
    }
    if data["settings"].get("cycle_tracking"):
        out["cycle"] = S.cycle_forecast(data["periods"], ctx.today)
    return ActionOutcome(summary="", result=out)


def cycle_forecast(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    fc = S.cycle_forecast(data["periods"], ctx.today)
    if fc is None:
        return ActionOutcome(summary="", result={"note": "No periods logged yet."})
    fc["caveat"] = "Calendar estimate from past cycles — not reliable for contraception or conception timing on its own."
    return ActionOutcome(summary="", result=fc)


ACTIONS = [
    ItemAction("log_metrics", "Log one or many readings at once (weight, BP, sleep, glucose, water, mood, custom…). "
               "Use for anything the person measured; convert their words to readings. Returns warnings for out-of-range values.",
               LogMetrics, log_metrics),
    ItemAction("log_symptom", "Log symptoms with severity 1–10, tags (possible triggers) and notes.", LogSymptom, log_symptom),
    ItemAction("log_period", "Log (or clear) period days with flow, for cycle tracking (turns tracking on).", LogPeriod, log_period),
    ItemAction("add_medication", "Add a medication or supplement with its dose, form and schedule (and pills on hand).", AddMedication, add_medication),
    ItemAction("edit_medication", "Change a medication: dose, schedule, end date, pills on hand, a refill picked up (refill_add), or resume it.", EditMedication, edit_medication),
    ItemAction("remove_medication", "Stop a medication (keeps history) or delete it entirely.", RemoveMedication, remove_medication),
    ItemAction("log_dose", "Mark doses taken / late / skipped (one, many, or med='all' for everything due so far today). Updates pills left.", LogDose, log_dose),
    ItemAction("add_appointment", "Add an upcoming (or past) appointment with who, why, where and questions to ask.", AddAppointment, add_appointment),
    ItemAction("update_appointment", "Edit an appointment: move it, add questions, record notes/outcome, mark done.", UpdateAppointment, update_appointment),
    ItemAction("add_lab_result", "Add lab results (one or a whole panel) with value, unit and the lab's reference range; flags low/high automatically. From a report: log every result exactly as printed, on the date and time it was collected (not reported or printed), with source set to the file name. If the report shows no collection date, ask; never guess one. Sending the same result twice doesn't log it twice.", AddLabResults, add_lab_result, from_documents=True),
    ItemAction("add_vaccination", "Record a vaccination (and when the next dose/booster is due).", AddVaccination, add_vaccination, from_documents=True),
    ItemAction("set_profile", "Set profile facts (height, date of birth, sex, blood type, conditions, allergies, emergency info) "
               "and preferences (units, cycle tracking, reminders, Today tiles).", SetProfile, set_profile),
    ItemAction("save_care_provider", "Add or edit a doctor/clinic in the care team.", SaveCareProvider, save_care_provider),
    ItemAction("set_goal", "Set or remove a goal for a metric: a target (weight 75 kg), a daily target (water, steps, sleep) or a band (glucose 4–7).", SetGoal, set_goal),
    ItemAction("define_custom_metric", "Create a new metric to track (name, unit, how a day combines, optional goal).", DefineCustomMetric, define_custom_metric),
    ItemAction("delete_entry", "Delete entries by type and id (readings, symptoms, doses, appointments, labs, vaccinations, period days, custom metrics, care team, goals).", DeleteEntry, delete_entry),
    ItemAction("metric_summary", "Numbers for one metric over a range: avg/min/max, smoothed trend, weekly rate, goal progress and projected date; "
               "BP categories, glucose by context, short nights. Use before commenting on any trend.", MetricSummary, metric_summary, writes=False),
    ItemAction("correlate", "Pearson correlation between two metrics' daily values (optionally lagged), with strength and a chance check.", Correlate, correlate, writes=False),
    ItemAction("adherence_report", "Medication adherence (taken/late/skipped/missed, %) and supply / refill status.", AdherenceReport, adherence_report, writes=False),
    ItemAction("doctor_visit_summary", "A structured summary of the last N days to take to a GP: meds + adherence, key readings, symptoms, labs, questions.", RangeArgs, doctor_visit_summary, writes=False),
    ItemAction("bmi_and_ranges", "BMI (WHO band + caveats), healthy weight range, waist ratios, BMR, latest BP category and reference ranges.", NoArgs, bmi_and_ranges, writes=False),
    ItemAction("today_overview", "Today's numbers, daily goals, medication doses due/taken, symptoms and cycle day.", NoArgs, today_overview, writes=False),
    ItemAction("cycle_forecast", "The cycle estimate: cycle day, next period, fertile window, average lengths.", NoArgs, cycle_forecast, writes=False),
]
