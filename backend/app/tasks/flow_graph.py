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
    # AI presets — specialised prompts that "just work" on the upstream text.
    SUMMARISE = "ai.summarise"
    EXTRACT = "ai.extract"
    # Non-AI processing nodes — each takes the upstream text, does one job, and
    # emits text for the next node. The first steps toward an n8n-style catalog.
    SEARCH_WEB = "search.web"
    FETCH_PAGE = "fetch.page"
    # Compound node: search → fetch top-N pages → synthesise a cited report.
    DEEP_RESEARCH = "research.deep"
    # Map node: split the upstream into items, run an AI body per item, aggregate.
    LOOP = "loop.foreach"
    # Memory node: a named sticky note that captures the upstream output (and can
    # persist across runs so a flow remembers state / compares to last time).
    MEMORY = "memory.store"
    # Flow helpers: join several branches into one, and pause the run.
    MERGE = "flow.merge"
    DELAY = "flow.delay"
    # Control-flow nodes — they don't transform the text, they *route* it. Only
    # the branch(es) they select run; everything downstream of an unselected
    # branch is skipped ("active-path" execution).
    CONDITION = "control.condition"
    ROUTER = "control.router"
    OUTPUT_REPORT = "output.report"
    # Workspace-output node: files the AI result as a card on a workspace board.
    OUTPUT_BOARD_CARD = "output.board_card"
    # Workspace-output node: posts the result as a message in a workspace chat.
    OUTPUT_CHAT_MESSAGE = "output.chat_message"
    # Workspace-output nodes: create a new note / sheet from the result.
    OUTPUT_NOTE = "output.note"
    OUTPUT_SHEET = "output.sheet"


# Every terminal "what to do with the result" node kind. output.report is the
# plain run report (a Simple task); the workspace-output kinds write into the
# task's home workspace and are Advanced-only.
OUTPUT_TYPES = frozenset(
    {
        NodeType.OUTPUT_REPORT,
        NodeType.OUTPUT_BOARD_CARD,
        NodeType.OUTPUT_CHAT_MESSAGE,
        NodeType.OUTPUT_NOTE,
        NodeType.OUTPUT_SHEET,
    }
)


# Interior "do work" node kinds — everything that sits between the trigger and
# the terminal output on the execution path. Each consumes the upstream text and
# produces text of its own (available downstream as ``{{node_<id>.output}}`` and,
# for the immediate next node, ``{{upstream_output}}``). The graph runner has an
# executor registered for each of these.
PROCESSING_TYPES = frozenset(
    {
        NodeType.AI_PROMPT,
        NodeType.SUMMARISE,
        NodeType.EXTRACT,
        NodeType.SEARCH_WEB,
        NodeType.FETCH_PAGE,
        NodeType.DEEP_RESEARCH,
        NodeType.LOOP,
        NodeType.MEMORY,
        NodeType.MERGE,
        NodeType.DELAY,
    }
)


# Control-flow node kinds. They pass the upstream text straight through on the
# branch(es) they select and skip the rest — the engine drives active-path
# execution off the ``source_handle`` an edge leaves them by.
CONTROL_TYPES = frozenset({NodeType.CONDITION, NodeType.ROUTER})


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


class SummariseData(BaseModel):
    """A preset AI step that condenses the upstream text. ``length`` tunes how
    tight the summary is."""

    length: str = "medium"  # short | medium | detailed
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None


class ExtractData(BaseModel):
    """A preset AI step that pulls structured JSON out of the upstream text.
    ``spec`` describes the wanted fields (a plain list or a JSON schema); the
    model returns a single JSON object matching it."""

    spec: str = ""
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None


class WebSearchData(BaseModel):
    """A web-search step (SearXNG or whichever provider is configured).

    ``query`` is a template — leave it blank to search for the upstream text
    verbatim, or write ``{{upstream_output}}`` / ``{{node_<id>.output}}`` to
    compose one. The step emits a numbered, model-friendly list of hits (which
    a downstream Fetch Page or AI step consumes) and records the structured
    citations on the run."""

    query: str = ""
    count: int = 5  # 1..20


class FetchPageData(BaseModel):
    """A fetch-and-extract step: pulls the readable text of a web page.

    ``url`` is a template; when blank it uses the first URL found in the
    upstream text (so it pairs naturally with a Web Search step). Fetches are
    SSRF-guarded and the body is capped."""

    url: str = ""
    max_chars: int = 8000  # cap the extracted text handed downstream


