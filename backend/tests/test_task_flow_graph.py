"""Round-trip proof for the Task ⇄ node-graph serialisation (Automations Phase 0).

The Two-Tier Automation plan rests on "Simple Mode is a view of the same
engine." Before building any of it, we pressure-test the keystone: does every
shape of the *existing* linear ``Task`` survive being turned into a node graph
and back, byte-for-byte on the workflow-defining fields? If yes, Advanced mode
can be a superset of this graph; if no, the model is wrong and we've found it
for the price of a unit test instead of a rewrite.

Pure logic only — no live Postgres (Task rows are constructed in memory), in
keeping with the rest of the suite.
"""
from __future__ import annotations

import uuid

import pytest

from app.tasks.flow_graph import (
    NodeType,
    FlowEdge,
    FlowGraph,
    FlowNode,
    SIMPLE_AI_ID,
    SIMPLE_OUTPUT_ID,
    SIMPLE_TRIGGER_ID,
    graph_to_task_fields,
    is_linear_flow,
    is_simple_graph,
    ordered_ai_nodes,
    task_to_graph,
)
from app.tasks.flow_graph import _row_fields
from app.tasks.models import Task


def make_task(**overrides) -> Task:
    """A fully-specified in-memory Task (defaults aren't applied without a
    flush, so every field the serialiser reads is set explicitly)."""
    fields = dict(
        title="Daily digest",
        prompt="Summarise today's tech news.",
        frequency="daily",
        hour=9,
        minute=0,
        weekday=None,
        day_of_month=None,
        timezone="Australia/Sydney",
        provider_id=uuid.uuid4(),
        model_id="openai/gpt-4o",
        reasoning_effort="medium",
        use_web_search=True,
        notify=True,
    )
    fields.update(overrides)
    return Task(**fields)


# ---------------------------------------------------------------------
# Shape: a Task derives the canonical trigger → ai → output graph.
# ---------------------------------------------------------------------
def test_task_to_graph_has_canonical_three_node_shape():
    task = make_task()
    graph = task_to_graph(task, connector_ids=[])

    assert graph.mode == "simple"
    assert [n.id for n in graph.nodes] == [
        SIMPLE_TRIGGER_ID,
        SIMPLE_AI_ID,
        SIMPLE_OUTPUT_ID,
    ]
    assert graph.node(SIMPLE_TRIGGER_ID).type == NodeType.TRIGGER_SCHEDULE
    assert graph.node(SIMPLE_AI_ID).type == NodeType.AI_PROMPT
    assert graph.node(SIMPLE_OUTPUT_ID).type == NodeType.OUTPUT_REPORT

    # Wired in a line, left-to-right.
    assert {(e.source, e.target) for e in graph.edges} == {
        (SIMPLE_TRIGGER_ID, SIMPLE_AI_ID),
        (SIMPLE_AI_ID, SIMPLE_OUTPUT_ID),
    }
    xs = [n.position.x for n in graph.nodes]
    assert xs == sorted(xs) and len(set(xs)) == 3  # laid out, no overlap

    assert is_simple_graph(graph)


def test_ai_node_carries_prompt_model_and_tools():
    pid = uuid.uuid4()
    cid = uuid.uuid4()
    task = make_task(provider_id=pid, model_id="anthropic/claude", use_web_search=False)
    graph = task_to_graph(task, connector_ids=[cid])

    ai = graph.node(SIMPLE_AI_ID).data
    assert ai["prompt"] == "Summarise today's tech news."
    assert ai["provider_id"] == str(pid)
    assert ai["model_id"] == "anthropic/claude"
    assert ai["use_web_search"] is False
    assert ai["connector_ids"] == [str(cid)]


# ---------------------------------------------------------------------
# Round-trip: task → graph → fields reconstructs the original workflow.
# ---------------------------------------------------------------------
@pytest.mark.parametrize(
    "overrides",
    [
        {},  # daily 09:00, model + web search
        {"frequency": "hourly", "hour": None, "minute": 15},
        {"frequency": "weekly", "weekday": 2, "hour": 8, "minute": 30},
        {"frequency": "monthly", "day_of_month": 1, "hour": 6, "minute": 0},
        {"use_web_search": False},
        {"notify": False},
        {"reasoning_effort": None},
        {"provider_id": None, "model_id": None},  # no model configured
        {"timezone": "UTC"},
    ],
)
def test_roundtrip_preserves_workflow_fields(overrides):
    task = make_task(**overrides)
    connector_ids = [uuid.uuid4(), uuid.uuid4()]

    graph = task_to_graph(task, connector_ids=connector_ids)
    restored = graph_to_task_fields(graph)

    assert restored == _row_fields(task, connector_ids)


def test_roundtrip_with_no_connectors():
    task = make_task()
    graph = task_to_graph(task, connector_ids=[])
    assert graph_to_task_fields(graph).connector_ids == []


