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
    ConditionData,
    FlowEdge,
    FlowGraph,
    FlowNode,
    NodeType,
    ReportOutputData,
    RouterCategory,
    RouterData,
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


async def test_fan_out_to_two_report_sinks_runs_both(patched_model):
    # a0 fans out to two report outputs — the DAG engine runs both sinks.
    graph = _chain(_ai("a0", "x"))
    graph.nodes.append(
        FlowNode(id="out2", type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump())
    )
    graph.edges.append(FlowEdge(source="a0", target="out2"))
    text, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    assert text == "OUT[x]"
    # One AI step recorded plus two report sinks.
    assert [n["type"] for n in node_runs] == [
        NodeType.AI_PROMPT,
        NodeType.OUTPUT_REPORT,
        NodeType.OUTPUT_REPORT,
    ]


async def test_fan_in_merges_upstream_outputs(patched_model):
    # Two AI branches off the trigger merge into a third AI node, whose prompt
    # sees both upstreams via {{upstream_output}}.
    nodes = [
        FlowNode(
            id="trigger",
            type=NodeType.TRIGGER_SCHEDULE,
            data=ScheduleTriggerData(frequency="daily", timezone="UTC").model_dump(),
        ),
        _ai("a0", "left"),
        _ai("a1", "right"),
        _ai("merge", "combine: {{upstream_output}}"),
        FlowNode(id="output", type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump()),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="trigger", target="a1"),
        FlowEdge(source="a0", target="merge"),
        FlowEdge(source="a1", target="merge"),
        FlowEdge(source="merge", target="output"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _s, _u, _n = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    # merge received both branch outputs joined together.
    assert text == "OUT[combine: OUT[left]\n\nOUT[right]]"


def _trigger() -> FlowNode:
    return FlowNode(
        id="trigger",
        type=NodeType.TRIGGER_SCHEDULE,
        data=ScheduleTriggerData(frequency="daily", timezone="UTC").model_dump(),
    )


def _report(node_id: str) -> FlowNode:
    return FlowNode(
        id=node_id, type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump()
    )


async def test_condition_runs_true_branch_and_skips_false(patched_model):
    # trigger → a0 → condition; true → r_true, false → r_false.
    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(
            id="c",
            type=NodeType.CONDITION,
            data=ConditionData(operator="contains", value="OUT").model_dump(),
        ),
        _report("r_true"),
        _report("r_false"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="c"),
        FlowEdge(source="c", target="r_true", source_handle="true"),
        FlowEdge(source="c", target="r_false", source_handle="false"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    by = {n["node_id"]: n for n in node_runs}
    assert by["c"]["status"] == "success"
    assert by["r_true"]["status"] == "success"  # condition upstream contained "OUT"
    assert by["r_false"]["status"] == "skipped"
    assert text == "OUT[x]"  # the taken report branch's input


async def test_condition_false_skips_action_sink(patched_model, monkeypatch):
    # If the condition is false, the board-card sink on the true branch must NOT
    # be filed — the whole point of active-path execution.
    filed = []

    async def fake_file(db, *, task, data, text):
        filed.append(text)
        return "filed"

    monkeypatch.setattr(graph_runner, "_file_board_card", fake_file)

    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(
            id="c",
            type=NodeType.CONDITION,
            data=ConditionData(operator="contains", value="ZZZ").model_dump(),
        ),
        FlowNode(
            id="card",
            type=NodeType.OUTPUT_BOARD_CARD,
            data=BoardCardOutputData(board_item_id="b1").model_dump(),
        ),
        _report("r_false"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="c"),
        FlowEdge(source="c", target="card", source_handle="true"),
        FlowEdge(source="c", target="r_false", source_handle="false"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    _t, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    by = {n["node_id"]: n for n in node_runs}
    assert filed == []  # card NOT filed (true branch skipped)
    assert by["card"]["status"] == "skipped"
    assert by["r_false"]["status"] == "success"


async def test_router_selects_matching_branch(patched_model, monkeypatch):
    async def fake_router_gen(*, prompt, **kw):
        # The classifier answers "urgent"; a0 also runs through this fake but its
        # output is irrelevant to routing.
        return ("urgent", [], {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.0})

    monkeypatch.setattr(graph_runner, "_generate", fake_router_gen)

    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(
            id="rt",
            type=NodeType.ROUTER,
            data=RouterData(
                categories=[
                    RouterCategory(id="urgent", name="Urgent"),
                    RouterCategory(id="normal", name="Normal"),
                ],
                provider_id=str(uuid.uuid4()),
                model_id="m",
            ).model_dump(),
        ),
        _report("out_urgent"),
        _report("out_normal"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="rt"),
        FlowEdge(source="rt", target="out_urgent", source_handle="urgent"),
        FlowEdge(source="rt", target="out_normal", source_handle="normal"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    _t, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    by = {n["node_id"]: n for n in node_runs}
    assert by["rt"]["output"] == "urgent"
    assert by["out_urgent"]["status"] == "success"
    assert by["out_normal"]["status"] == "skipped"


async def test_cyclic_flow_is_rejected(patched_model):
    graph = _chain(_ai("a0", "x"), _ai("a1", "y"))
    graph.edges.append(FlowEdge(source="a1", target="a0"))  # back-edge → cycle
    with pytest.raises(graph_runner.TaskRunError):
        await run_graph_flow(
            task=_task(),
            graph=graph,
            user=object(),
            run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            db=None,
        )


async def test_output_less_flow_is_rejected(patched_model):
    # trigger → a0, no output node at all.
    nodes = [
        FlowNode(
            id="trigger",
            type=NodeType.TRIGGER_SCHEDULE,
            data=ScheduleTriggerData(frequency="daily", timezone="UTC").model_dump(),
        ),
        _ai("a0", "x"),
    ]
    edges = [FlowEdge(source="trigger", target="a0")]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    with pytest.raises(graph_runner.TaskRunError):
        await run_graph_flow(
            task=_task(),
            graph=graph,
            user=object(),
            run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            db=None,
        )