class LoopData(BaseModel):
    """A map-over-items step: splits the upstream text into items and runs the
    ``prompt`` (an AI body) once per item, with ``{{item}}`` and
    ``{{item_index}}`` available, then aggregates the results into one output.

    ``split_mode`` is ``lines`` (one item per non-empty line, bullet/number
    markers stripped) or ``json`` (a JSON array; objects are re-serialised).
    ``join_with`` is ``blank`` (blank line between results) or ``numbered``."""

    split_mode: str = "lines"  # lines | json
    prompt: str = ""
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None
    use_web_search: bool = False
    connector_ids: list[str] = Field(default_factory=list)
    max_items: int = 10  # 1..50 — a safety cap on iterations
    join_with: str = "blank"  # blank | numbered


class MemoryData(BaseModel):
    """A Memory node — a named sticky note that captures the upstream output so
    you can wire it into a later node as context (several can feed one node).

    With ``remember`` on it also persists across runs, keeping the last
    ``max_runs`` captured values, so a run can compare against previous runs
    ("what changed") or feed the history back in."""

    name: str = "Memory"
    remember: bool = False
    max_runs: int = 5  # 1..50 — how many past runs to keep when remembering


class MergeData(BaseModel):
    """Join several upstream branches into one. ``mode`` ``all`` waits for every
    incoming branch to have run (skips if any didn't — use for parallel
    branches); ``any`` proceeds with whichever branches are active (the default
    fan-in behaviour). ``separator`` joins the branch outputs."""

    mode: str = "all"  # all | any
    separator: str = "blank"  # blank | newline | space


class DelayData(BaseModel):
    """Pause the run before continuing. Short pauses only (rate-limiting / letting
    an external process settle) — the runner caps it so a long sleep can't tie up
    a worker."""

    seconds: int = 5


class DeepResearchData(BaseModel):
    """A compound research step: searches the web, fetches the top ``max_pages``
    results, then has the model synthesise a single cited report answering the
    query. ``query`` is a template; blank searches the upstream text. Needs a
    model (the synthesiser)."""

    query: str = ""
    max_pages: int = 5  # 1..10 pages to read
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None


class ConditionData(BaseModel):
    """A branch: tests the upstream text and routes to the ``true`` or ``false``
    handle. String operators only (our pipeline is text-centric); ``value`` is a
    template. ``matches`` treats ``value`` as a regex."""

    operator: str = "contains"
    # contains | not_contains | equals | not_equals | matches | is_empty |
    # is_not_empty
    value: str = ""
    case_sensitive: bool = False


class RouterCategory(BaseModel):
    """One branch of a Router — an ``id`` (the edge's ``source_handle``) plus a
    human name and a description the classifier reads."""

    id: str
    name: str = ""
    description: str = ""


class RouterData(BaseModel):
    """An AI classifier branch: the model reads the upstream text and picks one
    of ``categories``; that category's ``id`` becomes the active handle. Falls
    back to the first category when the model's answer matches none."""

    categories: list[RouterCategory] = Field(default_factory=list)
    provider_id: str | None = None
    model_id: str | None = None
    reasoning_effort: str | None = None


def branch_handles(node: FlowNode) -> list[str]:
    """The valid ``source_handle`` ids a control node can route to. Empty for a
    non-control node (its single implicit output handle is ``None``)."""
    if node.type == NodeType.CONDITION:
        return ["true", "false"]
    if node.type == NodeType.ROUTER:
        try:
            cats = RouterData.model_validate(node.data).categories
        except Exception:  # noqa: BLE001 — malformed router → no handles
            return []
        return [c.id for c in cats if c.id]
    return []


class ChatMessageOutputData(BaseModel):
    """Workspace-output: post the result as a message in a workspace chat.
    ``chat_item_id`` is the ``kind='chat'`` WorkspaceItem to post into."""

    chat_item_id: str | None = None


class NoteOutputData(BaseModel):
    """Workspace-output: create a new note from the result (Markdown → rich
    text). ``title`` is a template (blank → the output's first line);
    ``folder_item_id`` optionally files it under a workspace folder so scheduled
    notes stay tidy."""

    title: str = ""
    folder_item_id: str | None = None


class SheetOutputData(BaseModel):
    """Workspace-output: create a new spreadsheet from the result (parsed into
    rows — JSON array, Markdown table, or CSV/TSV). ``title`` template +
    optional ``folder_item_id``."""

    title: str = ""
    folder_item_id: str | None = None


