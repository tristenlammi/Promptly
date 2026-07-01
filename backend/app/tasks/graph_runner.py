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

import json
import logging
import re
import uuid
from datetime import datetime, timezone as _tz

from sqlalchemy import func, select
from sqlalchemy.orm.attributes import flag_modified

from app.auth.models import User
from app.chat.models import WorkspaceItem, WorkspaceTask
from app.tasks.flow_graph import (
    AIPromptData,
    BoardCardOutputData,
    FetchPageData,
    FlowGraph,
    FlowNode,
    NodeType,
    ScheduleTriggerData,
    WebSearchData,
    is_linear_flow,
    ordered_flow_nodes,
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
# (and there is no code execution path — just string substitution). Hyphens are
# allowed so React-Flow node ids (``ai_ab12``, ``node-3``) resolve in
# ``{{node_<id>.output}}`` references.
_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}")


def _interpolate(template: str, context: dict[str, str]) -> str:
    return _VAR_RE.sub(
        lambda m: context.get(m.group(1), m.group(0)), template
    )


def _step_context(
    *, upstream: str, trigger_payload: str, now_local: str, outputs: dict[str, str]
) -> dict[str, str]:
    """The variable context a node's templates resolve against: the immediate
    upstream text, the trigger payload/timestamp, and every completed node's
    output as ``node_<id>.output``."""
    ctx = {
        "upstream_output": upstream,
        "trigger.payload": trigger_payload,
        "trigger.timestamp": now_local,
    }
    for nid, txt in outputs.items():
        ctx[f"node_{nid}.output"] = txt
    return ctx


# Empty usage record shared by non-AI steps (they don't spend model tokens).
def _empty_usage() -> dict:
    return {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}


# First http(s) URL in a blob of text — how Fetch Page finds its target when
# fed the output of a Web Search step.
_URL_IN_TEXT_RE = re.compile(r"https?://[^\s<>\"'\)\]]+")


async def _run_search_node(
    node: FlowNode,
    ctx: dict[str, str],
    *,
    db,
    user: User,
) -> tuple[str, list[dict], dict]:
    """Execute a ``search.web`` node → (text, sources, record). Queries the
    configured search provider (SearXNG et al.) and renders numbered hits the
    next node can read."""
    from app.search.providers import SearchError, run_search
    from app.search.service import pick_search_provider

    data = WebSearchData.model_validate(node.data)
    query = (
        _interpolate(data.query, ctx).strip()
        if data.query.strip()
        else ctx.get("upstream_output", "").strip()
    )
    query = query[:400]
    if not query:
        raise TaskRunError(
            "The web-search step has no query and no upstream text to search for."
        )
    provider = await pick_search_provider(db, user)
    if provider is None:
        raise TaskRunError(
            "No web-search provider is configured — add one in Search settings."
        )
    count = max(1, min(20, data.count or 5))
    try:
        results = await run_search(provider, query, count)
    except SearchError as e:
        raise TaskRunError(f"Web search failed: {e}") from e

    lines: list[str] = []
    sources: list[dict] = []
    for i, r in enumerate(results, 1):
        snippet = (r.snippet or "").strip()
        block = f"[{i}] {r.title}\n{r.url}"
        if snippet:
            block += f"\n{snippet}"
        lines.append(block)
        sources.append({"title": r.title, "url": r.url, "snippet": snippet})
    body = "\n\n".join(lines) if lines else "(no results)"
    text = f'Web search results for "{query}":\n\n{body}'
    record = {
        "node_id": node.id,
        "type": NodeType.SEARCH_WEB,
        "label": "Web search",
        "status": "success",
        "output": text,
    }
    return text, sources, record


async def _run_fetch_node(
    node: FlowNode, ctx: dict[str, str]
) -> tuple[str, list[dict], dict]:
    """Execute a ``fetch.page`` node → (text, sources, record). Fetches a URL
    (SSRF-guarded) and extracts its readable main text via trafilatura."""
    import httpx
    import trafilatura

    from app.net.safe_fetch import UnsafeURLError, safe_fetch

    data = FetchPageData.model_validate(node.data)
    raw = (
        _interpolate(data.url, ctx).strip()
        if data.url.strip()
        else ctx.get("upstream_output", "")
    )
    m = _URL_IN_TEXT_RE.search(raw)
    if not m:
        raise TaskRunError(
            "The fetch step has no URL — none was configured and none was found "
            "in the upstream text."
        )
    url = m.group(0)
    try:
        resp = await safe_fetch("GET", url)
        resp.raise_for_status()
    except UnsafeURLError as e:
        raise TaskRunError(f"Refused to fetch an unsafe URL ({url}).") from e
    except httpx.HTTPError as e:
        raise TaskRunError(f"Couldn't fetch {url}: {type(e).__name__}.") from e

    extracted = (trafilatura.extract(resp.text) or "").strip()
    if not extracted:
        # trafilatura found no article body — fall back to a tag strip so the
        # step still yields *something* usable downstream.
        from bs4 import BeautifulSoup

        extracted = BeautifulSoup(resp.text, "html.parser").get_text(
            " ", strip=True
        )
    cap = max(500, min(50000, data.max_chars or 8000))
    extracted = extracted[:cap]
    text = f"Fetched {url}:\n\n{extracted}" if extracted else f"Fetched {url} (no readable text)."
    record = {
        "node_id": node.id,
        "type": NodeType.FETCH_PAGE,
        "label": "Fetch page",
        "status": "success",
        "output": text,
    }
    return text, [{"title": url, "url": url, "snippet": ""}], record


