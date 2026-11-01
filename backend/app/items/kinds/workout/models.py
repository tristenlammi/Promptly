"""The shape of a ``.workout`` file. Every field has a default (old files keep
loading) and every list is bounded, so even a decade of training stays well
under the 8 MB file limit. Loads are stored in **kg** (``settings.units`` is
only how they're shown); calendar days are ``YYYY-MM-DD`` in the person's
zone; moments are ISO strings with an offset."""
from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field, SerializationInfo, field_validator, model_serializer, model_validator

LB = 0.45359237

Unit = Literal["kg", "lb"]
Goal = Literal["strength", "hypertrophy", "fat_loss", "general", "endurance", "powerlifting"]
Experience = Literal["beginner", "intermediate", "advanced"]
Muscle = Literal[
    "chest", "front_delts", "side_delts", "rear_delts", "triceps", "biceps", "forearms", "lats", "upper_back",
    "traps", "lower_back", "abs", "obliques", "glutes", "quads", "hamstrings", "adductors", "abductors", "calves",
]
Equip = Literal[
    "full_gym", "barbell", "rack", "bench", "dumbbell", "kettlebell", "cable", "machine", "smith", "ez_bar",
    "trap_bar", "pullup_bar", "dip_station", "band", "rings", "cardio", "sled", "bodyweight",
]
Pattern = Literal[
    "squat", "hinge", "lunge", "push_h", "push_v", "pull_h", "pull_v", "fly", "raise", "curl", "extension",
    "knee_ext", "knee_flex", "hip", "calf", "shrug", "core", "carry", "olympic", "plyo", "cardio",
]
LogType = Literal["weight_reps", "bodyweight_reps", "assisted", "duration", "distance"]
SetType = Literal["warmup", "working", "drop", "failure"]

DAY = r"^\d{4}-\d{2}-\d{2}$"
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"

KG_PLATES = [25.0, 20.0, 15.0, 10.0, 5.0, 2.5, 1.25]
LB_PLATES = [round(p * LB, 4) for p in (45, 35, 25, 10, 5, 2.5)]


def _full(info: SerializationInfo | None) -> bool:
    ctx = getattr(info, "context", None)
    return bool(ctx and ctx.get("full"))


class Compact(BaseModel):
    """Stored without the fields that hold their default (``omit``) — the
    big lists (sets, logged exercises, workouts, prescriptions, sessions)
    are most of a file's bytes. ``model_dump(context={"full": True})`` gives
    every field back (what the actions work on: see :func:`expand`)."""

    omit: ClassVar[dict[str, Any]] = {}

    @model_serializer(mode="wrap")
    def _compact(self, handler: Any, info: SerializationInfo) -> dict:
        out = handler(self)
        if _full(info):
            return out
        drop = self.omit
        return {k: v for k, v in out.items() if not (k in drop and v == drop[k])}


class Plate(BaseModel):
    kg: float = Field(gt=0, le=60)
    pairs: int = Field(default=10, ge=1, le=30)


def default_plates(units: str = "kg") -> list[dict]:
    return [{"kg": p, "pairs": 10} for p in (LB_PLATES if units == "lb" else KG_PLATES)]


class Baseline(BaseModel):
    """A best the person states for a lift they haven't logged yet ("bench
    90 × 5"). Load suggestions calibrate from it until the lift has logged
    sessions (then the log wins). ``kg``: the load (added load for
    bodyweight lifts, assistance for assisted ones)."""

    exercise_id: str = Field(max_length=60)
    kg: float = Field(ge=0, le=1500)
    reps: int = Field(default=1, ge=1, le=30)
    date: str | None = Field(default=None, pattern=DAY)