class ReportOutputData(BaseModel):
    """The output step: the run report (implicit) + whether to notify."""

    notify: bool = True


class BoardCardOutputData(BaseModel):
    """Workspace-output: file the AI result as a card on a workspace board.

    ``board_item_id`` is the ``kind='board'`` WorkspaceItem in the task's home
    workspace; the card's title is the first line of the AI output and its
    description the full text."""

    board_item_id: str | None = None
    column: str = "todo"  # board column / status id
    priority: str = "medium"  # low | medium | high


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


def _adjacency(
    graph: FlowGraph,
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    out: dict[str, list[str]] = {}
    inc: dict[str, list[str]] = {}
    for e in graph.edges:
        out.setdefault(e.source, []).append(e.target)
        inc.setdefault(e.target, []).append(e.source)
    return out, inc


def is_linear_flow(graph: FlowGraph) -> bool:
    """True when the graph is a single unbranched path
    ``trigger → ai(+) → output`` of supported node types only — the shape the
    Phase-1 engine can execute. This is the superset of
    :func:`is_simple_graph` (which is just the one-AI-node special case); it
    additionally permits a *chain* of AI nodes (prompt-injection steps). No
    branches, cycles, loops, or unknown node types.
    """
    triggers = [
        n
        for n in graph.nodes
        if n.type in (NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_MANUAL)
    ]
    outs = [n for n in graph.nodes if n.type in OUTPUT_TYPES]
    procs = [n for n in graph.nodes if n.type in PROCESSING_TYPES]
    if len(triggers) != 1 or len(outs) != 1 or len(procs) < 1:
        return False
    # No unknown/unsupported node types in the mix.
    if len(triggers) + len(outs) + len(procs) != len(graph.nodes):
        return False

    out_adj, in_adj = _adjacency(graph)
    trig, out_node = triggers[0], outs[0]
    if in_adj.get(trig.id) or out_adj.get(out_node.id):
        return False  # trigger must have no input, output no output

    # Walk the single path from the trigger; every hop must be unambiguous.
    order: list[str] = []
    seen: set[str] = set()
    cur = trig.id
    while True:
        if cur in seen:
            return False  # cycle
        seen.add(cur)
        order.append(cur)
        nxts = out_adj.get(cur, [])
        if len(nxts) > 1:
            return False  # branch
        if not nxts:
            break
        cur = nxts[0]

    if order[-1] != out_node.id or len(order) != len(graph.nodes):
        return False
    # Every interior node (the AI chain) has exactly one in and one out.
    return all(
        len(in_adj.get(nid, [])) == 1 and len(out_adj.get(nid, [])) == 1
        for nid in order[1:-1]
    )


def topological_order(graph: FlowGraph) -> list[str]:
    """Kahn topological sort of the node ids. Ties are broken by the node's
    position in ``graph.nodes`` so a given graph always executes in a stable,
    reproducible order. Raises ``ValueError`` if the graph contains a cycle."""
    out_adj, in_adj = _adjacency(graph)
    node_ids = [n.id for n in graph.nodes]
    indeg = {nid: len(in_adj.get(nid, [])) for nid in node_ids}
    ready = [nid for nid in node_ids if indeg[nid] == 0]
    order: list[str] = []
    while ready:
        cur = ready.pop(0)
        order.append(cur)
        for nxt in out_adj.get(cur, []):
            if nxt not in indeg:
                continue  # edge to a phantom id — ignore
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    if len(order) != len(node_ids):
        raise ValueError("graph has a cycle")
    return order


def is_executable_graph(graph: FlowGraph, *, require_output: bool = True) -> bool:
    """True when the graph is a runnable DAG (the shape the engine executes):

    * exactly one trigger, with no incoming edges;
    * at least one terminal output node (outputs have no outgoing edges);
    * only known node types (trigger / processing / output);
    * acyclic; and
    * every node reachable from the trigger (no orphan steps).

    This is a strict superset of :func:`is_linear_flow` — it additionally
    permits fan-out (a node feeding several downstream nodes), fan-in (a node
    merging several upstream outputs), and multiple output sinks. Conditional
    branching (Router/Condition) still runs *every* reachable node; active-path
    selection is a later phase.

    ``require_output=False`` relaxes the "≥1 output" and "all reachable" rules
    for a **partial / test** run (run-to-here), where the user may still be
    wiring the flow and there's no output on the path yet.
    """
    triggers = [
        n
        for n in graph.nodes
        if n.type in (NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_MANUAL)
    ]
    outs = [n for n in graph.nodes if n.type in OUTPUT_TYPES]
    procs = [n for n in graph.nodes if n.type in PROCESSING_TYPES]
    controls = [n for n in graph.nodes if n.type in CONTROL_TYPES]
    if len(triggers) != 1:
        return False
    if require_output and len(outs) < 1:
        return False
    # No unknown/unsupported node types in the mix.
    if (
        len(triggers) + len(outs) + len(procs) + len(controls)
        != len(graph.nodes)
    ):
        return False

    out_adj, in_adj = _adjacency(graph)
    trig = triggers[0]
    if in_adj.get(trig.id):
        return False  # trigger must have no input
    if any(out_adj.get(o.id) for o in outs):
        return False  # outputs must be terminal

    try:
        topological_order(graph)
    except ValueError:
        return False

    if not require_output:
        return True  # partial run: orphans are fine while still building

    # Every node must be reachable from the trigger — no silently-ignored orphans.
    seen: set[str] = set()
    stack = [trig.id]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(out_adj.get(cur, []))
    return all(n.id in seen for n in graph.nodes)


def ancestors_of(graph: FlowGraph, node_id: str) -> set[str]:
    """All nodes upstream of ``node_id`` (reverse reachability), inclusive — the
    set that must run for a "run to here" partial execution."""
    _out, in_adj = _adjacency(graph)
    seen: set[str] = set()
    stack = [node_id]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(in_adj.get(cur, []))
    return seen


def output_nodes(graph: FlowGraph) -> list[FlowNode]:
    """All terminal output/action nodes (report / board-card / …). A DAG may
    have several (fan-out to multiple sinks)."""
    return [n for n in graph.nodes if n.type in OUTPUT_TYPES]


def terminal_output_node(graph: FlowGraph) -> FlowNode | None:
    """The single terminal output/action node (report or a workspace-output).
    Assumes :func:`is_linear_flow` holds."""
    outs = [n for n in graph.nodes if n.type in OUTPUT_TYPES]
    return outs[0] if len(outs) == 1 else None


def ordered_flow_nodes(graph: FlowGraph) -> list[FlowNode]:
    """Every interior processing node (AI / search / fetch / …) in execution
    order along the linear path. Assumes :func:`is_linear_flow` holds."""
    out_adj, _ = _adjacency(graph)
    trig = [
        n
        for n in graph.nodes
        if n.type in (NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_MANUAL)
    ][0]
    ordered: list[FlowNode] = []
    cur = trig.id
    while True:
        nxts = out_adj.get(cur, [])
        if not nxts:
            break
        cur = nxts[0]
        node = graph.node(cur)
        if node and node.type in PROCESSING_TYPES:
            ordered.append(node)
    return ordered


def ordered_ai_nodes(graph: FlowGraph) -> list[FlowNode]:
    """The ``ai.prompt`` nodes in execution order along the linear path — the
    AI-only subset of :func:`ordered_flow_nodes`. Assumes
    :func:`is_linear_flow` holds (call it first)."""
    return [n for n in ordered_flow_nodes(graph) if n.type == NodeType.AI_PROMPT]


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
    "SummariseData",
    "ExtractData",
    "ChatMessageOutputData",
    "NoteOutputData",
    "SheetOutputData",
    "WebSearchData",
    "FetchPageData",
    "DeepResearchData",
    "LoopData",
    "MemoryData",
    "MergeData",
    "DelayData",
    "ConditionData",
    "RouterData",
    "RouterCategory",
    "branch_handles",
    "ReportOutputData",
    "BoardCardOutputData",
    "OUTPUT_TYPES",
    "PROCESSING_TYPES",
    "CONTROL_TYPES",
    "terminal_output_node",
    "output_nodes",
    "SimpleTaskFields",
    "task_to_graph",
    "graph_to_task_fields",
    "is_simple_graph",
    "is_linear_flow",
    "is_executable_graph",
    "ancestors_of",
    "topological_order",
    "ordered_flow_nodes",
    "ordered_ai_nodes",
    "SIMPLE_TRIGGER_ID",
    "SIMPLE_AI_ID",
    "SIMPLE_OUTPUT_ID",
]
