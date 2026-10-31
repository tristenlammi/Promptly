"""The shape of a ``.habits`` file: habits (each with its own day logs),
settings (day boundary, week start, reminder switches) and weekly reviews.

Every field has a default so old files keep loading; every list is bounded
so a file stays well under the 8 MB limit even after years of logging.
Calendar days are ``YYYY-MM-DD`` in the person's *logical* day (see
``settings.day_ends_at``); moments are ISO strings with an offset.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

HEX = r"^#[0-9A-Fa-f]{6}$"
DAY = r"^\d{4}-\d{2}-\d{2}$"
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"

HabitType = Literal["yes_no", "count", "duration", "avoid"]
ScheduleKind = Literal["daily", "weekdays", "per_week", "per_month", "every_n_days"]
TimeOfDay = Literal["morning", "afternoon", "evening", "anytime"]

Clock = Annotated[str, Field(pattern=HHMM)]

DEFAULT_AREAS = ["Health", "Fitness", "Mind", "Work", "Learning", "Relationships", "Home", "Money"]
DEFAULT_COLOR = "#7B6CD9"

MAX_HABITS = 100
MAX_LOGS = 4000  # ~11 years of daily logs per habit — past that, archive older data
MAX_ERAS = 60  # schedule / goal changes remembered per habit
MAX_REVIEWS = 520  # 10 years of weekly reviews


class Schedule(BaseModel):
    """When a habit is expected.

    * ``daily`` — every day.
    * ``weekdays`` — on ``days`` (0 = Monday … 6 = Sunday).
    * ``per_week`` — ``times`` on any days of each week (counted per week).
    * ``per_month`` — ``times`` on any days of each calendar month.
    * ``every_n_days`` — every ``every`` days, counted from the start date.
    """

    kind: ScheduleKind = "daily"
    days: list[int] = Field(default_factory=list, max_length=7)
    times: int = Field(default=3, ge=1, le=31)
    every: int = Field(default=2, ge=2, le=365)

    @model_validator(mode="after")
    def _normalise(self) -> "Schedule":
        self.days = sorted({d for d in self.days if 0 <= d <= 6})
        if self.kind == "weekdays" and not self.days:
            self.kind = "daily"
        if self.kind == "weekdays" and len(self.days) == 7:
            self.kind = "daily"
        if self.kind == "per_week":
            self.times = min(self.times, 7)
        return self


class Log(BaseModel):
    """One habit on one day. ``value``: 1 for yes/no, the count, the
    minutes, or (avoid habits) the number of slips — 0 is a confirmed clean
    day. ``skipped`` days are neutral: they never break a streak."""

    day: str = Field(pattern=DAY)
    value: float = Field(default=1, ge=0, le=100_000)
    note: str = Field(default="", max_length=1000)
    skipped: bool = False
    reason: str = Field(default="", max_length=200)
    at: str = Field(default="", max_length=40)


class Era(BaseModel):
    """How a habit was set up *before* ``until`` (exclusive) — kept when its
    schedule, type or goal changes so past days keep the rules they were
    lived under. Eras are ordered by ``until``; the habit's own fields apply
    from the last era's ``until`` on."""

    until: str = Field(pattern=DAY)
    type: HabitType = "yes_no"
    target: float = Field(default=1, gt=0, le=100_000)
    limit: int = Field(default=0, ge=0, le=1000)
    schedule: Schedule = Field(default_factory=Schedule)
    anchor_date: str | None = Field(default=None, pattern=DAY)


class ActiveTimer(BaseModel):
    """A running duration timer — in the file, so it survives closing the
    sheet, a reload, or switching device."""

    started_at: str = Field(min_length=10, max_length=40)
    day: str = Field(pattern=DAY)


