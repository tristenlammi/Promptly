"""The Tasks file's shape. Every field has a default (old files keep
loading); lists are bounded so years of use stay well under the file cap.

* A **task** has an optional due day (``YYYY-MM-DD``, the person's local
  day) and time (``HH:MM``); its alerts are minutes before that moment (an
  all-day task's moment is ``settings.default_time`` on the day).
* A **repeating** task stays one task: completing it logs the completion
  and moves ``due`` to the next occurrence (see ``recur.py``).
* ``log`` is the completion history (repeats included) — the Completed
  view, streaks and "what did I get done this week".
"""
from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator

MAX_TASKS = 5000
MAX_LISTS = 100
MAX_LOG = 5000

_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _day(v: str | None) -> str | None:
    if v in (None, ""):
        return None
    return date.fromisoformat(str(v)[:10]).isoformat()


def _clock(v: str | None) -> str | None:
    if v in (None, ""):
        return None
    s = str(v).strip()
    if re.match(r"^\d:\d\d$", s):
        s = "0" + s
    if not _CLOCK.match(s):
        raise ValueError("times are HH:MM (24-hour)")
    return s


class Repeat(BaseModel):
    freq: Literal["daily", "weekly", "monthly", "yearly"] = "weekly"
    interval: int = Field(default=1, ge=1, le=365)
    # Weekly: which weekdays (Mon=0 … Sun=6); empty = the due day's weekday.
    weekdays: list[int] = Field(default_factory=list, max_length=7)
    # Monthly: day of the month (1–31; a short month uses its last day).
    # Kept so "the 31st" doesn't drift to the 28th after February.
    month_day: int | None = Field(default=None, ge=1, le=31)
    # Next due counts from the day it was done ("every 3 days after I water
    # the plants"), not from the schedule.
    from_completion: bool = False
    until: str | None = None

    @field_validator("weekdays")
    @classmethod
    def _wd(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("weekdays are 0 (Mon) … 6 (Sun)")
        return sorted(set(v))

    @field_validator("until", mode="before")
    @classmethod
    def _until(cls, v: str | None) -> str | None:
        return _day(v)


class Step(BaseModel):
    id: str = Field(max_length=40)
    title: str = Field(max_length=300)
    done: bool = False


class Task(BaseModel):
    id: str = Field(max_length=40)
    title: str = Field(min_length=1, max_length=500)
    notes: str = Field(default="", max_length=10_000)
    list_id: str = Field(default="inbox", max_length=40)
    due: str | None = None
    time: str | None = None
    # Minutes before the due moment (0 = at the time). Needs a due day.
    alerts: list[int] = Field(default_factory=list, max_length=5)
    repeat: Repeat | None = None
    priority: int = Field(default=0, ge=0, le=3)  # 0 none · 1 low · 2 medium · 3 high
    tags: list[str] = Field(default_factory=list, max_length=20)
    steps: list[Step] = Field(default_factory=list, max_length=100)
    done: bool = False
    done_at: str | None = None
    created_at: str | None = None
    order: float = 0

    @field_validator("due", mode="before")
    @classmethod
    def _due(cls, v: str | None) -> str | None:
        return _day(v)

    @field_validator("time", mode="before")
    @classmethod
    def _time(cls, v: str | None) -> str | None:
        return _clock(v)

    @field_validator("alerts")
    @classmethod
    def _alerts(cls, v: list[int]) -> list[int]:
        if any(m < 0 or m > 60 * 24 * 60 for m in v):
            raise ValueError("alerts are 0 … 86400 minutes before")
        return sorted(set(v))

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for t in v:
            t = t.strip().lstrip("#@")[:40]
            if t and t.lower() not in (x.lower() for x in out):
                out.append(t)
        return out


class TaskList(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=80)
    color: str = "#3B7DD8"
    emoji: str = Field(default="", max_length=8)
    order: float = 0

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return v if _HEX.match(v or "") else "#3B7DD8"


class Done(BaseModel):
    id: str = Field(max_length=60)
    task_id: str = Field(max_length=40)
    title: str = Field(max_length=500)
    list_id: str = Field(default="inbox", max_length=40)
    at: str  # ISO moment
    due: str | None = None  # the occurrence it completed (repeats)


class Settings(BaseModel):
    # An all-day task's alert time, and where "remind me on the day" lands.
    default_time: str = "09:00"
    # A task given a time gets an "at the time" alert unless it has others.
    alert_timed: bool = True
    # One morning push with today's list.
    digest: bool = True
    digest_time: str = "08:00"
    week_start: int = Field(default=0, ge=0, le=6)  # 0 Mon, 6 Sun
    show_done: bool = False
    onboarded: bool = False

    @field_validator("default_time", "digest_time", mode="before")
    @classmethod
    def _clocks(cls, v: str | None) -> str:
        return _clock(v) or "09:00"


class TasksData(BaseModel):
    lists: list[TaskList] = Field(default_factory=list, max_length=MAX_LISTS)
    tasks: list[Task] = Field(default_factory=list, max_length=MAX_TASKS)
    log: list[Done] = Field(default_factory=list, max_length=MAX_LOG)
    settings: Settings = Field(default_factory=Settings)
