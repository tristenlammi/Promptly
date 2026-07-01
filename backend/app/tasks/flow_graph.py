"""Canonical node-graph representation of a Scheduled Task (Automations Phase 0).

The Two-Tier Automation plan hinges on one claim: *"Simple Mode is a curated
view of the same underlying engine."* This module is the keystone that makes
that claim true. It serialises the existing linear ``Task`` — trigger → AI →
output — into a node graph, and back out again, **without changing any
behaviour, storage, or UI**. If every existing Task round-trips cleanly through
here, the Advanced flow editor can be built as a *superset* of this graph
rather than as a second, parallel system.

Nothing here is persisted yet. The graph is *derived on demand* from the
columns already on the ``tasks`` row (recurrence, prompt, model, tools) plus
the task's selected connector ids. Phase 1 adds a ``flow_graph`` JSONB column
and the React-Flow editor; the shape defined here is what that column will
store, so the schema is intentionally JSON-native (uuids as strings, freeform
per-node ``data``) and versioned.

Node ``type`` strings are namespaced exactly as the plan proposes
(``trigger.schedule``, ``ai.prompt``, ``output.report``, …) so new node kinds
slot in without a schema change.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from app.tasks.models import Task

# Bump when the on-disk graph shape changes incompatibly (Phase 1 persistence
# will migrate old graphs forward from this number).
FLOW_GRAPH_VERSION = 1


# ---------------------------------------------------------------------
# Node type registry
# ---------------------------------------------------------------------
class NodeType:
    """Namespaced node kinds. Only the four needed to represent today's Task
    are wired end-to-end; the rest of the plan's catalogue (mcp/http/condition/
    loop/workspace-output) will register here as it lands."""

    TRIGGER_SCHEDULE = "trigger.schedule"
    TRIGGER_MANUAL = "trigger.manual"
    AI_PROMPT = "ai.prompt"
    OUTPUT_REPORT = "output.report"


# Stable node ids for the canonical 3-node "simple" graph. Deterministic so a
# Task always derives byte-identical, and so a round-trip is idempotent.
SIMPLE_TRIGGER_ID = "trigger"
SIMPLE_AI_ID = "ai"
SIMPLE_OUTPUT_ID = "output"


# ---------------------------------------------------------------------
# Graph schema (JSON-native; becomes the flow_graph JSONB column in Phase 1)
# ---------------------------------------------------------------------
class Position(BaseModel):
    x: float = 0
    y: float = 0


class FlowNode(BaseModel):
    id: str
    type: str
    position: Position = Field(default_factory=Position)
    # Per-type config. Kept freeform (validated by the typed *Data models
    # below on the way in/out) so new node kinds don't need a schema change.
    data: dict[str, Any] = Field(default_factory=dict)


class FlowEdge(BaseModel):
    source: str
    target: str
    # Reserved for branching (Condition/Router) — which port the edge leaves.
    source_handle: str | None = None
    target_handle: str | None = None


class FlowGraph(BaseModel):
    version: int = FLOW_GRAPH_VERSION
    mode: str = "simple"  # "simple" | "advanced"
    nodes: list[FlowNode] = Field(default_factory=list)
    edges: list[FlowEdge] = Field(default_factory=list)

    def node(self, node_id: str) -> FlowNode | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def nodes_of_type(self, node_type: str) -> list[FlowNode]:
        return [n for n in self.nodes if n.type == node_type]


# ---------------------------------------------------------------------
# Typed per-node ``data`` payloads. These validate the freeform dict and
# document exactly which Task columns each node carries.
# ---------------------------------------------------------------------
class ScheduleTriggerData(BaseModel):
    """A Task's recurrence — the structured schedule the scheduler fires on."""

    frequency: str  # hourly | daily | weekly | monthly
    hour: int | None = None
    minute: int = 0
    weekday: int | None = None  # weekly: 0=Mon … 6=Sun
    day_of_month: int | None = None  # monthly: 1..28
    timezone: str = "Australia/Sydney"


class AIPromptData(BaseModel):
    """The AI step: the instruction plus which model/tools it runs with.

    Connectors live on the AI node (they're the tools *this* step may call),
    mirroring how the current runner resolves them for a single LLM turn.
    Phase 2+ can split them into standalone MCP action nodes; the simple graph
    keeps them inline so it stays a faithful 1:1 of today's Task."""

    prompt: str
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None
    use_web_search: bool = False
    connector_ids: list[str] = Field(default_factory=list)


class ReportOutputData(BaseModel):
    """The output step: the run report (implicit) + whether to notify."""

    notify: bool = True


# ---------------------------------------------------------------------
# Round-trip: Task ⇄ graph
# ---------------------------------------------------------------------
@dataclass
class SimpleTaskFields:
    """The workflow-defining fields a Simple graph encodes — i.e. everything
    the runner reads *except* task-level metadata (title, enabled, workspace,
    retention, next_run_at), which lives on the row, not in the flow. Used to
    prove a graph reconstructs the same behaviour it was derived from."""

    # trigger
    frequency: str
    hour: int | None
    minute: int
    weekday: int | None
    day_of_month: int | None
    timezone: str
    # ai
    prompt: str
    provider_id: uuid.UUID | None
    model_id: str | None
    reasoning_effort: str | None
    use_web_search: bool
    connector_ids: list[uuid.UUID] = field(default_factory=list)
    # output
    notify: bool = True


