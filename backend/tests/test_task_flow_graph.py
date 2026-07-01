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
    FlowGraph,
    FlowNode,
    SIMPLE_AI_ID,
    SIMPLE_OUTPUT_ID,
    SIMPLE_TRIGGER_ID,
    graph_to_task_fields,
    is_simple_graph,
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
