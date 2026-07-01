"""Execution tests for the linear flow engine (Automations Phase 1).

The engine only *sequences* AI nodes and wires their outputs; the model/tool
work is delegated to ``runner._generate``. So we monkeypatch that (and the
provider/connector resolvers) to prove the sequencing + ``{{upstream_output}}``
chaining + usage accumulation, with no DB or LLM.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from app.tasks import graph_runner
from app.tasks.flow_graph import (
    AIPromptData,
    BoardCardOutputData,
    FlowEdge,
    FlowGraph,
    FlowNode,
    NodeType,
    ReportOutputData,
    ScheduleTriggerData,
)
from app.tasks.graph_runner import _interpolate, run_graph_flow
from app.tasks.models import Task


# --- interpolation -------------------------------------------------
def test_interpolate_substitutes_known_and_leaves_unknown():
    out = _interpolate(
        "up={{upstream_output}} trig={{trigger.payload}} keep={{mystery}}",
        {"upstream_output": "X", "trigger.payload": "Y"},
    )
    assert out == "up=X trig=Y keep={{mystery}}"


# --- helpers -------------------------------------------------------
def _ai(node_id: str, prompt: str) -> FlowNode:
    return FlowNode(
        id=node_id,
        type=NodeType.AI_PROMPT,
        data=AIPromptData(
            prompt=prompt, provider_id=str(uuid.uuid4()), model_id="m"
        ).model_dump(),
    )


def _chain(*ai_nodes: FlowNode) -> FlowGraph:
    nodes = [
        FlowNode(
            id="trigger",
            type=NodeType.TRIGGER_SCHEDULE,
            data=ScheduleTriggerData(frequency="daily", timezone="UTC").model_dump(),
        ),
        *ai_nodes,
        FlowNode(
            id="output",
            type=NodeType.OUTPUT_REPORT,
            data=ReportOutputData().model_dump(),
        ),
    ]
    chain = ["trigger", *[n.id for n in ai_nodes], "output"]
    edges = [FlowEdge(source=a, target=b) for a, b in zip(chain, chain[1:])]
    return FlowGraph(mode="advanced", nodes=nodes, edges=edges)


@pytest.fixture
def patched_model(monkeypatch):
    """Fake out the model layer: each AI step echoes its resolved prompt so the
    chaining is observable, and reports fixed usage."""

    async def fake_generate(*, prompt, **kw):
        return (
            f"OUT[{prompt}]",
            [{"url": "http://x"}],  # same source each hop → exercises dedup
            {"prompt_tokens": 1, "completion_tokens": 2, "cost_usd": 0.5},
        )

    async def fake_provider(provider_id, model_id, db):
        return (object(), model_id or "m")

    async def fake_connectors(db, *, user_id, workspace_id, connector_ids):
        return ([], {}, [])

    monkeypatch.setattr(graph_runner, "_generate", fake_generate)
    monkeypatch.setattr(graph_runner, "_resolve_provider", fake_provider)
    monkeypatch.setattr(graph_runner, "_resolve_connectors_by_ids", fake_connectors)
    monkeypatch.setattr(graph_runner, "_build_system_prompt", lambda **kw: "SYS")


def _task() -> Task:
    return Task(
        title="t",
        prompt="p",
        frequency="daily",
        minute=0,
        timezone="UTC",
        use_web_search=False,
        notify=True,
        user_id=uuid.uuid4(),
        workspace_id=None,
    )


# --- execution -----------------------------------------------------
async def test_single_ai_report_is_the_node_output(patched_model):
    graph = _chain(_ai("a0", "write the report"))
    text, sources, usage, _node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    assert text == "OUT[write the report]"
    assert usage == {"prompt_tokens": 1, "completion_tokens": 2, "cost_usd": 0.5}
    assert sources == [{"url": "http://x"}]  # deduped


async def test_chain_injects_upstream_output_and_accumulates(patched_model):
    graph = _chain(
        _ai("a0", "step one"),
        _ai("a1", "refine using: {{upstream_output}}"),
    )
    text, sources, usage, _node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    # Final report is the last node, which received the first node's output.
    assert text == "OUT[refine using: OUT[step one]]"
    # Usage summed across both hops; sources deduped by url.
    assert usage["prompt_tokens"] == 2
    assert usage["completion_tokens"] == 4
    assert usage["cost_usd"] == 1.0
    assert sources == [{"url": "http://x"}]


async def test_board_card_output_files_card_and_notes_it(patched_model, monkeypatch):
    async def fake_file(db, *, task, data, text):
        assert data.board_item_id == "b1"
        assert data.column == "todo"
        assert text == "OUT[write it]"
        return 'Filed as a card on "My Board".'

    monkeypatch.setattr(graph_runner, "_file_board_card", fake_file)

    nodes = [
        FlowNode(
            id="trigger",
            type=NodeType.TRIGGER_SCHEDULE,
            data=ScheduleTriggerData(frequency="daily", timezone="UTC").model_dump(),
        ),
        _ai("a0", "write it"),
        FlowNode(
            id="out",
            type=NodeType.OUTPUT_BOARD_CARD,
            data=BoardCardOutputData(board_item_id="b1").model_dump(),
        ),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="out"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _sources, _usage, _node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    # The run report keeps the AI text and notes that the card was filed.
    assert "OUT[write it]" in text
    assert 'Filed as a card on "My Board".' in text


async def test_node_runs_captured_per_node(patched_model):
    graph = _chain(_ai("a0", "one"), _ai("a1", "two"))
    _text, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    # Two AI steps + the report output, each recorded with its output.
    assert [n["type"] for n in node_runs] == [
        NodeType.AI_PROMPT,
        NodeType.AI_PROMPT,
        NodeType.OUTPUT_REPORT,
    ]
    assert node_runs[0]["label"] == "AI step 1"
    assert node_runs[0]["output"] == "OUT[one]"
    assert all(n["status"] == "success" for n in node_runs)


async def test_non_linear_flow_is_rejected(patched_model):
    graph = _chain(_ai("a0", "x"))
    graph.nodes.append(FlowNode(id="out2", type=NodeType.OUTPUT_REPORT, data={}))
    graph.edges.append(FlowEdge(source="a0", target="out2"))  # branch
    with pytest.raises(graph_runner.TaskRunError):
        await run_graph_flow(
            task=_task(),
            graph=graph,
            user=object(),
            run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            db=None,
        )
