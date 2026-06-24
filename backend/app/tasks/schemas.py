"""Pydantic schemas for the Scheduled Tasks API (Phase 1)."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.tasks.recurrence import VALID_FREQUENCIES

REASONING_EFFORTS = {"off", "low", "medium", "high"}


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=20_000)
    provider_id: uuid.UUID | None = None
    model_id: str | None = Field(default=None, max_length=200)
    reasoning_effort: str | None = None
    use_web_search: bool = False

    frequency: str
    hour: int | None = Field(default=None, ge=0, le=23)
    minute: int = Field(default=0, ge=0, le=59)
    weekday: int | None = Field(default=None, ge=0, le=6)
    day_of_month: int | None = Field(default=None, ge=1, le=28)
    timezone: str = Field(default="Australia/Sydney", max_length=64)

    enabled: bool = True
    notify: bool = True
    retention_runs: int = Field(default=30, ge=1, le=365)

    @field_validator("frequency")
    @classmethod
    def _freq(cls, v: str) -> str:
        if v not in VALID_FREQUENCIES:
            raise ValueError(f"frequency must be one of {sorted(VALID_FREQUENCIES)}")
        return v

    @field_validator("reasoning_effort")
    @classmethod
    def _effort(cls, v: str | None) -> str | None:
        if v is not None and v not in REASONING_EFFORTS:
            raise ValueError(f"reasoning_effort must be one of {sorted(REASONING_EFFORTS)}")
        return v


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    prompt: str | None = Field(default=None, min_length=1, max_length=20_000)
    provider_id: uuid.UUID | None = None
    model_id: str | None = Field(default=None, max_length=200)
    reasoning_effort: str | None = None
    use_web_search: bool | None = None

    frequency: str | None = None
    hour: int | None = Field(default=None, ge=0, le=23)
    minute: int | None = Field(default=None, ge=0, le=59)
    weekday: int | None = Field(default=None, ge=0, le=6)
    day_of_month: int | None = Field(default=None, ge=1, le=28)
    timezone: str | None = Field(default=None, max_length=64)

    enabled: bool | None = None
    notify: bool | None = None
    retention_runs: int | None = Field(default=None, ge=1, le=365)

    @field_validator("frequency")
    @classmethod
    def _freq(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_FREQUENCIES:
            raise ValueError(f"frequency must be one of {sorted(VALID_FREQUENCIES)}")
        return v


class TaskRunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    trigger: str
    title: str | None = None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cost_usd: float | None


class TaskRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    task_id: uuid.UUID
    status: str
    trigger: str
    title: str | None = None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    output_markdown: str | None
    error: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    cost_usd: float | None
    sources: list


class TaskResponse(BaseModel):
    id: uuid.UUID
    title: str
    prompt: str
    provider_id: uuid.UUID | None
    model_id: str | None
    reasoning_effort: str | None
    use_web_search: bool

    frequency: str
    hour: int | None
    minute: int
    weekday: int | None
    day_of_month: int | None
    timezone: str
    schedule_label: str

    enabled: bool
    notify: bool
    retention_runs: int

    next_run_at: datetime | None
    last_run_at: datetime | None
    last_status: str | None
    latest_run: TaskRunSummary | None

    created_at: datetime
    updated_at: datetime