class Settings(BaseModel):
    units: Unit = "kg"
    bodyweight_kg: float | None = Field(default=None, ge=20, le=400)
    sex: Literal["", "male", "female"] = ""
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    experience: Experience = "beginner"
    goal: Goal = "general"
    days_per_week: int = Field(default=3, ge=1, le=7)
    session_minutes: int = Field(default=60, ge=15, le=240)
    # Preferred training weekdays, 0 = Monday … 6 = Sunday.
    training_days: list[int] = Field(default_factory=list, max_length=7)
    # What each training day is for: weekday ("0" = Monday) → "Upper", "Legs", …
    day_focus: dict[str, str] = Field(default_factory=dict)
    equipment: list[Equip] = Field(default_factory=lambda: ["full_gym"], max_length=30)
    # Home gyms: the exact dumbbells / kettlebells there are (empty = a full
    # rack in ``dumbbell_step_kg`` steps up to ``dumbbell_max_kg``).
    dumbbells_kg: list[float] = Field(default_factory=list, max_length=80)
    dumbbell_step_kg: float = Field(default=2.0, gt=0, le=10)
    dumbbell_max_kg: float | None = Field(default=None, gt=0, le=150)
    kettlebells_kg: list[float] = Field(default_factory=lambda: [8.0, 12.0, 16.0, 20.0, 24.0, 28.0, 32.0], max_length=40)
    machine_step_kg: float = Field(default=5.0, gt=0, le=25)
    bar_kg: float = Field(default=20.0, ge=0, le=60)
    ez_bar_kg: float = Field(default=10.0, ge=0, le=40)
    trap_bar_kg: float = Field(default=25.0, ge=0, le=60)
    plates: list[Plate] = Field(default_factory=lambda: [Plate(**p) for p in default_plates()], max_length=20)
    injuries: str = Field(default="", max_length=1000)
    # Stated bests for lifts not logged yet (calibration only).
    baselines: list[Baseline] = Field(default_factory=list, max_length=60)
    avoid_exercises: list[str] = Field(default_factory=list, max_length=100)
    rest_compound_s: int = Field(default=180, ge=15, le=900)
    rest_isolation_s: int = Field(default=90, ge=15, le=900)
    # Legacy (RIR / RPE display) — no longer shown or used; kept so old files load.
    effort: Literal["rir", "rpe"] = "rir"
    e1rm_formula: Literal["epley", "brzycki"] = "epley"
    week_start: Literal["mon", "sun"] = "mon"
    reminders: bool = True
    reminder_time: str = Field(default="08:00", pattern=HHMM)
    remind_before_min: int = Field(default=60, ge=0, le=720)
    rest_timer: bool = True
    weight_step_kg: float = Field(default=2.5, gt=0, le=50)  # the logger's − / + step
    vibrate: bool = True
    sound: bool = True
    warmups: bool = True
    onboarded: bool = False

    @model_serializer(mode="wrap")
    def _drop_legacy(self, handler: Any) -> dict:
        out = handler(self)
        out.pop("effort", None)  # the old RIR/RPE display choice: never written back
        return out

    @field_validator("training_days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        return sorted({d for d in v if 0 <= d <= 6})

    @field_validator("day_focus")
    @classmethod
    def _focus(cls, v: dict[str, str]) -> dict[str, str]:
        return {k: str(f).strip()[:40] for k, f in v.items() if k in {"0", "1", "2", "3", "4", "5", "6"} and str(f).strip()}

    @field_validator("dumbbells_kg", "kettlebells_kg")
    @classmethod
    def _weights(cls, v: list[float]) -> list[float]:
        return sorted({round(float(x), 4) for x in v if 0 < x <= 200})


class CustomExercise(BaseModel):
    id: str = Field(max_length=60)
    name: str = Field(min_length=1, max_length=80)
    primary: list[Muscle] = Field(default_factory=list, max_length=6)
    secondary: list[Muscle] = Field(default_factory=list, max_length=8)
    equipment: Equip = "bodyweight"
    pattern: Pattern = "core"
    log: LogType = "weight_reps"
    compound: bool = False
    notes: str = Field(default="", max_length=500)
    archived: bool = False


class Prescription(Compact):
    """One exercise in a planned session or routine: sets × a rep range
    with a load (absolute, or a % of the current e1RM — or
    neither: suggested from history when the session starts)."""

    omit: ClassVar[dict[str, Any]] = {
        "seconds": None, "meters": None, "target_rir": None, "load_kg": None, "load_pct": None, "rest_s": None,
        "superset": None, "warmup": None, "drop_sets": 0, "notes": "",
    }

    id: str = Field(max_length=40)
    exercise_id: str = Field(max_length=60)
    sets: int = Field(default=3, ge=1, le=20)
    reps_min: int = Field(default=8, ge=1, le=100)
    reps_max: int = Field(default=12, ge=1, le=100)
    seconds: int | None = Field(default=None, ge=1, le=86_400)  # duration lifts / cardio
    meters: float | None = Field(default=None, gt=0, le=1_000_000)  # distance
    target_rir: float | None = Field(default=None, ge=0, le=6)  # legacy: read, ignored, never written
    load_kg: float | None = Field(default=None, ge=0, le=1500)
    load_pct: float | None = Field(default=None, ge=20, le=110)
    rest_s: int | None = Field(default=None, ge=0, le=900)
    superset: str | None = Field(default=None, max_length=4)
    warmup: bool | None = None  # None = automatic (first heavy compound)
    drop_sets: int = Field(default=0, ge=0, le=3)
    notes: str = Field(default="", max_length=300)

    @field_validator("target_rir", mode="before")
    @classmethod
    def _legacy(cls, v: Any) -> None:
        return None  # an old RIR target: dropped (progression is reps × load)

    @model_validator(mode="after")
    def _order(self) -> "Prescription":
        if self.reps_max < self.reps_min:
            self.reps_min, self.reps_max = self.reps_max, self.reps_min
        return self


class PlannedSession(Compact):
    omit: ClassVar[dict[str, Any]] = {"time": None, "notes": "", "program_id": None, "week": None, "deload": False, "workout_id": None}

    id: str = Field(max_length=40)
    date: str = Field(pattern=DAY)
    time: str | None = Field(default=None, pattern=HHMM)
    name: str = Field(default="Workout", max_length=80)
    notes: str = Field(default="", max_length=1000)
    exercises: list[Prescription] = Field(default_factory=list, max_length=30)
    program_id: str | None = Field(default=None, max_length=40)
    week: int | None = Field(default=None, ge=1, le=52)
    deload: bool = False
    status: Literal["planned", "done", "skipped"] = "planned"
    workout_id: str | None = Field(default=None, max_length=40)


class Routine(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=80)
    notes: str = Field(default="", max_length=1000)
    exercises: list[Prescription] = Field(default_factory=list, max_length=30)


class ProgramWeek(BaseModel):
    n: int = Field(ge=1, le=52)
    label: str = Field(default="", max_length=40)
    deload: bool = False
    notes: str = Field(default="", max_length=300)


class Program(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=80)
    goal: Goal | Literal[""] = ""
    start_date: str = Field(pattern=DAY)
    weeks: list[ProgramWeek] = Field(default_factory=list, max_length=52)
    notes: str = Field(default="", max_length=2000)
    status: Literal["active", "done", "archived"] = "active"


class SetLog(Compact):
    """One set. ``kg`` is the load — added load for bodyweight lifts, the
    machine's assistance for assisted ones. Serialised without empty fields
    (sets are most of a file's bytes)."""

    omit: ClassVar[dict[str, Any]] = {"type": "working", "kg": None, "suggest_kg": None, "reps": None, "seconds": None, "meters": None, "rir": None, "at": None}

    id: str = Field(max_length=24)
    type: SetType = "working"
    kg: float | None = Field(default=None, ge=0, le=1500)
    # Live workout only: the load the logger suggests (a tick adopts it).
    suggest_kg: float | None = Field(default=None, ge=0, le=1500)
    reps: int | None = Field(default=None, ge=0, le=1000)
    seconds: int | None = Field(default=None, ge=0, le=86_400)
    meters: float | None = Field(default=None, ge=0, le=1_000_000)
    rir: float | None = Field(default=None, ge=0, le=10)  # legacy: read, ignored, never written
    done: bool = True
    at: str | None = Field(default=None, max_length=40)

    @field_validator("rir", mode="before")
    @classmethod
    def _legacy(cls, v: Any) -> None:
        return None  # an old logged RIR: dropped (never read)


class WorkoutExercise(Compact):
    omit: ClassVar[dict[str, Any]] = {"notes": "", "superset": None, "rest_s": None, "rx": None}

    id: str = Field(max_length=40)
    exercise_id: str = Field(max_length=60)
    sets: list[SetLog] = Field(default_factory=list, max_length=60)
    notes: str = Field(default="", max_length=500)
    superset: str | None = Field(default=None, max_length=4)
    rest_s: int | None = Field(default=None, ge=0, le=900)
    rx: Prescription | None = None  # what was prescribed


class Workout(Compact):
    omit: ClassVar[dict[str, Any]] = {
        "ended_at": None, "duration_s": None, "notes": "", "session_id": None, "program_id": None,
        "bodyweight_kg": None, "effort": None, "deload": False, "rest_until": None, "rest_total_s": None,
    }

    id: str = Field(max_length=40)
    name: str = Field(default="Workout", max_length=80)
    date: str = Field(pattern=DAY)
    started_at: str | None = Field(default=None, max_length=40)
    ended_at: str | None = Field(default=None, max_length=40)
    duration_s: int | None = Field(default=None, ge=0, le=86_400)
    exercises: list[WorkoutExercise] = Field(default_factory=list, max_length=40)
    notes: str = Field(default="", max_length=2000)
    session_id: str | None = Field(default=None, max_length=40)
    program_id: str | None = Field(default=None, max_length=40)
    bodyweight_kg: float | None = Field(default=None, ge=20, le=400)
    effort: int | None = Field(default=None, ge=1, le=10)  # legacy session RPE: read, ignored, never written
    # A deload session: progression keys off the last non-deload one.
    deload: bool = False
    # The live session only: the rest timer.
    rest_until: str | None = Field(default=None, max_length=40)
    rest_total_s: int | None = Field(default=None, ge=0, le=900)

    @field_validator("effort", mode="before")
    @classmethod
    def _legacy(cls, v: Any) -> None:
        return None  # an old session RPE: dropped (never read)


# What a finished workout keeps of the prescription it followed (the rep
# range and load the next session's progression reads).
RX_KEPT = ("id", "exercise_id", "sets", "reps_min", "reps_max", "load_kg")


class WorkoutData(BaseModel):
    settings: Settings = Field(default_factory=Settings)
    exercises: list[CustomExercise] = Field(default_factory=list, max_length=500)
    routines: list[Routine] = Field(default_factory=list, max_length=100)
    programs: list[Program] = Field(default_factory=list, max_length=50)
    planned: list[PlannedSession] = Field(default_factory=list, max_length=600)
    workouts: list[Workout] = Field(default_factory=list, max_length=2500)
    active: Workout | None = None

    @model_validator(mode="after")
    def _sorted(self) -> "WorkoutData":
        self.planned.sort(key=lambda s: (s.date, s.time or ""))
        self.workouts.sort(key=lambda w: (w.date, w.started_at or ""))
        return self

    @model_serializer(mode="wrap")
    def _trim(self, handler: Any, info: SerializationInfo) -> dict:
        """Finished workouts drop what only the live logger needs: each
        set's tick (always done) and tick time, and all but the rep range /
        load of the prescription."""
        out = handler(self)
        if _full(info):
            return out
        for w in out.get("workouts", []):
            for we in w.get("exercises", []):
                for st in we.get("sets", []):
                    if st.get("done", True):
                        st.pop("done", None)
                    st.pop("at", None)
                rx = we.get("rx")
                if rx:
                    we["rx"] = {k: rx[k] for k in RX_KEPT if k in rx}
        return out


def expand(data: dict) -> dict:
    """Every field present (defaults filled in) — what actions, text and
    reminders read, so a compactly stored file indexes safely."""
    return WorkoutData.model_validate(data).model_dump(mode="json", context={"full": True})


def expand_in_place(data: dict) -> dict:
    full = expand(data)
    data.clear()
    data.update(full)
    return data