def test_connector_ids_roundtrip_as_uuids():
    cids = [uuid.uuid4() for _ in range(3)]
    task = make_task()
    restored = graph_to_task_fields(task_to_graph(task, connector_ids=cids))
    assert restored.connector_ids == cids
    assert all(isinstance(c, uuid.UUID) for c in restored.connector_ids)


# ---------------------------------------------------------------------
# The graph is JSON-native (it will be a JSONB column in Phase 1).
# ---------------------------------------------------------------------
def test_graph_is_json_serialisable_and_reloads():
    task = make_task()
    graph = task_to_graph(task, connector_ids=[uuid.uuid4()])

    as_json = graph.model_dump_json()
    reloaded = FlowGraph.model_validate_json(as_json)

    # Survives a JSON round-trip with identical reconstructed fields.
    assert graph_to_task_fields(reloaded) == graph_to_task_fields(graph)
    assert reloaded.version == graph.version


# ---------------------------------------------------------------------
# Reversibility gate: non-simple graphs are detected, not silently coerced.
# ---------------------------------------------------------------------
def test_extra_node_makes_graph_non_simple():
    task = make_task()
    graph = task_to_graph(task, connector_ids=[])
    # Splice a second AI node between ai and output — no longer a Simple Task.
    graph.nodes.append(
        FlowNode(id="ai2", type=NodeType.AI_PROMPT, data={"prompt": "extra"})
    )

    assert is_simple_graph(graph) is False
    with pytest.raises(ValueError):
        graph_to_task_fields(graph)


def test_empty_graph_is_not_simple():
    assert is_simple_graph(FlowGraph()) is False


# ---------------------------------------------------------------------
# Linear flows: the executable superset (a *chain* of AI steps).
# ---------------------------------------------------------------------
def _linear_graph(n_ai: int) -> FlowGraph:
    """trigger → ai_1 → … → ai_n → output."""
    nodes = [FlowNode(id="trigger", type=NodeType.TRIGGER_SCHEDULE, data={"frequency": "daily"})]
    ai_ids = [f"ai{i}" for i in range(n_ai)]
    for aid in ai_ids:
        nodes.append(FlowNode(id=aid, type=NodeType.AI_PROMPT, data={"prompt": aid}))
    nodes.append(FlowNode(id="output", type=NodeType.OUTPUT_REPORT, data={"notify": True}))
    chain = ["trigger", *ai_ids, "output"]
    edges = [FlowEdge(source=a, target=b) for a, b in zip(chain, chain[1:])]
    return FlowGraph(mode="advanced", nodes=nodes, edges=edges)


def test_simple_graph_is_also_linear():
    assert is_linear_flow(task_to_graph(make_task(), connector_ids=[]))


def test_multi_ai_chain_is_linear_and_ordered():
    graph = _linear_graph(3)
    assert is_linear_flow(graph)
    assert [n.id for n in ordered_ai_nodes(graph)] == ["ai0", "ai1", "ai2"]


def test_branch_is_not_linear():
    graph = _linear_graph(1)
    # ai0 fans out to a second output → a branch, not a chain.
    graph.nodes.append(FlowNode(id="out2", type=NodeType.OUTPUT_REPORT, data={}))
    graph.edges.append(FlowEdge(source="ai0", target="out2"))
    assert is_linear_flow(graph) is False


def test_cycle_is_not_linear():
    graph = _linear_graph(2)
    graph.edges.append(FlowEdge(source="ai1", target="ai0"))  # back-edge
    assert is_linear_flow(graph) is False


def test_board_card_terminal_is_linear_but_not_simple():
    from app.tasks.flow_graph import terminal_output_node

    nodes = [
        FlowNode(id="trigger", type=NodeType.TRIGGER_SCHEDULE, data={"frequency": "daily"}),
        FlowNode(id="ai0", type=NodeType.AI_PROMPT, data={"prompt": "x"}),
        FlowNode(
            id="out",
            type=NodeType.OUTPUT_BOARD_CARD,
            data={"board_item_id": "b1", "column": "todo", "priority": "medium"},
        ),
    ]
    edges = [
        FlowEdge(source="trigger", target="ai0"),
        FlowEdge(source="ai0", target="out"),
    ]
    g = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    assert is_linear_flow(g) is True
    # A workspace-output flow can't be represented as a plain Simple task.
    assert is_simple_graph(g) is False
    assert terminal_output_node(g).type == NodeType.OUTPUT_BOARD_CARD


def test_unknown_node_type_is_not_linear():
    graph = _linear_graph(1)
    graph.nodes.append(FlowNode(id="x", type="action.http", data={}))
    graph.edges.append(FlowEdge(source="ai0", target="x"))
    graph.edges.append(FlowEdge(source="x", target="output"))
    # 'output' now has two incoming; and an unsupported node type is present.
    assert is_linear_flow(graph) is False
