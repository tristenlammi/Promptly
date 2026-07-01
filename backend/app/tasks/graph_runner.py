"""Graph execution for Scheduled Tasks (Automations Phase 1).

Executes a Task's flow graph. The supported shape today is a linear chain
``trigger → ai(+) → output`` (:func:`app.tasks.flow_graph.is_linear_flow`) — one
or more AI steps in sequence, where each step's output can be injected into the
next via ``{{upstream_output}}`` (the Prompt-Injection node in its linear form).
A plain Simple task derives to a single-AI chain, so it runs through exactly
this path with identical behaviour. Branching, loops, and the wider node
catalogue are later phases.

All model/tool work is delegated to the existing :mod:`app.tasks.runner`
helpers, so the LLM behaviour is unchanged — this module only sequences the
nodes and wires their outputs together.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone as _tz

from sqlalchemy import func, select

from app.auth.models import User
from app.chat.models import WorkspaceItem, WorkspaceTask
from app.tasks.flow_graph import (
    AIPromptData,
    BoardCardOutputData,
    FlowGraph,
    NodeType,
    ScheduleTriggerData,
    is_linear_flow,
    ordered_ai_nodes,
    terminal_output_node,
)
from app.tasks.models import Task
from app.tasks.runner import (
    TaskRunError,
    _build_system_prompt,
    _generate,
    _resolve_connectors_by_ids,
    _resolve_provider,
)

logger = logging.getLogger("promptly.tasks.graph_runner")

# ``{{ var }}`` — literal, no-eval interpolation. Only whitelisted keys resolve;
# an unknown reference is left verbatim so a stray brace can never blow up a run
# (and there is no code execution path — just string substitution).
_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")


def _interpolate(template: str, context: dict[str, str]) -> str:
    return _VAR_RE.sub(
        lambda m: context.get(m.group(1), m.group(0)), template
    )


def _first_line_title(text: str) -> str:
    """The card title: first non-empty line of the AI output, markup-stripped."""
    for raw in text.splitlines():
        line = raw.strip().lstrip("#").strip()
        if line:
            return line[:200]
    return "Automation result"


async def _file_board_card(
    db, *, task: Task, data: BoardCardOutputData, text: str
) -> str:
    """Workspace-output: create a card on the target board from the AI result.
    Returns a one-line note to append to the run report."""
    if task.workspace_id is None:
        raise TaskRunError(
            "This automation isn't in a workspace, so it can't file a board card."
        )
    if not data.board_item_id:
        raise TaskRunError("The board-card step has no board selected.")
    board_id = uuid.UUID(data.board_item_id)
    board = await db.get(WorkspaceItem, board_id)
    if (
        board is None
        or board.kind != "board"
        or board.workspace_id != task.workspace_id
    ):
        raise TaskRunError(
            "The board this automation writes to no longer exists in its "
            "workspace."
        )
    max_pos = await db.scalar(
        select(func.max(WorkspaceTask.position)).where(
            WorkspaceTask.workspace_id == task.workspace_id
        )
    )
    card = WorkspaceTask(
        workspace_id=task.workspace_id,
        board_item_id=board_id,
        title=_first_line_title(text),
        description=text,
        status=data.column or "todo",
        priority=data.priority or "medium",
        position=float(max_pos or 0.0) + 1.0,
        created_by=task.user_id,
    )
    db.add(card)
    await db.commit()
    # Keep the board's RAG text fresh (best-effort; owns its own session).
    try:
        from app.workspaces.knowledge import index_board_for_workspace

        await index_board_for_workspace(task.workspace_id, board_id)
    except Exception:  # noqa: BLE001 — reindex must never fail the run
        logger.warning("board reindex after card creation failed", exc_info=True)
    return f'Filed as a card on "{board.title or "board"}".'


def _flow_timezone(graph: FlowGraph, task: Task) -> str:
    """The schedule trigger's timezone, falling back to the task's."""
    for n in graph.nodes:
        if n.type == NodeType.TRIGGER_SCHEDULE:
            try:
                return ScheduleTriggerData.model_validate(n.data).timezone
            except Exception:  # noqa: BLE001 - malformed data → task default
                break
    return task.timezone


async def run_graph_flow(
    *,
    task: Task,
    graph: FlowGraph,
    user: User,
    run_started_at: datetime,
    trigger_payload: str | None = None,
    db,
) -> tuple[str, list[dict], dict]:
    """Execute a linear flow graph → ``(report_markdown, sources, usage)``.

    Each AI node resolves its own model + connectors, runs the shared tool
    loop, and its text becomes ``{{upstream_output}}`` for the next node. The
    final AI node's text is the run report; usage + sources accumulate across
    the chain.
    """
    if not is_linear_flow(graph):
        raise TaskRunError(
            "This flow isn't a supported shape yet — Advanced flows currently "
            "run as a linear chain of AI steps (branching and loops are coming)."
        )
    ai_nodes = ordered_ai_nodes(graph)
    if not ai_nodes:
        raise TaskRunError("This flow has no AI step to run.")

    tz = _flow_timezone(graph, task)
    now_local = run_started_at.astimezone(_tz.utc).isoformat(timespec="minutes")

    upstream = ""
    sources: list[dict] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}

    for node in ai_nodes:
        data = AIPromptData.model_validate(node.data)
        provider, model_id = await _resolve_provider(
            uuid.UUID(data.provider_id) if data.provider_id else None,
            data.model_id,
            db,
        )
        schemas, dispatch, names = await _resolve_connectors_by_ids(
            db,
            user_id=task.user_id,
            workspace_id=task.workspace_id,
            connector_ids=[uuid.UUID(c) for c in data.connector_ids],
        )
        system = _build_system_prompt(
            timezone=tz,
            use_web_search=data.use_web_search,
            now_local_iso=now_local,
            connector_names=names,
        )
        prompt = _interpolate(
            data.prompt,
            {"upstream_output": upstream, "trigger.payload": trigger_payload or ""},
        )
        text, node_sources, node_usage = await _generate(
            provider=provider,
            model_id=model_id,
            system=system,
            prompt=prompt,
            user=user,
            use_web_search=data.use_web_search,
            reasoning_effort=data.reasoning_effort,
            mcp_schemas=schemas,
            mcp_dispatch=dispatch,
            db=db,
        )
        upstream = text
        sources.extend(node_sources)
        if node_usage.get("prompt_tokens"):
            usage["prompt_tokens"] += node_usage["prompt_tokens"]
        if node_usage.get("completion_tokens"):
            usage["completion_tokens"] += node_usage["completion_tokens"]
        if node_usage.get("cost_usd") is not None:
            usage["cost_usd"] = (usage["cost_usd"] or 0.0) + node_usage["cost_usd"]

    # Terminal output node: a plain report, or a workspace-output action that
    # consumes the final AI text (the run still records that text as its
    # report so history stays readable).
    report = upstream
    out_node = terminal_output_node(graph)
    if out_node is not None and out_node.type == NodeType.OUTPUT_BOARD_CARD:
        note = await _file_board_card(
            db,
            task=task,
            data=BoardCardOutputData.model_validate(out_node.data),
            text=upstream,
        )
        report = f"{upstream}\n\n---\n\n*{note}*"

    # De-dup sources by URL across the whole chain, preserving order.
    seen: set[str] = set()
    deduped: list[dict] = []
    for s in sources:
        url = s.get("url")
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        deduped.append(s)

    return report, deduped, usage


__all__ = ["run_graph_flow", "_interpolate"]