def _first_line_title(text: str) -> str:
    """The card title: first non-empty line of the AI output, markup-stripped."""
    for raw in text.splitlines():
        line = raw.strip().lstrip("#").strip()
        if line:
            return line[:200]
    return "Automation result"


# Palette matching the board's label picker (WorkspaceBoardCardDetail).
_LABEL_COLORS = [
    "#ef4444", "#f59e0b", "#eab308", "#22c55e", "#14b8a6",
    "#3b82f6", "#8b5cf6", "#ec4899", "#64748b",
]


def _parse_card_spec(text: str) -> dict | None:
    """Parse the AI's JSON card spec (tolerating ```code fences```). Returns
    ``None`` when the output isn't a JSON object, so the caller can fall back to
    treating the whole text as title + description."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t.strip())
    try:
        obj = json.loads(t)
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _parse_due(val) -> datetime | None:
    """Parse an AI-supplied due date (``YYYY-MM-DD`` or full ISO) to an aware
    UTC datetime. Returns ``None`` on anything unparseable."""
    if not isinstance(val, str) or not val.strip():
        return None
    try:
        dt = datetime.fromisoformat(val.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.replace(tzinfo=_tz.utc) if dt.tzinfo is None else dt


def _resolve_labels(board: WorkspaceItem, names: list[str]) -> list[str]:
    """Map label names to the board's label ids, creating any that don't exist
    (mutating ``board.config.labels``). Returns the resolved label ids."""
    cfg = dict(board.config) if isinstance(board.config, dict) else {}
    labels = list(cfg.get("labels") or [])
    by_name = {
        str(l.get("name", "")).strip().lower(): l
        for l in labels
        if isinstance(l, dict)
    }
    ids: list[str] = []
    changed = False
    for raw in names:
        name = str(raw).strip()[:50]
        if not name:
            continue
        existing = by_name.get(name.lower())
        if existing and existing.get("id"):
            ids.append(str(existing["id"]))
            continue
        new = {
            "id": "l_" + uuid.uuid4().hex[:7],
            "name": name,
            "color": _LABEL_COLORS[len(labels) % len(_LABEL_COLORS)],
        }
        labels.append(new)
        by_name[name.lower()] = new
        ids.append(new["id"])
        changed = True
    if changed:
        cfg["labels"] = labels
        board.config = cfg
        flag_modified(board, "config")
    return ids


async def _file_board_card(
    db, *, task: Task, data: BoardCardOutputData, text: str
) -> str:
    """Workspace-output: create a card on the target board from the AI result.

    The AI step emits a JSON card spec (title/description/priority/due_date/
    labels/links/checklist); we map it onto a full ``WorkspaceTask``. Falls back
    to title = first line / description = body if the output isn't JSON. Returns
    a one-line note for the run report."""
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

    spec = _parse_card_spec(text) or {}
    if spec.get("title"):
        title = str(spec["title"]).strip()[:200] or _first_line_title(text)
        description = (str(spec.get("description") or "").strip()) or None
    else:
        title = _first_line_title(text)
        description = text

    priority = (
        spec["priority"]
        if spec.get("priority") in ("low", "medium", "high")
        else (data.priority or "medium")
    )
    due_at = _parse_due(spec.get("due_date"))

    subtasks = None
    cl = spec.get("checklist")
    if isinstance(cl, list):
        subtasks = [
            {"id": "s_" + uuid.uuid4().hex[:7], "text": str(s).strip()[:500], "done": False}
            for s in cl
            if str(s).strip()
        ][:50] or None

    links = None
    lk = spec.get("links")
    if isinstance(lk, list):
        built = []
        for l in lk:
            if not isinstance(l, dict):
                continue
            url = str(l.get("url") or "").strip()
            if not url:
                continue
            built.append(
                {
                    "item_id": "url_" + uuid.uuid4().hex[:7],
                    "kind": "url",
                    "ref_id": None,
                    "title": (str(l.get("title") or url).strip())[:200],
                    "url": url[:2000],
                }
            )
        links = built or None

    label_ids = None
    lb = spec.get("labels")
    if isinstance(lb, list) and lb:
        label_ids = _resolve_labels(board, [str(x) for x in lb]) or None

    max_pos = await db.scalar(
        select(func.max(WorkspaceTask.position)).where(
            WorkspaceTask.workspace_id == task.workspace_id
        )
    )
    card = WorkspaceTask(
        workspace_id=task.workspace_id,
        board_item_id=board_id,
        title=title,
        description=description,
        status=data.column or "todo",
        priority=priority,
        subtasks=subtasks,
        labels=label_ids,
        links=links,
        due_at=due_at,
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

    extras = []
    if due_at:
        extras.append("due " + due_at.date().isoformat())
    if label_ids:
        extras.append(f"{len(label_ids)} label(s)")
    if subtasks:
        extras.append(f"{len(subtasks)}-item checklist")
    if links:
        extras.append(f"{len(links)} link(s)")
    suffix = f" ({', '.join(extras)})" if extras else ""
    return f'Filed "{title}" on "{board.title or "board"}"{suffix}.'


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
            "run as a linear chain of steps (branching and loops are coming)."
        )
    flow_nodes = ordered_flow_nodes(graph)
    if not flow_nodes:
        raise TaskRunError("This flow has no step to run.")

    tz = _flow_timezone(graph, task)
    now_local = run_started_at.astimezone(_tz.utc).isoformat(timespec="minutes")

    # The terminal output decides how the *last AI* step should shape its
    # result (a report vs. a board card) — earlier steps are intermediate.
    out_node = terminal_output_node(graph)
    terminal_kind = (
        "board_card"
        if out_node is not None and out_node.type == NodeType.OUTPUT_BOARD_CARD
        else "report"
    )

    upstream = ""
    outputs: dict[str, str] = {}  # node_id → its text output (for {{node_x.output}})
    sources: list[dict] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}
    # Per-node record for the run inspector.
    node_runs: list[dict] = []
    ai_count = sum(1 for n in flow_nodes if n.type == NodeType.AI_PROMPT)
    ai_seen = 0

    for i, node in enumerate(flow_nodes):
        is_last = i == len(flow_nodes) - 1
        ctx = _step_context(
            upstream=upstream,
            trigger_payload=trigger_payload or "",
            now_local=now_local,
            outputs=outputs,
        )

        if node.type == NodeType.SEARCH_WEB:
            text, node_sources, record = await _run_search_node(
                node, ctx, db=db, user=user
            )
            sources.extend(node_sources)
            node_runs.append(record)
        elif node.type == NodeType.FETCH_PAGE:
            text, node_sources, record = await _run_fetch_node(node, ctx)
            sources.extend(node_sources)
            node_runs.append(record)
        else:  # NodeType.AI_PROMPT
            ai_seen += 1
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
                output_kind=terminal_kind if is_last else "step",
            )
            # Blank prompt → default to consuming the upstream text, so an AI
            # step dropped after a search/fetch "just works" without config.
            prompt = _interpolate(
                data.prompt.strip() or "{{upstream_output}}", ctx
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
            sources.extend(node_sources)
            if node_usage.get("prompt_tokens"):
                usage["prompt_tokens"] += node_usage["prompt_tokens"]
            if node_usage.get("completion_tokens"):
                usage["completion_tokens"] += node_usage["completion_tokens"]
            if node_usage.get("cost_usd") is not None:
                usage["cost_usd"] = (usage["cost_usd"] or 0.0) + node_usage[
                    "cost_usd"
                ]
            node_runs.append(
                {
                    "node_id": node.id,
                    "type": NodeType.AI_PROMPT,
                    "label": f"AI step {ai_seen}" if ai_count > 1 else "AI step",
                    "status": "success",
                    "output": text,
                    "prompt_tokens": node_usage.get("prompt_tokens") or None,
                    "completion_tokens": node_usage.get("completion_tokens") or None,
                }
            )

        upstream = text
        outputs[node.id] = text

    # Terminal output node: a plain report, or a workspace-output action that
    # consumes the final AI text (the run still records that text as its
    # report so history stays readable).
    report = upstream
    if out_node is not None and out_node.type == NodeType.OUTPUT_BOARD_CARD:
        note = await _file_board_card(
            db,
            task=task,
            data=BoardCardOutputData.model_validate(out_node.data),
            text=upstream,
        )
        report = f"{upstream}\n\n---\n\n*{note}*"
        node_runs.append(
            {
                "node_id": out_node.id,
                "type": out_node.type,
                "label": "Create card",
                "status": "success",
                "output": note,
            }
        )
    elif out_node is not None:
        node_runs.append(
            {
                "node_id": out_node.id,
                "type": out_node.type,
                "label": "Report",
                "status": "success",
                "output": "Saved as the run report.",
            }
        )

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

    return report, deduped, usage, node_runs


__all__ = ["run_graph_flow", "_interpolate"]
