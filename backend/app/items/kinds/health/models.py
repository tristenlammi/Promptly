"""Body & Health — the file's shape.

One file holds a person's profile, every reading (weight, blood pressure,
sleep, glucose, custom metrics…), symptoms, an optional cycle log, their
medications with a dose log, appointments, lab results and vaccinations.

Canonical units are stored (kg, cm, mmol/L, °C, ml, hours); ``settings``
holds how the person likes to see them. Every field has a default so old
files keep loading, and every list is bounded so years of logging stay well
under the file limit.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

ID = Field(min_length=1, max_length=40)
DAY = r"^\d{4}-\d{2}-\d{2}$"
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
METRIC_ID = r"^[a-z0-9_]{1,40}$"

# Hard ceilings (the file's 8 MB limit usually arrives first — the shell then
# offers "Archive older data"). Nothing is ever trimmed silently at a cap: an
# action refuses with a pointer to archiving instead.
MAX_READINGS = 40_000
MAX_DOSES = 40_000
MAX_SYMPTOMS = 10_000
MAX_PERIOD_DAYS = 3_000
MAX_PLAN_STEPS = 120


# ------------------------------------------------------------------ profile


class CareProvider(BaseModel):
    id: str = ID
    name: str = Field(default="", max_length=120)
    role: str = Field(default="", max_length=80)  # "GP", "Cardiologist", "Dentist"
    clinic: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=60)
    email: str = Field(default="", max_length=160)
    address: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=1000)


class Profile(BaseModel):
    height_cm: float | None = Field(default=None, ge=40, le=260)
    birth_date: str | None = Field(default=None, pattern=DAY)
    sex: Literal["female", "male", "intersex", "unspecified"] = "unspecified"
    blood_type: Literal["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] = ""
    conditions: list[str] = Field(default_factory=list, max_length=60)
    allergies: list[str] = Field(default_factory=list, max_length=60)
    emergency_contact: str = Field(default="", max_length=300)
    emergency_notes: str = Field(default="", max_length=2000)
    care_team: list[CareProvider] = Field(default_factory=list, max_length=60)


class Settings(BaseModel):
    weight_unit: Literal["kg", "lb"] = "kg"
    length_unit: Literal["cm", "in"] = "cm"
    glucose_unit: Literal["mmol", "mgdl"] = "mmol"
    temp_unit: Literal["c", "f"] = "c"
    water_unit: Literal["ml", "oz"] = "ml"
    cycle_tracking: bool = False
    # Reminders
    med_reminders: bool = True
    refill_reminders: bool = True
    refill_days: int = Field(default=7, ge=1, le=60)  # warn when this many days' supply is left
    appointment_reminders: bool = True
    weigh_in_time: str | None = Field(default=None, pattern=HHMM)  # daily weigh-in reminder, off when None
    discreet_reminders: bool = False  # notifications without medicine names
    # Trend smoothing (EWMA, per day) — Hacker's Diet / Happy Scale use 0.1
    smoothing: float = Field(default=0.1, ge=0.02, le=0.6)
    # Metrics shown as quick-log tiles on Today, in order
    today_tiles: list[str] = Field(
        default_factory=lambda: ["weight", "bp", "sleep", "water", "mood", "steps"], max_length=24
    )
    onboarded: bool = False


# ------------------------------------------------------------------ metrics


class CustomMetric(BaseModel):
    id: str = Field(pattern=METRIC_ID)
    name: str = Field(min_length=1, max_length=60)
    unit: str = Field(default="", max_length=20)
    aggregate: Literal["sum", "avg", "last", "max", "min"] = "avg"
    decimals: int = Field(default=1, ge=0, le=3)
    higher_is_better: bool | None = None


class Goal(BaseModel):
    metric: str = Field(pattern=METRIC_ID)
    # A target (weight 75 kg, water 2000 ml/day) and/or a healthy band (glucose 4–7).
    target: float | None = None
    low: float | None = None
    high: float | None = None
    direction: Literal["down", "up", "range", "daily"] = "daily"
    target_date: str | None = Field(default=None, pattern=DAY)
    start_value: float | None = None
    start_day: str | None = Field(default=None, pattern=DAY)


class Reading(BaseModel):
    """One measurement. ``value`` carries the number in canonical units; blood
    pressure uses ``sys``/``dia``/``pulse``; sleep uses ``bed`` (``at`` is the
    wake time, ``value`` the hours) and ``quality``."""

    id: str = ID
    metric: str = Field(pattern=METRIC_ID)
    at: str = Field(min_length=10, max_length=40)  # ISO moment with offset
    value: float | None = Field(default=None, ge=-1_000_000, le=10_000_000)
    sys: int | None = Field(default=None, ge=40, le=320)
    dia: int | None = Field(default=None, ge=20, le=220)
    pulse: int | None = Field(default=None, ge=20, le=260)
    arm: Literal["left", "right"] | None = None
    position: Literal["sitting", "standing", "lying"] | None = None
    context: Literal["fasting", "pre_meal", "post_meal", "bedtime", "random"] | None = None
    bed: str | None = Field(default=None, max_length=40)
    quality: int | None = Field(default=None, ge=1, le=5)
    note: str = Field(default="", max_length=500)


# ----------------------------------------------------------------- symptoms


class Symptom(BaseModel):
    id: str = ID
    at: str = Field(min_length=10, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    severity: int = Field(default=5, ge=1, le=10)
    tags: list[str] = Field(default_factory=list, max_length=12)
    note: str = Field(default="", max_length=1000)


class PeriodDay(BaseModel):
    day: str = Field(pattern=DAY)
    flow: Literal["spotting", "light", "medium", "heavy"] = "medium"


# -------------------------------------------------------------- medications


class SlotDose(BaseModel):
    """A different amount at one time of day ("1000 mg in the evening")."""

    dose: str = Field(default="", max_length=60)  # "" = the medicine's own dose text
    per_dose: float | None = Field(default=None, gt=0, le=1000)  # units at this time; None = the medicine's


class Schedule(BaseModel):
    type: Literal["daily", "days", "interval", "as_needed"] = "daily"
    times: list[str] = Field(default_factory=lambda: ["08:00"], max_length=12)  # HH:MM
    weekdays: list[int] = Field(default_factory=list, max_length=7)  # 0 = Monday (for "days")
    every_days: int = Field(default=1, ge=1, le=90)  # for "interval", counted from ``anchor``
    # The first due day of an "interval" schedule (defaults to the medicine's start).
    anchor: str | None = Field(default=None, pattern=DAY)
    # Per-time amounts, keyed by HH:MM (only for times in ``times``).
    slot_doses: dict[str, SlotDose] = Field(default_factory=dict, max_length=12)

    @field_validator("slot_doses")
    @classmethod
    def _slot_keys(cls, v: dict[str, SlotDose]) -> dict[str, SlotDose]:
        import re as _re

        for k in v:
            if not _re.match(HHMM, k):
                raise ValueError(f"slot_doses key {k!r} isn't HH:MM")
        return v

    @model_validator(mode="after")
    def _only_scheduled_times(self) -> "Schedule":
        self.slot_doses = {k: sd for k, sd in self.slot_doses.items() if k in self.times and (sd.dose or sd.per_dose)}
        return self


class PlanStep(BaseModel):
    """An earlier (or, for a taper, an earlier-in-the-course) plan: it applied
    on every day up to and including ``until`` after the step before it.
    The medicine's own ``schedule``/``dose``/``per_dose`` apply after the last
    step — so changing a schedule never rewrites the days already lived."""

    until: str = Field(pattern=DAY)
    schedule: Schedule = Field(default_factory=Schedule)
    dose: str = Field(default="", max_length=60)
    per_dose: float = Field(default=1, gt=0, le=1000)
    stopped: bool = False  # a break: nothing was due on these days


class Medication(BaseModel):
    id: str = ID
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["medication", "supplement"] = "medication"
    dose: str = Field(default="", max_length=60)  # "500 mg", "2 puffs"
    form: Literal[
        "tablet", "capsule", "liquid", "injection", "inhaler", "drops", "patch", "cream", "powder", "spray", "other"
    ] = "tablet"
    per_dose: float = Field(default=1, gt=0, le=1000)  # units used per dose (2 tablets)
    schedule: Schedule = Field(default_factory=Schedule)
    with_food: Literal["any", "with", "before", "after", "empty"] = "any"
    start: str | None = Field(default=None, pattern=DAY)
    end: str | None = Field(default=None, pattern=DAY)
    remaining: float | None = Field(default=None, ge=0, le=100_000)  # units left
    purpose: str = Field(default="", max_length=200)
    prescriber: str = Field(default="", max_length=120)
    instructions: str = Field(default="", max_length=500)
    active: bool = True
    # When it was stopped (ISO moment): later slots on the ``end`` day don't count.
    stopped_at: str | None = Field(default=None, max_length=40)
    color: str = Field(default="", max_length=16)
    # As-needed (or any) limits — logging past them warns, never refuses.
    max_per_day: int | None = Field(default=None, ge=1, le=48)
    min_hours_between: float | None = Field(default=None, gt=0, le=72)
    schedule_history: list[PlanStep] = Field(default_factory=list, max_length=MAX_PLAN_STEPS)

    @model_validator(mode="after")
    def _interval_anchor(self) -> "Medication":
        # An "every N days" plan counts from a day — never silently daily.
        for sch in [self.schedule, *(st.schedule for st in self.schedule_history)]:
            if sch.type == "interval" and not sch.anchor:
                sch.anchor = self.start
        self.schedule_history.sort(key=lambda st: st.until)
        return self


class Dose(BaseModel):
    id: str = ID
    med_id: str = ID
    day: str = Field(pattern=DAY)
    slot: str | None = Field(default=None, pattern=HHMM)  # scheduled time; None = as needed
    status: Literal["taken", "late", "skipped"] = "taken"
    at: str | None = Field(default=None, max_length=40)  # when it was taken
    note: str = Field(default="", max_length=300)


# ----------------------------------------------------------------- records


class Appointment(BaseModel):
    id: str = ID
    at: str = Field(min_length=10, max_length=40)
    title: str = Field(default="", max_length=160)  # why
    who: str = Field(default="", max_length=120)
    provider_id: str | None = Field(default=None, max_length=40)
    location: str = Field(default="", max_length=300)
    questions: list[str] = Field(default_factory=list, max_length=40)
    notes: str = Field(default="", max_length=4000)  # what was said, outcome
    done: bool = False


class LabResult(BaseModel):
    id: str = ID
    day: str = Field(pattern=DAY)
    test: str = Field(min_length=1, max_length=120)
    value: float | None = None
    value_text: str = Field(default="", max_length=120)  # "negative", "trace"
    unit: str = Field(default="", max_length=30)
    ref_low: float | None = None
    ref_high: float | None = None
    flag: Literal["", "normal", "low", "high", "critical", "abnormal"] = ""
    panel: str = Field(default="", max_length=80)  # "Lipids", "Full blood count"
    note: str = Field(default="", max_length=500)


class Vaccination(BaseModel):
    id: str = ID
    day: str = Field(pattern=DAY)
    name: str = Field(min_length=1, max_length=120)
    dose_label: str = Field(default="", max_length=60)  # "Booster", "Dose 2 of 3"
    next_due: str | None = Field(default=None, pattern=DAY)
    provider: str = Field(default="", max_length=120)
    lot: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=500)


# --------------------------------------------------------------------- file


class HealthData(BaseModel):
    profile: Profile = Field(default_factory=Profile)
    settings: Settings = Field(default_factory=Settings)
    custom_metrics: list[CustomMetric] = Field(default_factory=list, max_length=50)
    goals: list[Goal] = Field(default_factory=list, max_length=80)
    readings: list[Reading] = Field(default_factory=list, max_length=MAX_READINGS)
    symptoms: list[Symptom] = Field(default_factory=list, max_length=MAX_SYMPTOMS)
    periods: list[PeriodDay] = Field(default_factory=list, max_length=MAX_PERIOD_DAYS)
    medications: list[Medication] = Field(default_factory=list, max_length=150)
    doses: list[Dose] = Field(default_factory=list, max_length=MAX_DOSES)
    appointments: list[Appointment] = Field(default_factory=list, max_length=2_000)
    labs: list[LabResult] = Field(default_factory=list, max_length=5_000)
    vaccinations: list[Vaccination] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def _stopped_meds_keep_history(self) -> "HealthData":
        # Older files marked a stopped medicine inactive without an end day;
        # stopping only ends *future* days, so its last logged day becomes the end.
        last: dict[str, str] = {}
        for d in self.doses:
            if d.day > last.get(d.med_id, ""):
                last[d.med_id] = d.day
        for m in self.medications:
            if not m.active and not m.end:
                m.end = last.get(m.id) or m.start
        return self
