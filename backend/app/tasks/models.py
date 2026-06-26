"""ORM models for Scheduled Tasks (Roadmap v2 — Phase 1).

``Task`` is the user-authored automation: a prompt + a recurrence + which
model/tools to use. ``TaskRun`` is one *execution* of that task — an
immutable, dated document. The Tasks UI reads like a newsletter inbox:
each run is its own back-issue with its own output, cost, and status,
rather than appending to one endless conversation.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


class Task(UUIDPKMixin, TimestampMixin, Base):
    """A user's scheduled automation."""

    __tablename__ = "tasks"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Optional home workspace. When set, the task shows up as an
    # "automation" node in that workspace's navigator (synthesised at
    # tree-read time, like chats) and a run can reach the workspace's
    # restricted connectors. NULL = a top-level task under /tasks.
    # SET NULL on workspace delete so the task survives as a top-level one.
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    title: Mapped[str] = mapped_column(String(120), nullable=False)
    # The instruction the model runs each period.
    prompt: Mapped[str] = mapped_column(Text, nullable=False)

    # Which model to run with. Mirrors the conversation contract:
    # a provider row id + the provider-native model id string. Kept as a
    # bare UUID (no hard FK) so deleting a provider doesn't cascade-nuke
    # task history — a run simply fails with a clear "provider gone"
    # error instead.
    provider_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # off / low / medium / high — degrades gracefully on non-reasoning models.
    reasoning_effort: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # When on, the run gets the ``search`` tool family (web_search +
    # fetch_url) so e.g. a daily-news task can pull fresh facts.
    use_web_search: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    # ---- Recurrence (structured; advanced cron deferred) ----
    # frequency ∈ {hourly, daily, weekly, monthly}
    frequency: Mapped[str] = mapped_column(String(10), nullable=False)
    # Local wall-clock the run fires at. ``hour`` is unused for hourly.
    hour: Mapped[int | None] = mapped_column(Integer, nullable=True)
    minute: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # weekly: 0=Mon … 6=Sun. monthly: 1..28.
    weekday: Mapped[int | None] = mapped_column(Integer, nullable=True)
    day_of_month: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # IANA tz; AU-friendly default (Promptly is AU-only for now).
    timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, default="Australia/Sydney"
    )

    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notify: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Retention: keep at most this many runs; older ones are swept (T.4).
    retention_runs: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30
    )

    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)

    def __repr__(self) -> str:
        return f"<Task id={self.id} title={self.title!r} freq={self.frequency}>"


class TaskConnector(Base):
    """Join: which MCP connectors a task may call during its run.

    Explicit per-task selection (decision) — a run only advertises the
    connectors listed here, re-checked at run time against what the task
    owner can actually reach (so a revoked grant silently drops the tool).
    """

    __tablename__ = "task_connectors"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    connector_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_connectors.id", ondelete="CASCADE"), primary_key=True
    )


class TaskRun(UUIDPKMixin, CreatedAtMixin, Base):
    """One execution of a :class:`Task` — an immutable dated report."""

    __tablename__ = "task_runs"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # One-line title/summary derived from the output so runs are
    # distinguishable in the rail (rather than a wall of identical dates).
    title: Mapped[str | None] = mapped_column(String(140), nullable=True)

    # pending → running → success | failed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    # schedule | manual
    trigger: Mapped[str] = mapped_column(
        String(10), nullable=False, default="schedule"
    )

    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    output_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Web citations the run's search tools collected (same shape as
    # ``messages.sources``) so the report can render a sources footer.
    sources: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    def __repr__(self) -> str:
        return f"<TaskRun id={self.id} task={self.task_id} status={self.status}>"
