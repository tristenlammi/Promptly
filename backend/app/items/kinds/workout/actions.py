"""The Workout item's actions: what the AI panel, chats and the UI can do.

Loads in arguments and results are in the person's display unit
(``settings.units``) unless an action's ``unit`` says otherwise; the file
stores kg. Every action is deterministic for (data, args, now): new ids are
hashes of the arguments and ``ctx.now``."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.items.kinds.workout import science as sci
from app.items.kinds.workout.catalog import EQUIPMENT, MUSCLES, PATTERNS
from app.items.kinds.workout.models import (
    LB,
    DAY,
    HHMM,
    Equip,
    Experience,
    Goal,
    LogType,
    Muscle,
    Pattern,
    SetType,
    default_plates,
    expand_in_place,
)
from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

Unitish = Literal["kg", "lb"] | None
MAX_PLANNED = 600
MAX_WORKOUTS = 2500
FULL_MSG = (
    "This file holds 2,500 workouts, its limit. Archive the older ones (file menu → Archive older data) "
    "to make room — they move to a new Workout file and stay searchable."
)


# -------------------------------------------------------------------- helpers


def _seed(ctx: ItemContext, *parts: Any) -> str:
    raw = json.dumps([ctx.now.isoformat(), *parts], sort_keys=True, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()


def _taken(data: dict) -> set[str]:
    ids: set[str] = set()
    for key in ("planned", "routines", "programs", "workouts", "exercises"):
        for row in data.get(key, []):
            ids.add(row.get("id", ""))
            for sub in row.get("exercises", []) if key != "exercises" else []:
                ids.add(sub.get("id", ""))
                sets = sub.get("sets")
                for s in sets if isinstance(sets, list) else []:
                    ids.add(s.get("id", ""))
    if data.get("active"):
        ids.add(data["active"]["id"])
        for we in data["active"].get("exercises", []):
            ids.add(we.get("id", ""))
            for s in we.get("sets", []):
                ids.add(s.get("id", ""))
    return ids


class Ids:
    """Deterministic, collision-free ids for one action run."""

    def __init__(self, ctx: ItemContext, data: dict, *seed: Any) -> None:
        self.base = _seed(ctx, *seed)
        self.taken = _taken(data)
        self.n = 0

    def __call__(self, prefix: str) -> str:
        while True:
            self.n += 1
            h = hashlib.sha1(f"{self.base}:{self.n}".encode()).hexdigest()[:7]
            cand = f"{prefix}{h}"
            if cand not in self.taken:
                self.taken.add(cand)
                return cand


def _settings(data: dict) -> dict:
    return data.setdefault("settings", {})


def _unit(data: dict, unit: str | None) -> str:
    return unit or _settings(data).get("units", "kg")


def _kg(v: float | None, unit: str) -> float | None:
    if v is None:
        return None
    return round(v * LB, 4) if unit == "lb" else round(float(v), 4)


# The heaviest load the file accepts (models.py: ``le=1500``) — well past any
# lift ever done; a bigger number is a typo (or the wrong unit).
MAX_LOAD_KG = 1500


def _load(v: float | None, unit: str) -> float | None:
    """A load argument in ``unit`` → kg, refusing impossible numbers with a
    clear message (instead of a validation error at save)."""
    kg = _kg(v, unit)
    if kg is not None and kg > MAX_LOAD_KG:
        raise ActionError(f"{v:g} {unit} isn't a plausible load (the limit is {MAX_LOAD_KG} kg) — check the number and the unit.")
    return kg


def _show(kg: float | None, data: dict) -> float | None:
    return sci.to_unit(kg, _settings(data))


def _fmt(kg: float | None, data: dict) -> str:
    return sci.fmt_kg(kg, _settings(data))


def _ex(data: dict, ref: str) -> dict:
    ex = sci.find_exercise(data, ref)
    if ex is None:
        close = sci.suggestions_for(data, ref)
        hint = f" Close matches: {', '.join(close)}." if close else ""
        raise ActionError(f"I don't know the exercise {ref!r}.{hint} Use list_exercises, or add_custom_exercise.")
    return ex


def _day(s: str | None, ctx: ItemContext) -> str:
    if not s:
        return ctx.today.isoformat()
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError as e:
        raise ActionError(f"{s!r} isn't a date (use YYYY-MM-DD).") from e


def _session(data: dict, sid: str) -> dict:
    s = next((p for p in data.get("planned", []) if p["id"] == sid), None)
    if s is None:
        raise ActionError(f"No planned session with id {sid!r}.")
    return s


def _make_room(data: dict, n: int, today: str) -> None:
    """Keep the planned list under its bound: drop the oldest finished /
    skipped / past sessions first."""
    planned = data.setdefault("planned", [])
    over = len(planned) + n - MAX_PLANNED
    if over <= 0:
        return
    old = sorted((p for p in planned if p.get("status") != "planned" or p["date"] < today), key=lambda p: p["date"])
    drop = {p["id"] for p in old[:over]}
    data["planned"] = [p for p in planned if p["id"] not in drop]
    if len(data["planned"]) + n > MAX_PLANNED:
        raise ActionError("The plan is full (600 sessions). Delete some old or future sessions first.")


def _rx_out(rx: dict, data: dict) -> dict:
    exs = sci.all_exercises(data)
    ex = exs.get(rx["exercise_id"], {"name": rx["exercise_id"]})
    out: dict[str, Any] = {"exercise": ex["name"], "exercise_id": rx["exercise_id"], "sets": rx.get("sets", 3)}
    lo, hi = rx.get("reps_min"), rx.get("reps_max")
    if ex.get("log") in ("duration",):
        out["seconds"] = rx.get("seconds")
    elif ex.get("log") == "distance":
        out["meters"] = rx.get("meters")
    else:
        out["reps"] = f"{lo}" if lo == hi else f"{lo}-{hi}"
    if rx.get("load_kg") is not None:
        out["load"] = _fmt(rx["load_kg"], data)
    elif rx.get("load_pct"):
        out["load"] = f"{rx['load_pct']:g}% e1RM"
    for k in ("superset", "rest_s", "notes"):
        if rx.get(k):
            out[k] = rx[k]
    if rx.get("drop_sets"):
        out["drop_sets"] = rx["drop_sets"]
    return out


def _session_out(s: dict, data: dict) -> dict:
    return {
        "id": s["id"],
        "date": s["date"],
        "time": s.get("time"),
        "name": s.get("name"),
        "status": s.get("status", "planned"),
        "deload": s.get("deload", False),
        "est_minutes": sci.estimate_minutes(s.get("exercises", []), data),
        "exercises": [_rx_out(rx, data) for rx in s.get("exercises", [])],
    }


# --------------------------------------------------------------- prescriptions


class PrescriptionIn(BaseModel):
    exercise: str = Field(description="Exercise id or name from the library (list_exercises), e.g. 'bench_press' or 'Bench Press (Barbell)'.")
    sets: int = Field(default=3, ge=1, le=20, description="Working sets (warm-ups are generated on their own).")
    reps: int | None = Field(default=None, ge=1, le=100, description="A single rep target (sets reps_min = reps_max).")
    reps_min: int | None = Field(default=None, ge=1, le=100, description="Bottom of the rep range (double progression).")
    reps_max: int | None = Field(default=None, ge=1, le=100, description="Top of the rep range.")
    load: float | None = Field(default=None, ge=0, le=3000, description="Working load in `unit` (for bodyweight lifts: added load; assisted: assistance). Omit to have it filled from their history.")
    load_pct: float | None = Field(default=None, ge=20, le=110, description="Load as % of their current estimated 1RM (instead of `load`).")
    seconds: int | None = Field(default=None, ge=1, le=86_400, description="Target time per set (planks, cardio).")
    meters: float | None = Field(default=None, gt=0, le=1_000_000, description="Target distance (runs, carries).")
    rest_s: int | None = Field(default=None, ge=0, le=900, description="Rest after each set; default from settings (compound vs isolation).")
    superset: str | None = Field(default=None, max_length=4, description="Same letter = done back to back (e.g. 'A').")
    drop_sets: int = Field(default=0, ge=0, le=3, description="Drop sets after the last working set.")
    warmup: bool | None = Field(default=None, description="Force warm-up sets on/off (default: automatic for the first heavy compound).")
    notes: str = Field(default="", max_length=300, description="Cue or instruction, e.g. 'pause 1 s on chest'.")


def _rx(data: dict, p: PrescriptionIn, ids: Ids, unit: str, *, fill: bool, today: date) -> dict:
    ex = _ex(data, p.exercise)
    lo = p.reps_min or p.reps or p.reps_max or (8 if ex["log"] in ("weight_reps", "bodyweight_reps", "assisted") else 1)
    hi = p.reps_max or p.reps or lo
    cardio = sci.is_cardio(ex)
    sets = p.sets if not cardio or "sets" in p.model_fields_set else 1  # cardio: one bout unless told
    seconds = p.seconds
    if cardio and ex["log"] == "duration" and seconds is None:
        seconds = sci.CARDIO_SECONDS
    rx = {
        "id": ids("x"),
        "exercise_id": ex["id"],
        "sets": sets,
        "reps_min": min(lo, hi),
        "reps_max": max(lo, hi),
        "seconds": seconds,
        "meters": p.meters,
        "load_kg": _load(p.load, unit),
        "load_pct": p.load_pct,
        "rest_s": p.rest_s,
        "superset": p.superset.upper() if p.superset else None,
        "warmup": p.warmup,
        "drop_sets": p.drop_sets,
        "notes": p.notes,
    }
    if rx["load_kg"] is not None:
        rx["load_kg"] = sci.round_load(rx["load_kg"], ex, _settings(data)) if ex["log"] == "weight_reps" else rx["load_kg"]
    if fill and rx["load_kg"] is None and not rx["load_pct"] and ex["log"] == "weight_reps":
        s = sci.next_load(data, ex, rx["reps_min"], rx["reps_max"], today=today)
        rx["load_kg"] = s.get("load_kg")
        if s.get("calibrate") and rx["load_kg"] is not None and "calibrat" not in rx["notes"].lower():
            rx["notes"] = (rx["notes"] + " · " if rx["notes"] else "") + "Calibration load — adjust after the first set"
            rx["notes"] = rx["notes"][:300]
    return rx


class SessionIn(BaseModel):
    date: str = Field(pattern=DAY, description="YYYY-MM-DD (their local day).")
    name: str = Field(default="Workout", max_length=80, description="e.g. 'Upper A', 'Push', 'Legs — heavy'.")
    time: str | None = Field(default=None, pattern=HHMM, description="Planned start time HH:MM, if they gave one (used for the reminder).")
    notes: str = Field(default="", max_length=1000)
    deload: bool = False
    exercises: list[PrescriptionIn] = Field(default_factory=list, max_length=30)


def _new_session(data: dict, s: SessionIn, ids: Ids, unit: str, *, fill: bool, today: date, program_id: str | None = None, week: int | None = None) -> dict:
    return {
        "id": ids("s"),
        "date": s.date,
        "time": s.time,
        "name": s.name,
        "notes": s.notes,
        "exercises": [_rx(data, e, ids, unit, fill=fill, today=today) for e in s.exercises],
        "program_id": program_id,
        "week": week,
        "deload": s.deload,
        "status": "planned",
        "workout_id": None,
    }


# ------------------------------------------------------------------- profile


# The standard bars in each unit system: (setting, kg bar, lb bar). A
# default bar follows a unit switch (a 20 kg bar becomes a 45 lb one).
BAR_STANDARDS = (("ez_bar_kg", 10, 25), ("trap_bar_kg", 25, 55))


class BaselineIn(BaseModel):
    exercise: str = Field(description="Exercise id or name, e.g. 'bench'.")
    load: float = Field(ge=0, le=3000, description="The load of their best set, in `units` (bodyweight lifts: added load; assisted: assistance).")
    reps: int = Field(ge=1, le=30, description="Reps they did with it (e.g. 90 × 5 → load 90, reps 5).")


class SetProfile(BaseModel):
    units: Literal["kg", "lb"] | None = None
    bodyweight: float | None = Field(default=None, ge=20, le=900, description="In `units` (or the current unit).")
    sex: Literal["", "male", "female"] | None = None
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    experience: Experience | None = None
    goal: Goal | None = None
    days_per_week: int | None = Field(default=None, ge=1, le=7)
    session_minutes: int | None = Field(default=None, ge=15, le=240)
    training_days: list[int] | None = Field(default=None, description="Preferred weekdays, 0 = Monday … 6 = Sunday.")
    equipment: list[Equip] | None = Field(default=None, description="What they can use. 'full_gym' = everything.")
    dumbbells: list[float] | None = Field(default=None, description="Exact dumbbells they own (per hand, in units) — home gyms.")
    dumbbell_max: float | None = Field(default=None, gt=0, le=300, description="Heaviest dumbbell (per hand, in units).")
    dumbbell_step: float | None = Field(default=None, gt=0, le=25)
    kettlebells: list[float] | None = None
    machine_step: float | None = Field(default=None, gt=0, le=50, description="Pin-stack increment, in units.")
    bar: float | None = Field(default=None, ge=0, le=130, description="Barbell weight, in units.")
    ez_bar: float | None = Field(default=None, ge=0, le=90, description="EZ-bar weight, in units.")
    trap_bar: float | None = Field(default=None, ge=0, le=130, description="Trap / hex bar weight, in units.")
    plates: list[float] | None = Field(default=None, description="Plate sizes they have (pairs), in units.")
    injuries: str | None = Field(default=None, max_length=1000, description="Injuries / limitations, in their words.")
    avoid_exercises: list[str] | None = None
    baselines: list[BaselineIn] | None = Field(default=None, max_length=60, description="Recent bests they state for lifts not logged here yet ('bench 90×5, squat 120×5'). Added / replaced per exercise; loads are calibrated from them until the lift is logged. Record these BEFORE planning.")
    remove_baselines: list[str] | None = Field(default=None, max_length=60, description="Exercises whose stated best to forget.")
    rest_compound_s: int | None = Field(default=None, ge=15, le=900)
    rest_isolation_s: int | None = Field(default=None, ge=15, le=900)
    week_start: Literal["mon", "sun"] | None = None
    reminders: bool | None = None
    reminder_time: str | None = Field(default=None, pattern=HHMM, description="When to nudge on a training day (HH:MM).")
    remind_before_min: int | None = Field(default=None, ge=0, le=720, description="For sessions with a time: minutes before.")


def set_profile(ctx: ItemContext, data: dict, p: SetProfile) -> ActionOutcome:
    st = _settings(data)
    changed: list[str] = []
    old_units = st.get("units", "kg")
    if p.units and p.units != old_units:
        st["units"] = p.units
        changed.append(f"units → {p.units}")
        # Switch default kit to the new unit's standard (if it was the default).
        if [round(x["kg"], 3) for x in st.get("plates", [])] == [round(x["kg"], 3) for x in default_plates(old_units)]:
            st["plates"] = default_plates(p.units)
        if abs(float(st.get("bar_kg", 20)) - (20 if old_units == "kg" else 45 * LB)) < 0.05:
            st["bar_kg"] = round(45 * LB, 4) if p.units == "lb" else 20.0
        if abs(float(st.get("machine_step_kg", 5)) - (5 if old_units == "kg" else 10 * LB)) < 0.05:
            st["machine_step_kg"] = round(10 * LB, 4) if p.units == "lb" else 5.0
        if abs(float(st.get("dumbbell_step_kg", 2)) - (2 if old_units == "kg" else 5 * LB)) < 0.05:
            st["dumbbell_step_kg"] = round(5 * LB, 4) if p.units == "lb" else 2.0
        for key, kg_std, lb_std in BAR_STANDARDS:
            if abs(float(st.get(key, kg_std)) - (kg_std if old_units == "kg" else lb_std * LB)) < 0.05:
                st[key] = round(lb_std * LB, 4) if p.units == "lb" else float(kg_std)
    unit = st.get("units", "kg")

    def put(key: str, val: Any, label: str) -> None:
        if val is not None:
            st[key] = val
            changed.append(label)

    put("bodyweight_kg", _kg(p.bodyweight, unit), f"bodyweight {p.bodyweight:g} {unit}" if p.bodyweight else "")
    put("sex", p.sex, "sex")
    put("birth_year", p.birth_year, "birth year")
    put("experience", p.experience, f"experience: {p.experience}")
    put("goal", p.goal, f"goal: {p.goal}")
    put("days_per_week", p.days_per_week, f"{p.days_per_week} days/week")
    put("session_minutes", p.session_minutes, f"{p.session_minutes} min sessions")
    put("training_days", p.training_days, "training days")
    put("equipment", p.equipment, "equipment")
    put("dumbbells_kg", [_kg(x, unit) for x in p.dumbbells] if p.dumbbells is not None else None, "dumbbells")
    put("dumbbell_max_kg", _kg(p.dumbbell_max, unit), "heaviest dumbbell")
    put("dumbbell_step_kg", _kg(p.dumbbell_step, unit), "dumbbell steps")
    put("kettlebells_kg", [_kg(x, unit) for x in p.kettlebells] if p.kettlebells is not None else None, "kettlebells")
    put("machine_step_kg", _kg(p.machine_step, unit), "machine step")
    put("bar_kg", _kg(p.bar, unit), "bar weight")
    put("ez_bar_kg", _kg(p.ez_bar, unit), "EZ-bar weight")
    put("trap_bar_kg", _kg(p.trap_bar, unit), "trap-bar weight")
    if p.plates is not None:
        st["plates"] = [{"kg": _kg(x, unit), "pairs": 10} for x in sorted(set(p.plates), reverse=True) if x > 0]
        changed.append("plates")
    put("injuries", p.injuries, "injuries / limitations")
    put("avoid_exercises", p.avoid_exercises, "exercises to avoid")
    if p.baselines or p.remove_baselines:
        base = [dict(b) for b in st.get("baselines") or []]
        gone = {_ex(data, r)["id"] for r in p.remove_baselines or []}
        base = [b for b in base if b["exercise_id"] not in gone]
        for b in p.baselines or []:
            ex = _ex(data, b.exercise)
            row = {"exercise_id": ex["id"], "kg": _load(b.load, unit), "reps": b.reps, "date": ctx.today.isoformat()}
            i = next((i for i, x in enumerate(base) if x["exercise_id"] == ex["id"]), None)
            if i is None:
                base.append(row)
            else:
                base[i] = row
        if len(base) > 60:
            raise ActionError("At most 60 stated bests — remove some first.")
        st["baselines"] = base
        changed.append(f"{len(p.baselines or [])} stated best{'s' if len(p.baselines or []) != 1 else ''}" if p.baselines else "stated bests")
    put("rest_compound_s", p.rest_compound_s, "compound rest")
    put("rest_isolation_s", p.rest_isolation_s, "isolation rest")
    put("week_start", p.week_start, "week start")
    put("reminders", p.reminders, "reminders on" if p.reminders else "reminders off")
    put("reminder_time", p.reminder_time, f"reminder at {p.reminder_time}")
    put("remind_before_min", p.remind_before_min, "reminder lead time")
    st["onboarded"] = True
    changed = [c for c in changed if c]
    if not changed:
        raise ActionError("Nothing to change — pass at least one setting.")
    return ActionOutcome(summary="Updated profile: " + ", ".join(changed[:8]), result={"settings": _profile_out(data)})


def _profile_out(data: dict) -> dict:
    st = _settings(data)
    return {
        "units": st.get("units"),
        "bodyweight": _show(st.get("bodyweight_kg"), data),
        "experience": st.get("experience"),
        "goal": st.get("goal"),
        "days_per_week": st.get("days_per_week"),
        "session_minutes": st.get("session_minutes"),
        "equipment": st.get("equipment"),
        "bar": _show(st.get("bar_kg"), data),
        "plates": [_show(x["kg"], data) for x in st.get("plates", [])],
        "injuries": st.get("injuries"),
        "stated_bests": [{"exercise_id": b["exercise_id"], "load": _show(b["kg"], data), "reps": b["reps"]} for b in st.get("baselines") or []],
    }


# ------------------------------------------------------------------- planning


class PlanWeek(BaseModel):
    sessions: list[SessionIn] = Field(min_length=1, max_length=14, description="The week's sessions, each with its exercises and prescriptions.")
    replace_existing: bool = Field(default=True, description="Remove not-yet-done planned sessions in the weeks these dates fall in first.")
    fill_loads: bool = Field(default=True, description="Fill any missing load from their history (or a calibration estimate).")
    program_id: str | None = Field(default=None, description="Attach to a program (from create_program).")
    week: int | None = Field(default=None, ge=1, le=52, description="Which program week this is.")
    unit: Unitish = Field(default=None, description="Unit of the loads given (default: their display unit).")


def plan_week(ctx: ItemContext, data: dict, p: PlanWeek) -> ActionOutcome:
    unit = _unit(data, p.unit)
    if p.program_id and not any(pr["id"] == p.program_id for pr in data.get("programs", [])):
        raise ActionError(f"No program with id {p.program_id!r}.")
    st = _settings(data)
    dates = sorted(s.date for s in p.sessions)
    if p.replace_existing:
        lo = sci.week_start(date.fromisoformat(dates[0]), st).isoformat()
        hi = (sci.week_start(date.fromisoformat(dates[-1]), st) + timedelta(days=7)).isoformat()
        data["planned"] = [s for s in data.get("planned", []) if not (lo <= s["date"] < hi and s.get("status") == "planned")]
    _make_room(data, len(p.sessions), ctx.today.isoformat())
    ids = Ids(ctx, data, "plan_week", p.model_dump())
    made = [
        _new_session(data, s, ids, unit, fill=p.fill_loads, today=ctx.today, program_id=p.program_id, week=p.week)
        for s in p.sessions
    ]
    data["planned"].extend(made)
    data["planned"].sort(key=lambda s: (s["date"], s.get("time") or ""))
    total_sets = sum(rx["sets"] for s in made for rx in s["exercises"])
    return ActionOutcome(
        summary=f"Planned {len(made)} session{'s' if len(made) != 1 else ''} ({dates[0]} → {dates[-1]}, {total_sets} working sets)",
        result={"sessions": [_session_out(s, data) for s in made], "volume_warnings": sci.volume_warnings(data, made)},
    )


class ProgramDayIn(BaseModel):
    weekday: int = Field(ge=0, le=6, description="0 = Monday … 6 = Sunday.")
    # Required: left optional, models skipped it and every day showed as "Workout".
    name: str = Field(min_length=1, max_length=80, description="The day's session name shown in the plan, e.g. 'Upper A', 'Push', 'Lower — heavy'.")
    time: str | None = Field(default=None, pattern=HHMM)
    notes: str = Field(default="", max_length=1000)
    exercises: list[PrescriptionIn] = Field(min_length=1, max_length=30)


class CreateProgram(BaseModel):
    name: str = Field(min_length=1, max_length=80, description="e.g. 'Hypertrophy block 1 — Upper/Lower'.")
    goal: Goal | None = None
    start_date: str | None = Field(default=None, pattern=DAY, description="Default today; week 1 is the week it falls in.")
    weeks: int = Field(default=5, ge=1, le=16, description="Mesocycle length including any deload week.")
    deload_weeks: list[int] | None = Field(default=None, description="Which weeks are deloads (1-based). Default: the last week when weeks ≥ 4.")
    days: list[ProgramDayIn] = Field(min_length=1, max_length=7, description="The weekly template: one entry per training day with week-1 prescriptions.")
    progression: Literal["double", "linear", "none"] = Field(
        default="double",
        description="double: double progression — week-1 loads stay planned and each lift earns its next increment by hitting the top of its rep range (the logger raises the load when it's earned), while isolation work gains a set every 2 weeks (volume accumulation). linear: + the smallest increment every week (novices). none: repeat week 1.",
    )
    notes: str = Field(default="", max_length=2000)
    replace_existing: bool = Field(default=True, description="Remove not-yet-done planned sessions in the program's date range first.")
    fill_loads: bool = True
    unit: Unitish = None

    @field_validator("progression", mode="before")
    @classmethod
    def _legacy(cls, v: Any) -> Any:
        return "double" if v == "rir_ramp" else v  # the old name


def create_program(ctx: ItemContext, data: dict, p: CreateProgram) -> ActionOutcome:
    unit = _unit(data, p.unit)
    st = _settings(data)
    start = date.fromisoformat(p.start_date) if p.start_date else ctx.today
    origin = sci.week_start(start, st)
    deloads = set(p.deload_weeks if p.deload_weeks is not None else ([p.weeks] if p.weeks >= 4 else []))
    deloads = {d for d in deloads if 1 <= d <= p.weeks}
    accum = [n for n in range(1, p.weeks + 1) if n not in deloads]
    ids = Ids(ctx, data, "create_program", p.model_dump())
    pid = ids("p")
    if p.replace_existing:
        lo, hi = start.isoformat(), (origin + timedelta(days=7 * p.weeks)).isoformat()
        data["planned"] = [s for s in data.get("planned", []) if not (lo <= s["date"] < hi and s.get("status") == "planned")]
    for pr in data.get("programs", []):
        if pr.get("status") == "active":
            pr["status"] = "done"
    first = 6 if st.get("week_start") == "sun" else 0
    # Week-1 prescriptions (loads filled once), then each week derived.
    templates = []
    for d in p.days:
        rxs = [_rx(data, e, ids, unit, fill=p.fill_loads, today=ctx.today) for e in d.exercises]
        templates.append((d, rxs))
    sessions: list[dict] = []
    exs = sci.all_exercises(data)
    for n in range(1, p.weeks + 1):
        deload = n in deloads
        i = accum.index(n) if n in accum else 0
        for d, rxs in templates:
            offset = (d.weekday - first) % 7
            day = origin + timedelta(days=7 * (n - 1) + offset)
            if day < start:
                continue
            out_rxs = []
            for rx in rxs:
                ex = exs[rx["exercise_id"]]
                r = dict(rx, id=ids("x"))
                if deload:
                    r["sets"] = max(1, math.ceil(rx["sets"] / 2))
                    r["drop_sets"] = 0
                    if rx["load_kg"] is not None and ex["log"] in ("weight_reps", "assisted"):
                        r["load_kg"] = sci.deload_load(rx["load_kg"], ex, st)  # lighter / more assistance
                    r["notes"] = "Deload: half the sets, ~10% lighter — leave the gym fresh."
                elif p.progression == "double" and len(accum) > 1:
                    if not ex["compound"]:
                        r["sets"] = min(rx["sets"] + i // 2, rx["sets"] + 2)
                elif p.progression == "linear" and rx["load_kg"] and ex["log"] == "weight_reps":
                    r["load_kg"] = sci.round_load(rx["load_kg"] + i * sci.increment(ex, st), ex, st)
                out_rxs.append(r)
            sessions.append(
                {
                    "id": ids("s"),
                    "date": day.isoformat(),
                    "time": d.time,
                    "name": d.name + (" (deload)" if deload else ""),
                    "notes": d.notes,
                    "exercises": out_rxs,
                    "program_id": pid,
                    "week": n,
                    "deload": deload,
                    "status": "planned",
                    "workout_id": None,
                }
            )
    _make_room(data, len(sessions), ctx.today.isoformat())
    data.setdefault("programs", []).append(
        {
            "id": pid,
            "name": p.name,
            "goal": p.goal or st.get("goal", ""),
            "start_date": start.isoformat(),
            "weeks": [
                {"n": n, "label": "Deload" if n in deloads else f"Week {n}", "deload": n in deloads, "notes": ""}
                for n in range(1, p.weeks + 1)
            ],
            "notes": p.notes,
            "status": "active",
        }
    )
    if len(data["programs"]) > 50:
        data["programs"] = data["programs"][-50:]
    data["planned"].extend(sessions)
    data["planned"].sort(key=lambda s: (s["date"], s.get("time") or ""))
    week1 = [s for s in sessions if s["week"] == min((x["week"] for x in sessions), default=1)]
    return ActionOutcome(
        summary=f"Created “{p.name}”: {p.weeks} weeks, {len(sessions)} sessions" + (f", deload week {', '.join(map(str, sorted(deloads)))}" if deloads else ""),
        result={"program_id": pid, "first_week": [_session_out(s, data) for s in week1], "sessions": len(sessions),
                "volume_warnings": sci.volume_warnings(data, sessions)},
    )


class SaveRoutine(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    exercises: list[PrescriptionIn] = Field(min_length=1, max_length=30)
    notes: str = Field(default="", max_length=1000)
    routine_id: str | None = Field(default=None, description="Replace this routine instead of adding a new one.")
    fill_loads: bool = Field(default=False, description="Routines usually leave loads to history; set true to bake them in.")
    unit: Unitish = None


def save_routine(ctx: ItemContext, data: dict, p: SaveRoutine) -> ActionOutcome:
    unit = _unit(data, p.unit)
    ids = Ids(ctx, data, "save_routine", p.model_dump())
    rxs = [_rx(data, e, ids, unit, fill=p.fill_loads, today=ctx.today) for e in p.exercises]
    routines = data.setdefault("routines", [])
    if p.routine_id:
        r = next((r for r in routines if r["id"] == p.routine_id), None)
        if r is None:
            raise ActionError(f"No routine with id {p.routine_id!r}.")
        r.update(name=p.name, notes=p.notes, exercises=rxs)
        rid = r["id"]
    else:
        if len(routines) >= 100:
            raise ActionError("There are 100 routines already — delete one first.")
        rid = ids("r")
        routines.append({"id": rid, "name": p.name, "notes": p.notes, "exercises": rxs})
    return ActionOutcome(summary=f"Saved the routine “{p.name}” ({len(rxs)} exercises)", result={"routine_id": rid})


class ScheduleSessions(BaseModel):
    routine_id: str = Field(description="The routine (template) to schedule.")
    dates: list[str] | None = Field(default=None, max_length=60, description="Exact days (YYYY-MM-DD).")
    weekdays: list[int] | None = Field(default=None, description="Or: weekdays (0 = Monday) …")
    weeks: int = Field(default=1, ge=1, le=16, description="… for this many weeks from start_date.")
    start_date: str | None = Field(default=None, pattern=DAY)
    time: str | None = Field(default=None, pattern=HHMM)
    fill_loads: bool = True


def schedule_sessions(ctx: ItemContext, data: dict, p: ScheduleSessions) -> ActionOutcome:
    r = next((r for r in data.get("routines", []) if r["id"] == p.routine_id), None)
    if r is None:
        raise ActionError(f"No routine with id {p.routine_id!r}.")
    days: list[str] = []
    if p.dates:
        days = sorted({_day(d, ctx) for d in p.dates})
    elif p.weekdays:
        start = date.fromisoformat(p.start_date) if p.start_date else ctx.today
        for k in range(p.weeks * 7):
            d = start + timedelta(days=k)
            if d.weekday() in set(p.weekdays):
                days.append(d.isoformat())
    if not days:
        raise ActionError("Give dates, or weekdays (+ weeks).")
    _make_room(data, len(days), ctx.today.isoformat())
    ids = Ids(ctx, data, "schedule", p.model_dump())
    exs = sci.all_exercises(data)
    made = []
    for d in days:
        rxs = []
        for rx in r["exercises"]:
            nr = dict(rx, id=ids("x"))
            ex = exs.get(rx["exercise_id"])
            if p.fill_loads and nr.get("load_kg") is None and not nr.get("load_pct") and ex and ex["log"] == "weight_reps":
                nr["load_kg"] = sci.prefill(data, ex, rx, today=ctx.today)
            rxs.append(nr)
        made.append({"id": ids("s"), "date": d, "time": p.time, "name": r["name"], "notes": r.get("notes", ""), "exercises": rxs,
                     "program_id": None, "week": None, "deload": False, "status": "planned", "workout_id": None})
    data["planned"].extend(made)
    data["planned"].sort(key=lambda s: (s["date"], s.get("time") or ""))
    return ActionOutcome(summary=f"Scheduled “{r['name']}” on {len(made)} day{'s' if len(made) != 1 else ''}", result={"session_ids": [s["id"] for s in made], "dates": days})


class RxChange(BaseModel):
    exercise: str = Field(description="Which exercise in the session (name or id).")
    sets: int | None = Field(default=None, ge=1, le=20)
    reps: int | None = Field(default=None, ge=1, le=100)
    reps_min: int | None = Field(default=None, ge=1, le=100)
    reps_max: int | None = Field(default=None, ge=1, le=100)
    load: float | None = Field(default=None, ge=0, le=3000)
    rest_s: int | None = Field(default=None, ge=0, le=900)
    notes: str | None = Field(default=None, max_length=300)


class EditSession(BaseModel):
    session_id: str
    date: str | None = Field(default=None, pattern=DAY, description="Move it to another day.")
    time: str | None = Field(default=None, pattern=HHMM)
    name: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=1000)
    status: Literal["planned", "skipped"] | None = None
    exercises: list[PrescriptionIn] | None = Field(default=None, max_length=30, description="Replace every exercise.")
    add: list[PrescriptionIn] | None = Field(default=None, max_length=30, description="Append exercises.")
    remove: list[str] | None = Field(default=None, description="Exercises to take out (names or ids).")
    changes: list[RxChange] | None = Field(default=None, description="Change sets / reps / load of exercises already in it.")
    fill_loads: bool = True
    unit: Unitish = None


def edit_session(ctx: ItemContext, data: dict, p: EditSession) -> ActionOutcome:
    s = _session(data, p.session_id)
    if s.get("status") == "done":
        raise ActionError("That session is already done — edit the logged workout instead.")
    unit = _unit(data, p.unit)
    ids = Ids(ctx, data, "edit_session", p.model_dump())
    what: list[str] = []
    if p.date:
        s["date"] = p.date
        what.append(f"moved to {p.date}")
    for key in ("time", "name", "notes", "status"):
        v = getattr(p, key)
        if v is not None:
            s[key] = v
            what.append(key)
    if p.exercises is not None:
        s["exercises"] = [_rx(data, e, ids, unit, fill=p.fill_loads, today=ctx.today) for e in p.exercises]
        what.append(f"{len(s['exercises'])} exercises")
    if p.remove:
        gone = {_ex(data, r)["id"] for r in p.remove}
        before = len(s["exercises"])
        s["exercises"] = [rx for rx in s["exercises"] if rx["exercise_id"] not in gone]
        what.append(f"removed {before - len(s['exercises'])}")
    if p.add:
        if len(s["exercises"]) + len(p.add) > 30:
            raise ActionError("A session holds at most 30 exercises.")
        s["exercises"].extend(_rx(data, e, ids, unit, fill=p.fill_loads, today=ctx.today) for e in p.add)
        what.append(f"added {len(p.add)}")
    for c in p.changes or []:
        eid = _ex(data, c.exercise)["id"]
        rx = next((r for r in s["exercises"] if r["exercise_id"] == eid), None)
        if rx is None:
            raise ActionError(f"{c.exercise!r} isn't in that session.")
        if c.sets is not None:
            rx["sets"] = c.sets
        if c.reps is not None:
            rx["reps_min"] = rx["reps_max"] = c.reps
        if c.reps_min is not None:
            rx["reps_min"] = c.reps_min
        if c.reps_max is not None:
            rx["reps_max"] = c.reps_max
        if rx["reps_max"] < rx["reps_min"]:
            rx["reps_min"], rx["reps_max"] = rx["reps_max"], rx["reps_min"]
        if c.load is not None:
            ex = _ex(data, rx["exercise_id"])
            kg = _load(c.load, unit)
            rx["load_kg"] = sci.round_load(kg, ex, _settings(data)) if ex["log"] == "weight_reps" else kg
            rx["load_pct"] = None
        if c.rest_s is not None:
            rx["rest_s"] = c.rest_s
        if c.notes is not None:
            rx["notes"] = c.notes
        what.append(f"changed {c.exercise}")
    if not what:
        raise ActionError("Nothing to change.")
    data["planned"].sort(key=lambda x: (x["date"], x.get("time") or ""))
    return ActionOutcome(summary=f"Updated “{s['name']}” ({s['date']}): " + ", ".join(what[:6]), result=_session_out(s, data))


class DeleteSessions(BaseModel):
    session_ids: list[str] | None = Field(default=None, max_length=200)
    from_date: str | None = Field(default=None, pattern=DAY, description="With to_date: every not-done session in the range.")
    to_date: str | None = Field(default=None, pattern=DAY)
    program_id: str | None = Field(default=None, description="Limit to one program's sessions.")


def delete_sessions(ctx: ItemContext, data: dict, p: DeleteSessions) -> ActionOutcome:
    ids = set(p.session_ids or [])
    if not ids and not (p.from_date or p.program_id):
        raise ActionError("Say which sessions: session_ids, or a date range / program.")

    def hit(s: dict) -> bool:
        if ids:
            return s["id"] in ids
        if s.get("status") == "done":
            return False
        if p.program_id and s.get("program_id") != p.program_id:
            return False
        if p.from_date and s["date"] < p.from_date:
            return False
        if p.to_date and s["date"] > p.to_date:
            return False
        return True

    before = len(data.get("planned", []))
    data["planned"] = [s for s in data.get("planned", []) if not hit(s)]
    n = before - len(data["planned"])
    if not n:
        raise ActionError("No sessions matched.")
    return ActionOutcome(summary=f"Removed {n} planned session{'s' if n != 1 else ''}", result={"removed": n})


class DeleteProgram(BaseModel):
    program_id: str
    delete_future_sessions: bool = Field(default=True, description="Also remove its not-yet-done sessions.")


def delete_program(ctx: ItemContext, data: dict, p: DeleteProgram) -> ActionOutcome:
    pr = next((x for x in data.get("programs", []) if x["id"] == p.program_id), None)
    if pr is None:
        raise ActionError(f"No program with id {p.program_id!r}.")
    data["programs"] = [x for x in data["programs"] if x["id"] != p.program_id]
    n = 0
    if p.delete_future_sessions:
        before = len(data.get("planned", []))
        data["planned"] = [s for s in data.get("planned", []) if not (s.get("program_id") == p.program_id and s.get("status") == "planned")]
        n = before - len(data["planned"])
    for s in data.get("planned", []):
        if s.get("program_id") == p.program_id:
            s["program_id"] = None
    return ActionOutcome(summary=f"Deleted the program “{pr['name']}”" + (f" and {n} upcoming sessions" if n else ""), result={"removed_sessions": n})


class DeleteRoutine(BaseModel):
    routine_id: str


def delete_routine(ctx: ItemContext, data: dict, p: DeleteRoutine) -> ActionOutcome:
    r = next((x for x in data.get("routines", []) if x["id"] == p.routine_id), None)
    if r is None:
        raise ActionError(f"No routine with id {p.routine_id!r}.")
    data["routines"] = [x for x in data["routines"] if x["id"] != p.routine_id]
    return ActionOutcome(summary=f"Deleted the routine “{r['name']}”")


# -------------------------------------------------------------------- logging


class SetIn(BaseModel):
    load: float | None = Field(default=None, ge=0, le=3000, description="In `unit`. Bodyweight lifts: added load; assisted: assistance.")
    reps: int | None = Field(default=None, ge=0, le=1000)
    seconds: int | None = Field(default=None, ge=0, le=86_400)
    meters: float | None = Field(default=None, ge=0, le=1_000_000)
    type: SetType = "working"


class LoggedExerciseIn(BaseModel):
    exercise: str = Field(description="Exercise id or name ('bench', 'Squat (Barbell)').")
    sets: list[SetIn] | None = Field(default=None, max_length=60, description="Each set as done. Or use the shorthand below.")
    set_count: int | None = Field(default=None, ge=1, le=30, description="Shorthand: '3×8 at 80' → set_count 3, reps 8, load 80.")
    reps: int | None = Field(default=None, ge=0, le=1000)
    load: float | None = Field(default=None, ge=0, le=3000)
    seconds: int | None = Field(default=None, ge=0, le=86_400)
    meters: float | None = Field(default=None, ge=0, le=1_000_000)
    notes: str = Field(default="", max_length=500)


def _sets_from(e: LoggedExerciseIn, unit: str, ids: Ids, at: str) -> list[dict]:
    rows = e.sets or ([SetIn(load=e.load, reps=e.reps, seconds=e.seconds, meters=e.meters)] * (e.set_count or 1))
    out = []
    for s in rows:
        if s.reps is None and s.seconds is None and s.meters is None:
            raise ActionError(f"A set of {e.exercise} needs reps, seconds or meters.")
        out.append({
            "id": ids("t"), "type": s.type, "kg": _load(s.load, unit), "reps": s.reps, "seconds": s.seconds, "meters": s.meters,
            "done": True, "at": at,
        })
    return out


class LogWorkout(BaseModel):
    date: str | None = Field(default=None, pattern=DAY, description="Default today.")
    name: str | None = Field(default=None, max_length=80)
    exercises: list[LoggedExerciseIn] = Field(min_length=1, max_length=40)
    duration_min: int | None = Field(default=None, ge=1, le=600)
    notes: str = Field(default="", max_length=2000)
    session_id: str | None = Field(default=None, description="The planned session this was (default: the one planned that day, if exactly one).")
    unit: Unitish = None


def _pr_text(prs: list[dict], data: dict) -> str:
    """One PR per exercise (the headline record), so the count is sane."""
    bits = []
    labels = {"e1rm": "e1RM", "heaviest": "heaviest", "volume": "volume", "1rm": "1RM", "3rm": "3RM", "5rm": "5RM", "10rm": "10RM", "max_reps": "reps", "longest": "time", "farthest": "distance", "least_assist": "least assistance"}
    for pr in [p for p in prs if p.get("headline", True)][:6]:
        v = pr["value"]
        val = f"{int(v)} reps" if pr["kind"] == "max_reps" else (f"{int(v)} s" if pr["kind"] == "longest" else (f"{v:g} m" if pr["kind"] == "farthest" else _fmt(v, data)))
        bits.append(f"{pr['exercise']} {labels.get(pr['kind'], pr['kind'])} {val}")
    return "; ".join(bits)


def _pr_count(prs: list[dict]) -> int:
    """PRs counted by exercise (each exercise's records headline once)."""
    return len({p["exercise_id"] for p in prs})


def _pr_label(prs: list[dict]) -> str:
    n = _pr_count(prs)
    return f"{n} PR{'s' if n != 1 else ''}"


def _summary_of(w: dict, data: dict) -> dict:
    exs = sci.all_exercises(data)
    sets = sum(1 for we in w["exercises"] for s in we["sets"] if sci.is_hard(s))
    vol = sum((s.get("kg") or 0) * (s.get("reps") or 0) for we in w["exercises"] if exs.get(we["exercise_id"], {}).get("log") == "weight_reps" for s in we["sets"] if sci.is_hard(s))
    return {"workout_id": w["id"], "date": w["date"], "name": w["name"], "sets": sets, "volume": _fmt(vol, data), "duration_min": round((w.get("duration_s") or 0) / 60) or None}


def _move_to(data: dict, s: dict, day: str) -> None:
    """A planned session done on another day moves to the day it was done
    (the calendar shows what happened; its old day frees up)."""
    if s.get("date") != day:
        s["date"] = day
        data["planned"].sort(key=lambda x: (x["date"], x.get("time") or ""))


def _link_session(data: dict, w: dict, session_id: str | None) -> None:
    cands = [s for s in data.get("planned", []) if s.get("status") == "planned"]
    s = None
    if session_id:
        s = next((x for x in cands if x["id"] == session_id), None)
        if s is None:
            raise ActionError(f"No not-yet-done planned session with id {session_id!r}.")
    else:
        same = [x for x in cands if x["date"] == w["date"]]
        s = same[0] if len(same) == 1 else None
    if s is not None:
        s["status"] = "done"
        s["workout_id"] = w["id"]
        _move_to(data, s, w["date"])
        w["session_id"] = s["id"]
        w["program_id"] = s.get("program_id")
        w["deload"] = bool(s.get("deload"))
        if not w.get("name") or w["name"] == "Workout":
            w["name"] = s["name"]


def log_workout(ctx: ItemContext, data: dict, p: LogWorkout) -> ActionOutcome:
    unit = _unit(data, p.unit)
    day = _day(p.date, ctx)
    ids = Ids(ctx, data, "log_workout", p.model_dump())
    at = ctx.now.isoformat() if day == ctx.today.isoformat() else datetime.combine(date.fromisoformat(day), time(12, 0), tzinfo=ctx.tz).isoformat()
    wexs = []
    for e in p.exercises:
        ex = _ex(data, e.exercise)
        wexs.append({"id": ids("e"), "exercise_id": ex["id"], "sets": _sets_from(e, unit, ids, at), "notes": e.notes, "superset": None, "rest_s": None, "rx": None})
    w = {
        "id": ids("w"), "name": p.name or "Workout", "date": day, "started_at": at, "ended_at": at,
        "duration_s": p.duration_min * 60 if p.duration_min else None, "exercises": wexs, "notes": p.notes,
        "session_id": None, "program_id": None, "bodyweight_kg": _settings(data).get("bodyweight_kg"),
        "rest_until": None, "rest_total_s": None,
    }
    if len(data.setdefault("workouts", [])) >= MAX_WORKOUTS:
        raise ActionError(FULL_MSG)
    _link_session(data, w, p.session_id)
    prs = sci.new_records(data, w)
    data["workouts"].append(w)
    data["workouts"].sort(key=lambda x: (x["date"], x.get("started_at") or ""))
    s = _summary_of(w, data)
    text = f"Logged {w['name']} on {day} — saved to the history: {s['sets']} sets" + (f" · {_pr_label(prs)}: {_pr_text(prs, data)}" if prs else "")
    return ActionOutcome(summary=text, result={**s, "saved": True, "note": "Saved once — the file you read next already includes it (not a duplicate).",
                                                "pr_count": _pr_count(prs), "prs": prs})


class LogSets(BaseModel):
    exercise: str
    sets: list[SetIn] | None = Field(default=None, max_length=30)
    set_count: int | None = Field(default=None, ge=1, le=30)
    reps: int | None = Field(default=None, ge=0, le=1000)
    load: float | None = Field(default=None, ge=0, le=3000)
    seconds: int | None = Field(default=None, ge=0, le=86_400)
    meters: float | None = Field(default=None, ge=0, le=1_000_000)
    workout_id: str | None = Field(default=None, description="Default: the live session if one is running, else today's latest workout, else a new one for today.")
    unit: Unitish = None


def log_sets(ctx: ItemContext, data: dict, p: LogSets) -> ActionOutcome:
    unit = _unit(data, p.unit)
    ex = _ex(data, p.exercise)
    ids = Ids(ctx, data, "log_sets", p.model_dump())
    e = LoggedExerciseIn(**p.model_dump(exclude={"workout_id", "unit"}))
    sets = _sets_from(e, unit, ids, ctx.now.isoformat())
    target = None
    where = ""
    if p.workout_id:
        if data.get("active") and data["active"]["id"] == p.workout_id:
            target, where = data["active"], "the live session"
        else:
            target = next((w for w in data.get("workouts", []) if w["id"] == p.workout_id), None)
            if target is None:
                raise ActionError(f"No workout with id {p.workout_id!r}.")
            where = f"{target['name']} ({target['date']})"
    elif data.get("active"):
        target, where = data["active"], "the live session"
    else:
        today = ctx.today.isoformat()
        target = next((w for w in reversed(data.get("workouts", [])) if w["date"] == today), None)
        if target is None:
            return log_workout(ctx, data, LogWorkout(exercises=[e], unit=unit))
        where = f"today's {target['name']}"
    we = next((x for x in target["exercises"] if x["exercise_id"] == ex["id"]), None)
    if we is None:
        if len(target["exercises"]) >= 40:
            raise ActionError("That workout already has 40 exercises.")
        we = {"id": ids("e"), "exercise_id": ex["id"], "sets": [], "notes": "", "superset": None, "rest_s": None, "rx": None}
        target["exercises"].append(we)
    if target is data.get("active"):
        # Fill the live session's unticked sets first.
        for s in sets:
            slot = next((x for x in we["sets"] if not x.get("done", True) and (x.get("type") == "warmup") == (s["type"] == "warmup")), None)
            if slot is not None:
                slot.update({k: v for k, v in s.items() if k != "id"})
            else:
                we["sets"].append(s)
    else:
        we["sets"].extend(sets)
    if len(we["sets"]) > 60:
        raise ActionError("That's more than 60 sets of one exercise.")
    return ActionOutcome(summary=f"Logged {len(sets)} set{'s' if len(sets) != 1 else ''} of {ex['name']} in {where}", result={"exercise": ex["name"], "sets": len(sets)})


class DeleteWorkout(BaseModel):
    workout_id: str


def delete_workout(ctx: ItemContext, data: dict, p: DeleteWorkout) -> ActionOutcome:
    w = next((x for x in data.get("workouts", []) if x["id"] == p.workout_id), None)
    if w is None:
        raise ActionError(f"No workout with id {p.workout_id!r}.")
    data["workouts"] = [x for x in data["workouts"] if x["id"] != p.workout_id]
    for s in data.get("planned", []):
        if s.get("workout_id") == p.workout_id:
            s["workout_id"] = None
            s["status"] = "planned"
    return ActionOutcome(summary=f"Deleted the workout {w['name']} ({w['date']})")


# --------------------------------------------------------------- live session


def drop_load(kg: float | None, ex: dict, st: dict) -> float | None:
    """A drop set's load: ~25% lighter — for an assisted lift, more
    assistance (the easier direction)."""
    if ex["log"] == "assisted":
        return sci.round_load(max((kg or 0) * 1.3, (kg or 0) + 10), ex, st, "nearest")
    return sci.round_load(kg * 0.75, ex, st, "down") if kg else None


def build_active(data: dict, ctx: ItemContext, ids: Ids, *, name: str, rxs: list[dict], session: dict | None) -> dict:
    """A live session from prescriptions: each set prefilled with the load
    to use, warm-ups ahead of the first heavy compound for each pattern."""
    st = _settings(data)
    exs = sci.all_exercises(data)
    out = []
    warmed: set[str] = set()
    deload = bool(session and session.get("deload"))
    for rx in rxs:
        ex = exs.get(rx["exercise_id"])
        if ex is None:
            continue
        kg = sci.prefill(data, ex, rx, today=ctx.today, deload=deload)
        sets = []
        want_warm = rx.get("warmup")
        if want_warm is None:
            want_warm = bool(st.get("warmups", True)) and ex["compound"] and ex["log"] == "weight_reps" and ex["pattern"] not in warmed
        if want_warm and kg:
            for wu in sci.warmups(kg, ex, st):
                sets.append({"id": ids("t"), "type": "warmup", "kg": wu["kg"], "reps": wu["reps"], "done": False})
        if ex["compound"]:
            warmed.add(ex["pattern"])
        prev_s = sci.last_session(data, ex)
        last = [s for s in prev_s[1]["sets"] if s.get("type", "working") == "working" and s.get("done", True)] if prev_s else []
        for i in range(rx.get("sets", 3)):
            prev = last[i] if i < len(last) else (last[-1] if last else None)
            # Same load as last time → start from last time's reps (beat them);
            # a new load → the bottom of the range.
            reps = prev.get("reps") if prev and kg is not None and abs((prev.get("kg") or 0) - kg) < 0.01 else rx.get("reps_min")
            secs = rx.get("seconds")
            if secs is None and sci.is_cardio(ex) and ex["log"] == "duration":
                secs = (prev or {}).get("seconds") or sci.CARDIO_SECONDS
            sets.append({
                "id": ids("t"), "type": "working", "kg": kg, "reps": reps if ex["log"] not in ("duration", "distance") else None,
                "seconds": secs, "meters": rx.get("meters"), "done": False,
            })
        for _ in range(rx.get("drop_sets", 0)):
            sets.append({"id": ids("t"), "type": "drop", "kg": drop_load(kg, ex, st), "reps": rx.get("reps_max"), "done": False})
        out.append({"id": ids("e"), "exercise_id": ex["id"], "sets": sets, "notes": "", "superset": rx.get("superset"), "rest_s": rx.get("rest_s"), "rx": dict(rx)})
    return {
        "id": ids("w"), "name": name, "date": ctx.today.isoformat(), "started_at": ctx.now.isoformat(), "ended_at": None,
        "duration_s": None, "exercises": out, "notes": "", "session_id": session["id"] if session else None,
        "program_id": session.get("program_id") if session else None, "bodyweight_kg": st.get("bodyweight_kg"),
        "deload": deload, "rest_until": None, "rest_total_s": None,
    }


class StartSession(BaseModel):
    session_id: str | None = Field(default=None, description="A planned session to start (default: today's, if there is one).")
    routine_id: str | None = Field(default=None, description="Or start from a routine.")
    name: str | None = Field(default=None, max_length=80)
    empty: bool = Field(default=False, description="Start an empty workout even if one is planned today.")


def start_session(ctx: ItemContext, data: dict, p: StartSession) -> ActionOutcome:
    if data.get("active"):
        raise ActionError(f"A workout is already running ({data['active']['name']}, started {data['active'].get('started_at', '')[11:16]}). Finish or discard it first.")
    ids = Ids(ctx, data, "start", p.model_dump())
    session = None
    rxs: list[dict] = []
    name = p.name or "Workout"
    if p.session_id:
        session = _session(data, p.session_id)
        if session.get("status") == "done":
            raise ActionError(f"{session['name']} ({session['date']}) is already done. Start it from a routine or as an empty workout to repeat it.")
    elif p.routine_id:
        r = next((x for x in data.get("routines", []) if x["id"] == p.routine_id), None)
        if r is None:
            raise ActionError(f"No routine with id {p.routine_id!r}.")
        rxs, name = r["exercises"], p.name or r["name"]
    elif not p.empty:
        today = ctx.today.isoformat()
        session = next((s for s in data.get("planned", []) if s["date"] == today and s.get("status") == "planned"), None)
    if session is not None:
        rxs, name = session["exercises"], p.name or session["name"]
    data["active"] = build_active(data, ctx, ids, name=name, rxs=rxs, session=session)
    n = len(data["active"]["exercises"])
    return ActionOutcome(summary=f"Started {name}" + (f" — {n} exercises" if n else ""), result={"workout_id": data["active"]["id"], "exercises": n})


class FinishSession(BaseModel):
    notes: str | None = Field(default=None, max_length=2000)


def finish_active(data: dict, now: datetime, notes: str | None = None) -> tuple[dict, list[dict]]:
    w = data.get("active")
    if not w:
        raise ActionError("No workout is running.")
    if len(data.setdefault("workouts", [])) >= MAX_WORKOUTS:
        raise ActionError(FULL_MSG)
    for we in w["exercises"]:
        we["sets"] = [s for s in we["sets"] if s.get("done", True)]
    w["exercises"] = [we for we in w["exercises"] if we["sets"]]
    if not w["exercises"]:
        raise ActionError("No sets are ticked yet — tick at least one, or discard the workout.")
    w["ended_at"] = now.isoformat()
    try:
        w["duration_s"] = max(0, min(86_400, int((now - datetime.fromisoformat(w["started_at"])).total_seconds())))
    except (TypeError, ValueError):
        w["duration_s"] = None
    w["rest_until"] = None
    w["rest_total_s"] = None
    if notes is not None:
        w["notes"] = notes
    if w.get("session_id"):
        s = next((x for x in data.get("planned", []) if x["id"] == w["session_id"]), None)
        if s is not None:
            s["status"] = "done"
            s["workout_id"] = w["id"]
            _move_to(data, s, w["date"])
            w["deload"] = bool(w.get("deload") or s.get("deload"))
    prs = sci.new_records(data, w)
    data["active"] = None
    data["workouts"].append(w)
    data["workouts"].sort(key=lambda x: (x["date"], x.get("started_at") or ""))
    return w, prs


def finish_session(ctx: ItemContext, data: dict, p: FinishSession) -> ActionOutcome:
    w, prs = finish_active(data, ctx.now, p.notes)
    s = _summary_of(w, data)
    return ActionOutcome(
        summary=f"Finished {w['name']} and saved it to the history: {s['sets']} sets, {s['volume']}" + (f", {s['duration_min']} min" if s["duration_min"] else "") + (f" · {_pr_label(prs)}: {_pr_text(prs, data)}" if prs else ""),
        result={**s, "saved": True, "pr_count": _pr_count(prs), "prs": prs},
    )


class NoArgs(BaseModel):
    pass


def discard_session(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    if not data.get("active"):
        raise ActionError("No workout is running.")
    name = data["active"]["name"]
    data["active"] = None
    return ActionOutcome(summary=f"Discarded the live {name}")


class SwapExercise(BaseModel):
    from_exercise: str = Field(description="The exercise to replace (name or id).")
    to_exercise: str = Field(description="The replacement (name or id).")
    scope: Literal["active", "session", "future", "routine"] = Field(
        default="future", description="active: the live workout; session: one planned session; future: every not-done planned session from today; routine: one routine."
    )
    session_id: str | None = None
    routine_id: str | None = None
    reload: bool = Field(default=True, description="Recompute the load for the new exercise from history (or a calibration estimate).")


def swap_exercise(ctx: ItemContext, data: dict, p: SwapExercise) -> ActionOutcome:
    a, b = _ex(data, p.from_exercise), _ex(data, p.to_exercise)
    if a["id"] == b["id"]:
        raise ActionError("That's the same exercise.")
    st = _settings(data)

    def swap_rx(rx: dict) -> None:
        rx["exercise_id"] = b["id"]
        if p.reload:
            rx["load_kg"] = None
            if b["log"] == "weight_reps" and not rx.get("load_pct"):
                rx["load_kg"] = sci.next_load(data, b, rx.get("reps_min", 8), rx.get("reps_max", 8), today=ctx.today).get("load_kg")

    n = 0
    if p.scope == "active":
        w = data.get("active")
        if not w:
            raise ActionError("No workout is running.")
        for we in w["exercises"]:
            if we["exercise_id"] == a["id"]:
                we["exercise_id"] = b["id"]
                if we.get("rx"):
                    swap_rx(we["rx"])
                kg = sci.prefill(data, b, we.get("rx"), today=ctx.today, deload=bool(w.get("deload"))) if p.reload else None
                had_warmups = any(s.get("type") == "warmup" and not s.get("done", True) for s in we["sets"])
                for s in we["sets"]:
                    if not s.get("done", True) and s.get("type") != "warmup" and p.reload:
                        s["kg"] = drop_load(kg, b, st) if s.get("type") == "drop" else kg
                # The old lift's unticked warm-ups don't fit the new one: a
                # fresh ramp to the new load (heavy compounds only).
                we["sets"] = [s for s in we["sets"] if s.get("done", True) or s.get("type") != "warmup"]
                if had_warmups and kg and b["compound"] and b["log"] == "weight_reps":
                    wids = Ids(ctx, data, "swap_warmups", we["id"], b["id"])
                    ramp = [{"id": wids("t"), "type": "warmup", "kg": x["kg"], "reps": x["reps"], "done": False} for x in sci.warmups(kg, b, st)]
                    first = next((i for i, s in enumerate(we["sets"]) if not s.get("done", True)), len(we["sets"]))
                    we["sets"][first:first] = ramp
                n += 1
    elif p.scope == "routine":
        r = next((x for x in data.get("routines", []) if x["id"] == p.routine_id), None)
        if r is None:
            raise ActionError("Give the routine_id.")
        for rx in r["exercises"]:
            if rx["exercise_id"] == a["id"]:
                swap_rx(rx)
                n += 1
    else:
        if p.scope == "session":
            if not p.session_id:
                raise ActionError("Give the session_id.")
            targets = [_session(data, p.session_id)]
        else:
            today = ctx.today.isoformat()
            targets = [s for s in data.get("planned", []) if s.get("status") == "planned" and s["date"] >= today]
        for s in targets:
            for rx in s["exercises"]:
                if rx["exercise_id"] == a["id"]:
                    swap_rx(rx)
                    n += 1
    if not n:
        raise ActionError(f"{a['name']} isn't in the {p.scope} {'workout' if p.scope == 'active' else 'plan'}.")
    _ = st
    return ActionOutcome(summary=f"Swapped {a['name']} → {b['name']} ({n} place{'s' if n != 1 else ''})", result={"swapped": n, "to": b["id"]})


# ------------------------------------------------------------------ exercises


class AddCustomExercise(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    primary: list[Muscle] = Field(min_length=1, max_length=6)
    secondary: list[Muscle] = Field(default_factory=list, max_length=8)
    equipment: Equip = "bodyweight"
    pattern: Pattern = "core"
    log: LogType = "weight_reps"
    compound: bool = False
    notes: str = Field(default="", max_length=500)


def add_custom_exercise(ctx: ItemContext, data: dict, p: AddCustomExercise) -> ActionOutcome:
    name_norm = p.name.strip().lower()
    for e in sci.all_exercises(data).values():
        if e["name"].lower() == name_norm:
            raise ActionError(f"“{e['name']}” is already in the library (id {e['id']}).")
    base = "c_" + "".join(ch if ch.isalnum() else "_" for ch in name_norm).strip("_")[:40]
    eid, n = base, 2
    taken = {e["id"] for e in sci.all_exercises(data).values()}
    while eid in taken:
        eid, n = f"{base}_{n}", n + 1
    if len(data.setdefault("exercises", [])) >= 500:
        raise ActionError("There are 500 custom exercises already.")
    data["exercises"].append({
        "id": eid, "name": p.name.strip(), "primary": p.primary, "secondary": p.secondary, "equipment": p.equipment,
        "pattern": p.pattern, "log": p.log, "compound": p.compound, "notes": p.notes, "archived": False,
    })
    return ActionOutcome(summary=f"Added the exercise “{p.name.strip()}”", result={"exercise_id": eid})


class DeleteCustomExercise(BaseModel):
    exercise: str


def delete_custom_exercise(ctx: ItemContext, data: dict, p: DeleteCustomExercise) -> ActionOutcome:
    ex = _ex(data, p.exercise)
    if not ex.get("custom"):
        raise ActionError(f"{ex['name']} is built in — only custom exercises can be deleted.")
    used = any(we["exercise_id"] == ex["id"] for w in data.get("workouts", []) for we in w["exercises"])
    used = used or any(rx["exercise_id"] == ex["id"] for s in [*data.get("planned", []), *data.get("routines", [])] for rx in s["exercises"])
    if used:
        for c in data["exercises"]:
            if c["id"] == ex["id"]:
                c["archived"] = True
        return ActionOutcome(summary=f"Archived “{ex['name']}” (it's in your history, so it's kept but hidden)")
    data["exercises"] = [c for c in data["exercises"] if c["id"] != ex["id"]]
    return ActionOutcome(summary=f"Deleted the exercise “{ex['name']}”")


class ListExercises(BaseModel):
    query: str | None = Field(default=None, description="Words in the name, e.g. 'row' or 'dumbbell press'.")
    muscle: Muscle | None = None
    equipment: Equip | None = None
    pattern: Pattern | None = None
    available_only: bool = Field(default=True, description="Only what their equipment allows.")
    limit: int = Field(default=40, ge=1, le=200)


def list_exercises(ctx: ItemContext, data: dict, p: ListExercises) -> ActionOutcome:
    st = _settings(data)
    q = sci._norm(p.query or "").split()
    avoid = {a.lower() for a in st.get("avoid_exercises", [])}
    out = []
    for e in sci.all_exercises(data).values():
        if e.get("archived"):
            continue
        if p.muscle and p.muscle not in e["primary"] and p.muscle not in e["secondary"]:
            continue
        if p.equipment and not any(p.equipment in alt for alt in e["needs"]):
            continue
        if p.pattern and e["pattern"] != p.pattern:
            continue
        if p.available_only and not sci.is_available(e, st):
            continue
        hay = sci._norm(" ".join([e["name"], *e["aliases"]]))
        if q and not all(w in hay for w in q):
            continue
        out.append({"id": e["id"], "name": e["name"], "primary": e["primary"], "secondary": e["secondary"], "pattern": e["pattern"], "log": e["log"],
                    **({"avoid": True} if e["id"] in avoid or e["name"].lower() in avoid else {})})
    out.sort(key=lambda e: (bool(e.get("avoid")), bool(p.muscle) and p.muscle not in e["primary"], e["name"]))
    return ActionOutcome(summary="", result={"count": len(out), "exercises": out[: p.limit], "patterns": PATTERNS if not out else None})


# ------------------------------------------------------------------- analysis


class GetProgress(BaseModel):
    exercise: str
    weeks: int = Field(default=12, ge=1, le=520)


def get_progress(ctx: ItemContext, data: dict, p: GetProgress) -> ActionOutcome:
    ex = _ex(data, p.exercise)
    st = _settings(data)
    since = (ctx.today - timedelta(weeks=p.weeks)).isoformat()
    rows = []
    for w, we in sci.history_for(data, ex["id"]):
        if w["date"] < since:
            continue
        s = sci.session_stats(we, ex, st)
        best = s["best_set"]
        rows.append({
            "date": w["date"],
            "sets": [{k: (_show(v, data) if k == "kg" else v) for k, v in x.items() if k in ("kg", "reps", "seconds", "meters") and v is not None} for x in we["sets"] if sci.is_hard(x)],
            "e1rm": _show(s["e1rm"], data),
            "best_set": f"{_fmt(best.get('kg'), data)} × {best.get('reps')}" if best else None,
            "volume": _show(s["volume_kg"], data),
        })
    if not rows:
        return ActionOutcome(summary="", result={"exercise": ex["name"], "sessions": [], "note": f"No {ex['name']} logged in the last {p.weeks} weeks."})
    e1 = [r["e1rm"] for r in rows if r["e1rm"]]
    trend = None
    if len(e1) >= 2:
        trend = round((e1[-1] - e1[0]) / e1[0] * 100, 1)
    stalled = len(e1) >= 5 and max(e1[-3:]) <= max(e1[:-3]) + 1e-6
    rec = sci.records(data, ex["id"]).get(ex["id"], {})
    return ActionOutcome(summary="", result={
        "exercise": ex["name"], "unit": st.get("units"), "sessions": rows[-30:], "e1rm_change_pct": trend,
        "stalled": stalled, "records": _records_out(rec, data),
    })


def _records_out(rec: dict, data: dict) -> dict:
    out = {}
    for k, v in rec.items():
        val = v["value"]
        if k in ("e1rm", "heaviest", "volume", "1rm", "3rm", "5rm", "10rm", "least_assist"):
            val = _fmt(val, data)
        elif k == "longest":
            val = f"{int(val)} s"
        elif k == "farthest":
            val = f"{val:g} m"
        out[k] = {"value": val, "date": v["date"], **({"reps": v["reps"]} if v.get("reps") else {})}
    return out


class GetPrs(BaseModel):
    exercise: str | None = Field(default=None, description="One exercise; omit for every exercise they've done.")


def get_prs(ctx: ItemContext, data: dict, p: GetPrs) -> ActionOutcome:
    eid = _ex(data, p.exercise)["id"] if p.exercise else None
    recs = sci.records(data, eid)
    exs = sci.all_exercises(data)
    rows = sorted(recs.items(), key=lambda kv: max(v["date"] for v in kv[1].values()), reverse=True)
    return ActionOutcome(summary="", result={"unit": _settings(data).get("units"), "records": {exs.get(k, {}).get("name", k): _records_out(v, data) for k, v in rows[:60]}})


class WeeklyVolume(BaseModel):
    week_of: str | None = Field(default=None, pattern=DAY, description="Any day in the week (default this week).")
    weeks: int = Field(default=1, ge=1, le=12, description="How many weeks back from week_of.")
    source: Literal["logged", "planned", "both"] = Field(default="logged", description="planned = what the plan prescribes (check a plan before saving it).")


def weekly_volume_by_muscle(ctx: ItemContext, data: dict, p: WeeklyVolume) -> ActionOutcome:
    st = _settings(data)
    anchor = date.fromisoformat(p.week_of) if p.week_of else ctx.today
    weeks = []
    for k in range(p.weeks):
        start = sci.week_start(anchor, st) - timedelta(days=7 * k)
        vol = sci.weekly_volume(data, start, source=p.source)
        weeks.append({
            "week_of": start.isoformat(),
            "muscles": {
                m: {"sets": round(v, 1), "mev": MUSCLES[m]["mev"], "mav": list(MUSCLES[m]["mav"]), "mrv": MUSCLES[m]["mrv"], "status": sci.landmark_status(m, v)}
                for m, v in vol.items()
            },
        })
    return ActionOutcome(summary="", result={"note": "Hard sets per week (warm-ups excluded; secondary muscles count ½). Landmarks: RP/Israetel population guidelines.", "weeks": weeks})


class SuggestItem(BaseModel):
    exercise: str
    reps: int = Field(ge=1, le=50)


class SuggestLoads(BaseModel):
    items: list[SuggestItem] = Field(min_length=1, max_length=40)


def suggest_loads(ctx: ItemContext, data: dict, p: SuggestLoads) -> ActionOutcome:
    st = _settings(data)
    out = []
    for it in p.items:
        ex = _ex(data, it.exercise)
        s = sci.suggest(data, ex, it.reps, today=ctx.today)
        row = {k: v for k, v in s.items() if k not in ("load_kg", "exact_kg", "e1rm_kg", "last", "progression")}
        if s.get("load_kg") is not None:
            row["load"] = _fmt(s["load_kg"], data)
            row["load_value"] = _show(s["load_kg"], data)
            if ex["log"] == "weight_reps" and sci.load_equipment(ex, st) == "barbell":
                pl = sci.plates_per_side(s["load_kg"], st)
                row["plates_per_side"] = [_show(x, data) for x in pl["per_side"]]
        if s.get("e1rm_kg"):
            row["e1rm"] = _fmt(s["e1rm_kg"], data)
        if s.get("last"):
            row["last"] = {"date": s["last"]["date"], "sets": [{k: (_show(v, data) if k == "kg" else v) for k, v in x.items()} for x in s["last"]["sets"]]}
        if s.get("progression"):
            pr = dict(s["progression"])
            if pr.get("load_kg") is not None:
                pr["load"] = _fmt(pr.pop("load_kg"), data)
            row["progression"] = pr
        out.append(row)
    return ActionOutcome(summary="", result={"unit": st.get("units"), "suggestions": out})


class PlateMath(BaseModel):
    load: float = Field(gt=0, le=3000, description="Total bar load in `unit`.")
    exercise: str | None = Field(default=None, description="For warm-ups and the bar type (default barbell).")
    unit: Unitish = None


def plate_math(ctx: ItemContext, data: dict, p: PlateMath) -> ActionOutcome:
    st = _settings(data)
    unit = _unit(data, p.unit)
    kg = _kg(p.load, unit) or 0
    ex = _ex(data, p.exercise) if p.exercise else sci.builtin()["back_squat"]
    eq = sci.load_equipment(ex, st)
    if ex["log"] != "weight_reps" or eq not in ("barbell", "rack", "ez_bar", "trap_bar", "smith"):
        raise ActionError(f"{ex['name']} isn't loaded on a bar — plate maths is for barbell, EZ-bar and trap-bar lifts.")
    bar = {"ez_bar": st.get("ez_bar_kg", 10), "trap_bar": st.get("trap_bar_kg", 25), "smith": 0.0}.get(eq, st.get("bar_kg", 20))
    pl = sci.plates_per_side(kg, st, float(bar))
    return ActionOutcome(summary="", result={
        "bar": _fmt(pl["bar_kg"], data), "per_side": [_show(x, data) for x in pl["per_side"]], "loaded": _fmt(pl["loaded_kg"], data),
        "short_by": _fmt(pl["remainder_kg"], data) if pl["remainder_kg"] > 0.01 else None,
        "warmups": [{"load": _fmt(w["kg"], data), "reps": w["reps"]} for w in sci.warmups(kg, ex, st)],
    })


def get_summary(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    st = _settings(data)
    today = ctx.today
    ws = data.get("workouts", [])
    this_week = sci.week_start(today, st)
    per_week = []
    for k in range(8):
        a = (this_week - timedelta(days=7 * k)).isoformat()
        b = (this_week - timedelta(days=7 * (k - 1))).isoformat()
        per_week.append(sum(1 for w in ws if a <= w["date"] < b))
    streak = 0
    for k, n in enumerate(per_week):
        if n == 0 and k == 0:
            continue
        if n == 0:
            break
        streak += 1
    deload_dates = [s["date"] for s in data.get("planned", []) if s.get("deload") and s.get("status") == "done"]
    last_deload = max(deload_dates) if deload_dates else None
    prog = next((pr for pr in data.get("programs", []) if pr.get("status") == "active"), None)
    week_n = None
    if prog:
        week_n = (today - sci.week_start(date.fromisoformat(prog["start_date"]), st)).days // 7 + 1
    # Stalls: main lifts whose e1RM hasn't beaten the earlier best in 3 sessions.
    exs = sci.all_exercises(data)
    stalls = []
    for eid in {we["exercise_id"] for w in ws[-40:] for we in w["exercises"]}:
        ex = exs.get(eid)
        if not ex or ex["log"] != "weight_reps":
            continue
        vals = [sci.session_stats(we, ex, st)["e1rm"] for _w, we in sci.history_for(data, eid)]
        vals = [v for v in vals if v]
        if len(vals) >= 5 and max(vals[-3:]) <= max(vals[:-3]) + 1e-6:
            stalls.append(ex["name"])
    nxt = next((s for s in data.get("planned", []) if s.get("status") == "planned" and s["date"] >= today.isoformat()), None)
    return ActionOutcome(summary="", result={
        "workouts_per_week_last_8": per_week,
        "target_per_week": st.get("days_per_week"),
        "week_streak": streak,
        "total_workouts": len(ws),
        "last_workout": _summary_of(ws[-1], data) if ws else None,
        "next_session": _session_out(nxt, data) if nxt else None,
        "active_program": {"id": prog["id"], "name": prog["name"], "week": week_n, "of": len(prog["weeks"])} if prog else None,
        "last_deload": last_deload,
        "stalled_lifts": sorted(stalls),
        "live_session": data["active"]["name"] if data.get("active") else None,
    })


class RefitLoads(BaseModel):
    from_date: str | None = Field(default=None, pattern=DAY, description="First day to re-fit (default today).")
    to_date: str | None = Field(default=None, pattern=DAY, description="Last day (default: every upcoming session).")
    program_id: str | None = Field(default=None, description="Only this program's sessions.")
    exercises: list[str] | None = Field(default=None, max_length=40, description="Only these exercises (names or ids).")
    only_increase: bool = Field(default=False, description="Never lower a planned load (raise the ones they've outgrown).")
    apply: bool = Field(default=True, description="False = preview the changes without saving them.")


def refit_upcoming_loads(ctx: ItemContext, data: dict, p: RefitLoads) -> ActionOutcome:
    """Bring the plan's loads in line with what they've actually been
    lifting: for each exercise and rep range, the first upcoming
    (non-deload) prescription gets the load double progression / the
    recent e1RM calls for, and the later ones keep their planned step
    from it (a program's linear steps and deload stay intact)."""
    st = _settings(data)
    lo = p.from_date or ctx.today.isoformat()
    only = {_ex(data, e)["id"] for e in p.exercises} if p.exercises else None
    exs = sci.all_exercises(data)
    groups: dict[tuple, list[tuple[dict, dict]]] = {}
    for s in data.get("planned", []):
        if s.get("status") != "planned" or s["date"] < lo or (p.to_date and s["date"] > p.to_date):
            continue
        if p.program_id and s.get("program_id") != p.program_id:
            continue
        for rx in s.get("exercises", []):
            ex = exs.get(rx["exercise_id"])
            if ex is None or ex["log"] != "weight_reps" or rx.get("load_pct") or (only and ex["id"] not in only):
                continue
            groups.setdefault((ex["id"], rx["reps_min"], rx["reps_max"]), []).append((s, rx))
    if not groups:
        raise ActionError("No upcoming planned sessions with loaded lifts to re-fit" + (" in that range." if p.to_date or p.from_date else "."))
    changes = []
    for (eid, rmin, rmax), rows in groups.items():
        ex = exs[eid]
        rows.sort(key=lambda t: t[0]["date"])
        anchor = next(((s, rx) for s, rx in rows if not s.get("deload")), rows[0])
        base = sci.next_load(data, ex, rmin, rmax, today=ctx.today)
        if base.get("load_kg") is None or base.get("basis") == "estimate":
            continue  # nothing logged to fit to
        old_anchor = anchor[1].get("load_kg")
        for s, rx in rows:
            old = rx.get("load_kg")
            if old is not None and old_anchor:
                new = sci.round_load(old * base["load_kg"] / old_anchor, ex, st)
            elif s.get("deload"):
                new = sci.round_load(base["load_kg"] * 0.9, ex, st, "down")
            else:
                new = base["load_kg"]
            if p.only_increase and old is not None and new is not None and new < old:
                new = old
            if new is None or (old is not None and abs(new - old) < 1e-6):
                continue
            changes.append({"session_id": s["id"], "date": s["date"], "session": s.get("name"), "exercise": ex["name"],
                            "from": _fmt(old, data) if old is not None else None, "to": _fmt(new, data), "basis": base["basis"]})
            if p.apply:
                rx["load_kg"] = new
    if not changes:
        return ActionOutcome(summary="The planned loads already match your recent training", result={"changes": [], "applied": p.apply})
    n_s = len({c["session_id"] for c in changes})
    verb = "Re-fitted" if p.apply else "Would re-fit"
    return ActionOutcome(
        summary=f"{verb} {len(changes)} load{'s' if len(changes) != 1 else ''} across {n_s} session{'s' if n_s != 1 else ''} from your recent training",
        result={"changes": changes[:80], "applied": p.apply},
    )


# ------------------------------------------------------------------- registry

ACTIONS = [
    ItemAction("set_profile", "Update their profile & settings: units, bodyweight, experience, goal, days/week, session length, equipment (and exact dumbbells / plates / bar), injuries, exercises to avoid, stated bests (baselines: 'bench 90×5' — loads calibrate from them until a lift is logged), rest times, reminders. Only pass what changes.", SetProfile, set_profile),
    ItemAction("plan_week", "Plan a whole week (or any set of days) in one call: sessions with dates, exercises, sets, rep ranges and loads (no RIR/RPE). Missing loads are filled from their history (or a conservative calibration estimate). Replaces that week's not-yet-done plan by default. Returns every session with the loads to use.", PlanWeek, plan_week),
    ItemAction("create_program", "Create a mesocycle (program): a weekly template materialised over N weeks with progression (double progression + isolation volume ramp, or linear load steps) and deload week(s) (half the sets, ~10% lighter). Use for 'plan my next 6 weeks' / 'make me a program'.", CreateProgram, create_program),
    ItemAction("save_routine", "Save (or replace) a reusable routine / template, like Strong's routines.", SaveRoutine, save_routine),
    ItemAction("schedule_sessions", "Put a routine on the calendar: exact dates, or weekdays for N weeks.", ScheduleSessions, schedule_sessions),
    ItemAction("edit_session", "Change one planned session: move it, rename, skip, replace / add / remove exercises, or change sets, reps or load of exercises in it.", EditSession, edit_session),
    ItemAction("delete_sessions", "Remove planned sessions by id, or every not-done one in a date range / program.", DeleteSessions, delete_sessions),
    ItemAction("delete_program", "Delete a program (and, by default, its upcoming sessions).", DeleteProgram, delete_program),
    ItemAction("delete_routine", "Delete a routine.", DeleteRoutine, delete_routine),
    ItemAction("log_workout", "Log a workout they did (from chat: 'I did 3×8 bench at 80 and 3×10 rows at 60'). Shorthand per exercise (set_count/reps/load) or each set. Links to that day's planned session. Reports PRs.", LogWorkout, log_workout),
    ItemAction("log_sets", "Add sets of one exercise to the live session (fills unticked sets), or to today's / a given workout.", LogSets, log_sets),
    ItemAction("delete_workout", "Delete a logged workout.", DeleteWorkout, delete_workout),
    ItemAction("start_session", "Start the live workout logger: today's planned session by default, or a given session / routine, or empty. Sets are prefilled with the loads to use and warm-ups.", StartSession, start_session),
    ItemAction("finish_session", "Finish the live workout: unticked sets are dropped, it's saved to history, the planned session is marked done. Reports PRs, volume, duration.", FinishSession, finish_session),
    ItemAction("discard_session", "Throw away the live workout without saving it.", NoArgs, discard_session),
    ItemAction("swap_exercise", "Replace an exercise with another (injury, missing kit, preference) in the live workout, one session, every future session, or a routine; loads are recomputed.", SwapExercise, swap_exercise),
    ItemAction("add_custom_exercise", "Add an exercise that isn't in the library.", AddCustomExercise, add_custom_exercise),
    ItemAction("delete_custom_exercise", "Delete a custom exercise (archived instead if it's in their history).", DeleteCustomExercise, delete_custom_exercise),
    ItemAction("list_exercises", "Search the exercise library (built-in + custom) by words, muscle, equipment or pattern; by default only what their equipment allows.", ListExercises, list_exercises, writes=False),
    ItemAction("get_progress", "One exercise's history: each session's sets, e1RM, best set, volume; the e1RM trend and whether it has stalled; its records.", GetProgress, get_progress, writes=False),
    ItemAction("get_prs", "Personal records: e1RM, 1/3/5/10RM, heaviest, best session volume, max reps, longest, farthest — for one exercise or all.", GetPrs, get_prs, writes=False),
    ItemAction("weekly_volume_by_muscle", "Hard sets per muscle per week vs MEV / MAV / MRV landmarks — logged, planned, or both. Check a plan with source='planned'.", WeeklyVolume, weekly_volume_by_muscle, writes=False),
    ItemAction("suggest_loads", "Loads for a target rep count, from their recent e1RM, rounded to their plates / dumbbells / machine steps (with plates per side), plus last time's sets and the double-progression call. Use before prescribing loads.", SuggestLoads, suggest_loads, writes=False),
    ItemAction("plate_math", "Plates per side for a bar load, and a warm-up ramp to it.", PlateMath, plate_math, writes=False),
    ItemAction("get_summary", "Consistency and status: workouts per week (8 weeks), streak, last workout, next session, active program & week, last deload, stalled lifts.", NoArgs, get_summary, writes=False),
    ItemAction("refit_upcoming_loads", "Re-fit the loads of upcoming planned sessions to their recent training (double progression from the last non-deload session, else the recent e1RM), keeping a program's week-to-week steps and deloads. Use when they've out-lifted the plan, after a break, or when a plan was written from old numbers. apply=false previews.", RefitLoads, refit_upcoming_loads),
]


def _expanding(fn):  # noqa: ANN001, ANN202
    """Actions read every field: files are stored compactly (defaults left
    out), so fill them in first — in place, as the framework expects."""

    def run(ctx: ItemContext, data: dict, p: Any) -> ActionOutcome:
        expand_in_place(data)
        return fn(ctx, data, p)

    run.__name__ = getattr(fn, "__name__", "run")
    run.__doc__ = fn.__doc__
    return run


for _a in ACTIONS:
    _a.run = _expanding(_a.run)

__all__ = ["ACTIONS", "build_active", "finish_active", "EQUIPMENT"]