def _row_fields(task: Task, connector_ids: list[uuid.UUID]) -> SimpleTaskFields:
    """The task's workflow fields straight off the row (the round-trip target)."""
    return SimpleTaskFields(
        frequency=task.frequency,
        hour=task.hour,
        minute=task.minute,
        weekday=task.weekday,
        day_of_month=task.day_of_month,
        timezone=task.timezone,
        prompt=task.prompt,
        provider_id=task.provider_id,
        model_id=task.model_id,
        reasoning_effort=task.reasoning_effort,
        use_web_search=task.use_web_search,
        connector_ids=list(connector_ids),
        notify=task.notify,
    )


def task_to_graph(
    task: Task, connector_ids: list[uuid.UUID] | None = None
) -> FlowGraph:
    """Derive the canonical 3-node graph (trigger → AI → output) for a Task.

    Pure + DB-free: the caller supplies the task's selected connector ids (the
    runner already resolves these from ``task_connectors``). Positions are laid
    out left-to-right so the derived graph renders sensibly the first time the
    editor opens it.
    """
    connector_ids = connector_ids or []

    trigger = FlowNode(
        id=SIMPLE_TRIGGER_ID,
        type=NodeType.TRIGGER_SCHEDULE,
        position=Position(x=0, y=0),
        data=ScheduleTriggerData(
            frequency=task.frequency,
            hour=task.hour,
            minute=task.minute,
            weekday=task.weekday,
            day_of_month=task.day_of_month,
            timezone=task.timezone,
        ).model_dump(),
    )
    ai = FlowNode(
        id=SIMPLE_AI_ID,
        type=NodeType.AI_PROMPT,
        position=Position(x=280, y=0),
        data=AIPromptData(
            prompt=task.prompt,
            provider_id=str(task.provider_id) if task.provider_id else None,
            model_id=task.model_id,
            reasoning_effort=task.reasoning_effort,
            use_web_search=task.use_web_search,
            connector_ids=[str(c) for c in connector_ids],
        ).model_dump(),
    )
    output = FlowNode(
        id=SIMPLE_OUTPUT_ID,
        type=NodeType.OUTPUT_REPORT,
        position=Position(x=560, y=0),
        data=ReportOutputData(notify=task.notify).model_dump(),
    )
    return FlowGraph(
        mode="simple",
        nodes=[trigger, ai, output],
        edges=[
            FlowEdge(source=SIMPLE_TRIGGER_ID, target=SIMPLE_AI_ID),
            FlowEdge(source=SIMPLE_AI_ID, target=SIMPLE_OUTPUT_ID),
        ],
    )


def is_simple_graph(graph: FlowGraph) -> bool:
    """True when a graph is the canonical linear shape a Simple Task can hold:
    one schedule/manual trigger → one ai.prompt → one output.report, wired in a
    line. This is what the UI checks to decide whether "Simple mode" can still
    represent a flow (or whether it must open in the Advanced editor)."""
    triggers = [
        n
        for n in graph.nodes
        if n.type in (NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_MANUAL)
    ]
    ai = graph.nodes_of_type(NodeType.AI_PROMPT)
    out = graph.nodes_of_type(NodeType.OUTPUT_REPORT)
    if not (len(triggers) == 1 and len(ai) == 1 and len(out) == 1):
        return False
    if len(graph.nodes) != 3:
        return False
    wanted = {
        (triggers[0].id, ai[0].id),
        (ai[0].id, out[0].id),
    }
    have = {(e.source, e.target) for e in graph.edges}
    return have == wanted


def graph_to_task_fields(graph: FlowGraph) -> SimpleTaskFields:
    """Extract the Task-equivalent workflow fields from a canonical simple
    graph. The inverse of :func:`task_to_graph`; raises ``ValueError`` if the
    graph isn't representable as a Simple Task (the caller should route those
    to the Advanced engine instead)."""
    if not is_simple_graph(graph):
        raise ValueError("graph is not a simple trigger→ai→output flow")

    trig_node = (
        graph.nodes_of_type(NodeType.TRIGGER_SCHEDULE)
        or graph.nodes_of_type(NodeType.TRIGGER_MANUAL)
    )[0]
    trig = ScheduleTriggerData.model_validate(trig_node.data)
    ai = AIPromptData.model_validate(graph.nodes_of_type(NodeType.AI_PROMPT)[0].data)
    out = ReportOutputData.model_validate(
        graph.nodes_of_type(NodeType.OUTPUT_REPORT)[0].data
    )

    return SimpleTaskFields(
        frequency=trig.frequency,
        hour=trig.hour,
        minute=trig.minute,
        weekday=trig.weekday,
        day_of_month=trig.day_of_month,
        timezone=trig.timezone,
        prompt=ai.prompt,
        provider_id=uuid.UUID(ai.provider_id) if ai.provider_id else None,
        model_id=ai.model_id,
        reasoning_effort=ai.reasoning_effort,
        use_web_search=ai.use_web_search,
        connector_ids=[uuid.UUID(c) for c in ai.connector_ids],
        notify=out.notify,
    )


__all__ = [
    "FLOW_GRAPH_VERSION",
    "NodeType",
    "Position",
    "FlowNode",
    "FlowEdge",
    "FlowGraph",
    "ScheduleTriggerData",
    "AIPromptData",
    "ReportOutputData",
    "SimpleTaskFields",
    "task_to_graph",
    "graph_to_task_fields",
    "is_simple_graph",
    "SIMPLE_TRIGGER_ID",
    "SIMPLE_AI_ID",
    "SIMPLE_OUTPUT_ID",
]