class Habit(BaseModel):
    id: str = Field(min_length=1, max_length=48)
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field(default="", max_length=16)
    color: str = Field(default=DEFAULT_COLOR, pattern=HEX)
    area: str = Field(default="", max_length=40)
    type: HabitType = "yes_no"
    # count: per day ("8" glasses); duration: minutes per day. yes/no: 1.
    target: float = Field(default=1, gt=0, le=100_000)
    unit: str = Field(default="", max_length=24)
    # avoid: slips allowed per day before the day counts as missed (0 = none).
    limit: int = Field(default=0, ge=0, le=1000)
    schedule: Schedule = Field(default_factory=Schedule)
    time_of_day: TimeOfDay = "anytime"
    reminders: list[Clock] = Field(default_factory=list, max_length=6)
    start_date: str | None = Field(default=None, pattern=DAY)
    # every-N-days cadence counts from here (else the start date). Backfilling
    # before the start moves ``start_date`` but never this.
    anchor_date: str | None = Field(default=None, pattern=DAY)
    # The last day the habit existed (set on the copy an archive writes out).
    end_date: str | None = Field(default=None, pattern=DAY)
    # Reminders for X-per-week/month habits: only on these weekdays (empty =
    # any day) and/or only when behind the pace needed to hit the target.
    reminder_days: list[int] = Field(default_factory=list, max_length=7)
    remind_when_behind: bool = False
    active_timer: ActiveTimer | None = None
    history: list[Era] = Field(default_factory=list, max_length=MAX_ERAS)
    archived: bool = False
    intention: str = Field(default="", max_length=300)  # "After I pour my coffee, I will…"
    identity: str = Field(default="", max_length=200)  # "I am someone who…"
    why: str = Field(default="", max_length=1000)
    notes: str = Field(default="", max_length=2000)
    created_at: str = Field(default="", max_length=40)
    logs: list[Log] = Field(default_factory=list, max_length=MAX_LOGS)

    @model_validator(mode="after")
    def _normalise(self) -> "Habit":
        if self.type == "yes_no":
            self.target = 1
        # One log per day, oldest first (a later entry for a day wins).
        by_day: dict[str, Log] = {}
        for log in self.logs:
            by_day[log.day] = log
        self.logs = [by_day[d] for d in sorted(by_day)]
        self.reminders = sorted(set(self.reminders))
        self.reminder_days = sorted({d for d in self.reminder_days if 0 <= d <= 6})
        by_until: dict[str, Era] = {}
        for e in self.history:
            if e.type == "yes_no":
                e.target = 1
            by_until[e.until] = e
        self.history = [by_until[u] for u in sorted(by_until)]
        return self


class Settings(BaseModel):
    # The hour (0–6) the day rolls over: 3 → anything before 3 am still
    # counts for the previous day.
    day_ends_at: int = Field(default=0, ge=0, le=6)
    week_start: int = Field(default=0, ge=0, le=6)  # 0 = Monday … 6 = Sunday
    reminders_on: bool = True  # the master switch for every nudge below
    evening_summary: bool = False
    evening_time: Clock = "21:00"
    review_reminder: bool = True
    review_weekday: int = Field(default=6, ge=0, le=6)
    review_time: Clock = "18:00"
    celebrate: bool = True  # animations + haptics on check-off
    areas: list[Annotated[str, Field(min_length=1, max_length=40)]] = Field(
        default_factory=lambda: list(DEFAULT_AREAS), max_length=24
    )
    onboarded: bool = False


class Review(BaseModel):
    """A weekly review. ``week`` is the first day of that week. The person
    writes wins / misses / notes / focus; the assistant writes ``insights``."""

    week: str = Field(pattern=DAY)
    wins: str = Field(default="", max_length=3000)
    misses: str = Field(default="", max_length=3000)
    notes: str = Field(default="", max_length=5000)
    focus: str = Field(default="", max_length=1000)
    insights: str = Field(default="", max_length=6000)
    updated_at: str = Field(default="", max_length=40)


class HabitsData(BaseModel):
    habits: list[Habit] = Field(default_factory=list, max_length=MAX_HABITS)
    settings: Settings = Field(default_factory=Settings)
    reviews: list[Review] = Field(default_factory=list, max_length=MAX_REVIEWS)

    @field_validator("habits")
    @classmethod
    def _unique_ids(cls, v: list[Habit]) -> list[Habit]:
        seen: set[str] = set()
        for h in v:
            if h.id in seen:
                raise ValueError(f"two habits share the id {h.id!r}")
            seen.add(h.id)
        return v

    @model_validator(mode="after")
    def _reviews(self) -> "HabitsData":
        by_week: dict[str, Review] = {}
        for r in self.reviews:
            by_week[r.week] = r
        self.reviews = [by_week[w] for w in sorted(by_week)]
        return self
