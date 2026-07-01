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
    ChatMessageOutputData,
    ConditionData,
    DeepResearchData,
    DelayData,
    ExtractData,
    FlowEdge,
    FlowGraph,
    FlowNode,
    LoopData,
    MergeData,
    NodeType,
    SummariseData,
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


async def test_deep_research_node_synthesises_from_fetched_pages(
    patched_model, monkeypatch
):
    from types import SimpleNamespace

    import trafilatura

    import app.net.safe_fetch as safe_fetch_mod
    import app.search.providers as search_providers
    import app.search.service as search_service

    async def fake_pick(db, user, **kw):
        return object()

    async def fake_run_search(provider, query, count):
        return [
            SimpleNamespace(title=f"R{i}", url=f"https://ex/{i}", snippet=f"snip{i}")
            for i in range(count)
        ]

    async def fake_safe_fetch(method, url, **kw):
        return SimpleNamespace(
            text="<html>body</html>", raise_for_status=lambda: None
        )

    monkeypatch.setattr(search_service, "pick_search_provider", fake_pick)
    monkeypatch.setattr(search_providers, "run_search", fake_run_search)
    monkeypatch.setattr(safe_fetch_mod, "safe_fetch", fake_safe_fetch)
    monkeypatch.setattr(trafilatura, "extract", lambda html: "EXTRACTED_BODY")

    nodes = [
        _trigger(),
        FlowNode(
            id="dr",
            type=NodeType.DEEP_RESEARCH,
            data=DeepResearchData(
                query="q", max_pages=3, provider_id=str(uuid.uuid4()), model_id="m"
            ).model_dump(),
        ),
        _report("out"),
    ]
    edges = [FlowEdge(source="trigger", target="dr"), FlowEdge(source="dr", target="out")]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, sources, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    assert len(sources) == 3  # one per fetched page
    by = {n["node_id"]: n for n in node_runs}
    assert by["dr"]["status"] == "success"
    # The fetched evidence was fed into the synthesis prompt (echoed by the fake).
    assert "EXTRACTED_BODY" in text
    assert "https://ex/0" in text


def test_split_items_lines_strips_markers():
    from app.tasks.graph_runner import _split_items

    assert _split_items("- a\n2. b\n\n* c", "lines", 10) == ["a", "b", "c"]


def test_split_items_json_array():
    from app.tasks.graph_runner import _split_items

    assert _split_items('["x", {"k": 1}]', "json", 10) == ["x", '{"k": 1}']


def test_split_items_caps_iterations():
    from app.tasks.graph_runner import _split_items

    assert _split_items("a\nb\nc\nd", "lines", 2) == ["a", "b"]


async def test_loop_runs_body_per_item_and_aggregates(patched_model):
    nodes = [
        _trigger(),
        FlowNode(
            id="loop",
            type=NodeType.LOOP,
            data=LoopData(
                split_mode="lines",
                prompt="do {{item}}",
                provider_id=str(uuid.uuid4()),
                model_id="m",
                join_with="numbered",
            ).model_dump(),
        ),
        _report("out"),
    ]
    edges = [FlowEdge(source="trigger", target="loop"), FlowEdge(source="loop", target="out")]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _s, usage, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
        trigger_payload="apple\n- banana\n3. cherry",
    )
    by = {n["node_id"]: n for n in node_runs}
    assert by["loop"]["label"] == "Loop (3 items)"
    # {{item}} injected per iteration; the fake model echoes each body prompt.
    assert "OUT[do apple]" in text
    assert "OUT[do banana]" in text
    assert "OUT[do cherry]" in text
    assert text.startswith("1. OUT[do apple]")  # numbered aggregation
    assert usage["completion_tokens"] == 6  # 2 per call × 3 items


async def test_loop_with_no_items_is_a_noop(patched_model):
    nodes = [
        _trigger(),
        FlowNode(
            id="loop",
            type=NodeType.LOOP,
            data=LoopData(prompt="do {{item}}", provider_id=str(uuid.uuid4()), model_id="m").model_dump(),
        ),
        _report("out"),
    ]
    edges = [FlowEdge(source="trigger", target="loop"), FlowEdge(source="loop", target="out")]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    _t, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
        trigger_payload="",  # nothing to iterate
    )
    by = {n["node_id"]: n for n in node_runs}
    assert by["loop"]["label"] == "Loop (0 items)"


