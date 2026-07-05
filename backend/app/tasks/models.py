"""ORM models for Scheduled Tasks (Roadmap v2 — Phase 1).

``Task`` is the user-authored automation: a prompt + a recurrence + which
model/tools to use. ``TaskRun`` is one *execution* of that task — an
immutable, dated document. The Tasks UI reads like a newsletter inbox:
each run is its own back-issue with its own output, cost, and status,
rather than appending to one endless conversation.
"""
from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from typing import Any
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

    # Workspace-tree placement (0140) — mirrors the columns on
    # ``Conversation``. An automation is synthesised into its workspace's
    # navigator with no backing ``workspace_items`` row; these let the
    # user drag it to reorder or drop it into a folder. Both NULL =
    # "unplaced": the tree falls back to recency order at root.
    #   * ``ws_parent_id`` — the folder it lives under, NULL for root.
    #     ``ON DELETE SET NULL`` lifts it back to root if the folder goes.
    #   * ``ws_position`` — float sort key among siblings, NULL until placed.
    ws_parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    ws_position: Mapped[float | None] = mapped_column(Float, nullable=True)

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
    # Overlap policy (A3). ``allow`` (default) keeps today's behaviour — a new
    # scheduled fire starts even if the previous run is still going. ``skip``
    # makes the scheduler pass on a fire while a run for this task is still
    # pending/running, so a slow run can't stack up on the next tick. Manual
    # "Run now" is always honoured (the user asked for it explicitly).
    concurrency: Mapped[str] = mapped_column(
        String(8), nullable=False, default="allow", server_default="allow"
    )
    # Per-node retry lives on the graph nodes' ``data`` (retries: 0..5), not
    # here — a task-level column would be meaningless for a multi-node flow.
    # Retention: keep at most this many runs; older ones are swept (T.4).
    retention_runs: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30
    )

    # Advanced flow graph (Automations Phase 1). NULL = a plain Simple task
    # whose trigger→AI→output graph is derived from the columns above on
    # demand; non-NULL = an Advanced flow whose stored node graph is the
    # source of truth (see app/tasks/flow_graph.py + flow_service.py).
    flow_graph: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB, nullable=True
    )

    # Inbound-webhook credential (0136). NULL until the owner adds a
    # webhook trigger; the hook URL is /api/hooks/{task_id}/{secret}.
    # Stored (not derived from SECRET_KEY) so one task's leaked URL can
    # be rotated without touching anything else.
    webhook_secret: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )

    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)

    @property
    def is_advanced(self) -> bool:
        """True when this automation has a stored Advanced flow graph (vs. a
        plain Simple task whose graph is derived from the columns). Drives
        whether the UI opens the flow editor or the classic single-prompt view."""
        return self.flow_graph is not None

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


class AutomationNodeMemory(UUIDPKMixin, TimestampMixin, Base):
    """Persistent state for a Memory node in a task's flow.

    One row per (task, memory node). ``entries`` is a rolling list of the last
    N runs' captured values — ``[{"value": str, "at": iso8601}]``, oldest first
    — so a run can compare against previous runs ("what changed") or feed the
    history back in as context. Trimmed to the node's configured run limit.
    """

    __tablename__ = "automation_node_memory"
    __table_args__ = (
        UniqueConstraint("task_id", "node_id", name="uq_automation_memory"),
    )

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entries: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )


class FlowGraphVersion(UUIDPKMixin, CreatedAtMixin, Base):
    """A saved snapshot of a task's Advanced flow graph (A3 — version history).

    One row appended on each graph save, so an edit can be undone across saves
    and the history browsed/restored (mirrors the note editor's precedent). Only
    the newest N per task are kept (older ones swept on save). ``summary`` is a
    cheap human label (node count + trigger) so the list reads without decoding
    every blob.
    """

    __tablename__ = "flow_graph_versions"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Short "6 nodes · schedule" style label for the restore list.
    summary: Mapped[str | None] = mapped_column(String(140), nullable=True)

    def __repr__(self) -> str:
        return f"<FlowGraphVersion id={self.id} task={self.task_id}>"


class TaskRun(UUIDPKMixin, CreatedAtMixin, Base):
    """One execution of a :class:`Task` — an immutable dated report."""

    __tablename__ = "task_runs"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # One-line title/summary derived from the output so runs are
    # distinguishable in the rail (rather than a wall of identical dates).
    title: Mapped[str | None] = mapped_column(String(140), nullable=True)

    # pending → running → success | warning | failed
    # ("warning" = ran to completion but the output self-reports a dead
    # end — empty searches, missing data — so the UI flags it amber.)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    # schedule | manual | webhook
    trigger: Mapped[str] = mapped_column(
        String(10), nullable=False, default="schedule"
    )
    # Inbound request body for webhook-triggered runs (0136) — exposed to
    # the flow as ``{{trigger.payload}}``. NULL for schedule/manual runs.
    trigger_payload: Mapped[str | None] = mapped_column(Text, nullable=True)

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

    # Per-node outputs for the flow run inspector: one entry per AI step and
    # the terminal output node (node_id/type/label/status/output/tokens). NULL
    # for Simple single-step runs and runs predating the flow engine.
    node_runs: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )

    def __repr__(self) -> str:
        return f"<TaskRun id={self.id} task={self.task_id} status={self.status}>"