async def test_merge_all_joins_parallel_branches(patched_model):
    # trigger fans out to a0 + a1; both feed a merge(all) → report.
    nodes = [
        _trigger(),
        _ai("a0", "x"),
        _ai("a1", "y"),
        FlowNode(
            id="m",
            type=NodeType.MERGE,
            data=MergeData(mode="all", separator="newline").model_dump(),
        ),
        _report("out"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="trigger", target="a1"),
        FlowEdge(source="a0", target="m"),
        FlowEdge(source="a1", target="m"),
        FlowEdge(source="m", target="out"),
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
    assert by["m"]["status"] == "success"
    assert by["m"]["output"] == "OUT[x]\nOUT[y]"  # newline-joined
    assert text == "OUT[x]\nOUT[y]"


async def test_merge_all_skips_when_a_branch_is_skipped(patched_model):
    # a0 → condition(false) → merge is one input; a1 → merge is the other.
    # In "all" mode the merge waits for both, so a skipped branch skips it.
    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(
            id="c",
            type=NodeType.CONDITION,
            data=ConditionData(operator="contains", value="ZZZ").model_dump(),
        ),
        _ai("a1", "y"),
        FlowNode(id="m", type=NodeType.MERGE, data=MergeData(mode="all").model_dump()),
        _report("out"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="c"),
        FlowEdge(source="trigger", target="a1"),
        FlowEdge(source="c", target="m", source_handle="true"),  # never fires
        FlowEdge(source="a1", target="m"),
        FlowEdge(source="m", target="out"),
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
    assert by["m"]["status"] == "skipped"
    assert by["out"]["status"] == "skipped"


async def test_merge_any_proceeds_with_available_branch(patched_model):
    # Same shape, but "any" mode → merge runs with just the active branch.
    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(
            id="c",
            type=NodeType.CONDITION,
            data=ConditionData(operator="contains", value="ZZZ").model_dump(),
        ),
        _ai("a1", "y"),
        FlowNode(id="m", type=NodeType.MERGE, data=MergeData(mode="any").model_dump()),
        _report("out"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="c"),
        FlowEdge(source="trigger", target="a1"),
        FlowEdge(source="c", target="m", source_handle="true"),
        FlowEdge(source="a1", target="m"),
        FlowEdge(source="m", target="out"),
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
    assert by["m"]["status"] == "success"
    assert by["m"]["output"] == "OUT[y]"  # only a1's branch was active


async def test_delay_passes_upstream_through(patched_model):
    nodes = [
        _trigger(),
        _ai("a0", "x"),
        FlowNode(id="d", type=NodeType.DELAY, data=DelayData(seconds=0).model_dump()),
        _report("out"),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="d"),
        FlowEdge(source="d", target="out"),
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
    assert by["d"]["label"] == "Delay 0s"
    assert text == "OUT[x]"  # delay is a pass-through


async def test_delay_caps_long_pauses(patched_model, monkeypatch):
    slept: list[float] = []

    async def fake_sleep(s):
        slept.append(s)

    monkeypatch.setattr(graph_runner.asyncio, "sleep", fake_sleep)
    nodes = [
        _trigger(),
        FlowNode(
            id="d", type=NodeType.DELAY, data=DelayData(seconds=999999).model_dump()
        ),
        _report("out"),
    ]
    edges = [FlowEdge(source="trigger", target="d"), FlowEdge(source="d", target="out")]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
        trigger_payload="hi",
    )
    assert slept == [600]  # capped at _DELAY_CAP_SECONDS


async def test_summarise_and_extract_presets_run(patched_model):
    nodes = [
        _trigger(),
        _ai("a0", "hello"),
        FlowNode(
            id="sum",
            type=NodeType.SUMMARISE,
            data=SummariseData(
                length="short", provider_id=str(uuid.uuid4()), model_id="m"
            ).model_dump(),
        ),
        FlowNode(
            id="ext",
            type=NodeType.EXTRACT,
            data=ExtractData(
                spec="name, date", provider_id=str(uuid.uuid4()), model_id="m"
            ).model_dump(),
        ),
        _report("out"),
    ]
    chain = ["trigger", "a0", "sum", "ext", "out"]
    edges = [FlowEdge(source=a, target=b) for a, b in zip(chain, chain[1:])]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _s, usage, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    by = {n["node_id"]: n for n in node_runs}
    assert by["sum"]["label"] == "Summarise" and by["sum"]["status"] == "success"
    assert by["ext"]["label"] == "Extract" and by["ext"]["status"] == "success"
    assert "OUT[" in text  # the presets ran through the (faked) model
    assert usage["completion_tokens"] == 6  # a0 + summarise + extract, 2 each


async def test_chat_message_output_posts_and_notes(patched_model, monkeypatch):
    posted = {}

    async def fake_post(db, *, task, data, text):
        posted["text"] = text
        posted["chat"] = data.chat_item_id
        return 'Posted to "Team chat".'

    monkeypatch.setattr(graph_runner, "_post_chat_message", fake_post)

    nodes = [
        _trigger(),
        _ai("a0", "hi"),
        FlowNode(
            id="chat",
            type=NodeType.OUTPUT_CHAT_MESSAGE,
            data=ChatMessageOutputData(chat_item_id="c1").model_dump(),
        ),
    ]
    edges = [
        FlowEdge(source="trigger", target="a0"),
        FlowEdge(source="a0", target="chat"),
    ]
    graph = FlowGraph(mode="advanced", nodes=nodes, edges=edges)
    text, _s, _u, node_runs = await run_graph_flow(
        task=_task(),
        graph=graph,
        user=object(),
        run_started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        db=None,
    )
    assert posted["text"] == "OUT[hi]"
    assert posted["chat"] == "c1"
    by = {n["node_id"]: n for n in node_runs}
    assert by["chat"]["label"] == "Send message"
    assert 'Posted to "Team chat".' in text  # note appended to the run report


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
