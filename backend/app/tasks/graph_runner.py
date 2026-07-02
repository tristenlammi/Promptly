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

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone as _tz

from sqlalchemy import func, select
from sqlalchemy.orm.attributes import flag_modified

from app.auth.models import User
from app.chat.models import (
    Conversation,
    Message,
    Spreadsheet,
    Workspace,
    WorkspaceItem,
    WorkspaceTask,
)
from app.tasks.flow_graph import (
    AIPromptData,
    BoardCardOutputData,
    ChatMessageOutputData,
    ConditionData,
    CONTROL_TYPES,
    DeepResearchData,
    ExtractData,
    FetchPageData,
    FlowGraph,
    FlowNode,
    LoopData,
    MemoryData,
    MergeData,
    DelayData,
    NodeType,
    NoteOutputData,
    OUTPUT_TYPES,
    RouterData,
    ScheduleTriggerData,
    SheetOutputData,
    SummariseData,
    WebSearchData,
    ancestors_of,
    is_executable_graph,
    topological_order,
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

# A Delay node caps its pause here so a long sleep can't tie up a worker slot.
# Longer waits belong to a future durable-reschedule mechanism, not a blocking
# sleep inside the run.
_DELAY_CAP_SECONDS = 600

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


def _try_json(text: str):
    """Parse ``text`` as JSON (tolerating a ```code fence```); returns a dict/list
    or None. Lets any node that emits JSON expose fields as ``{{...json.path}}``."""
    t = (text or "").strip()
    if not t:
        return None
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t.strip())
    if not (t.startswith("{") or t.startswith("[")):
        return None
    try:
        obj = json.loads(t)
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, (dict, list)) else None


def _flatten_json(obj, prefix: str, out: dict[str, str], depth: int = 0) -> None:
    """Flatten a JSON value into ``prefix.path`` → string leaves so templates can
    reference fields: ``{{json.status}}``, ``{{json.items.0.name}}``. Bounded so a
    huge object can't explode the context."""
    if len(out) > 400 or depth > 6:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            _flatten_json(v, f"{prefix}.{k}", out, depth + 1)
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:50]):
            _flatten_json(v, f"{prefix}.{i}", out, depth + 1)
    else:
        out[prefix] = "" if obj is None else str(obj)


def _json_dumps(obj) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        return ""


def _step_context(
    *,
    upstream: str,
    trigger_payload: str,
    now_local: str,
    outputs: dict[str, str],
    structured: dict | None = None,
    upstream_struct=None,
) -> dict[str, str]:
    """The variable context a node's templates resolve against: the immediate
    upstream text, trigger payload/timestamp, run date/time, every completed
    node's ``node_<id>.output`` — and, when a node emitted JSON, its fields via
    ``{{json.path}}`` (immediate upstream) and ``{{node_<id>.json.path}}``."""
    ctx = {
        "upstream_output": upstream,
        "trigger.payload": trigger_payload,
        "trigger.timestamp": now_local,
        # Run-time date/time (from the schedule's timezone) for templated titles.
        "datetime": now_local,
        "date": now_local[:10],
        "time": now_local[11:16] if len(now_local) >= 16 else "",
    }
    for nid, txt in outputs.items():
        ctx[f"node_{nid}.output"] = txt
    # Structured (JSON) field access.
    if upstream_struct is not None:
        ctx["json"] = _json_dumps(upstream_struct)
        _flatten_json(upstream_struct, "json", ctx)
    for nid, val in (structured or {}).items():
        if val is not None:
            ctx[f"node_{nid}.json"] = _json_dumps(val)
            _flatten_json(val, f"node_{nid}.json", ctx)
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


_LIST_MARKER_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")


def _split_items(upstream: str, mode: str, cap: int) -> list[str]:
    """Break the upstream text into loop items. ``json`` parses a JSON array
    (objects re-serialised); anything else — or a failed parse — splits on
    non-empty lines with leading bullet/number markers stripped."""
    if mode == "json":
        try:
            data = json.loads(upstream.strip())
        except (json.JSONDecodeError, ValueError):
            data = None
        if isinstance(data, list):
            items = [
                x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)
                for x in data
            ]
            return [i for i in items if str(i).strip()][:cap]
        # not a JSON list → fall through to line splitting
    lines: list[str] = []
    for raw in upstream.splitlines():
        line = _LIST_MARKER_RE.sub("", raw.strip())
        if line:
            lines.append(line)
    return lines[:cap]


async def _run_loop_node(
    node: FlowNode,
    ctx: dict[str, str],
    *,
    db,
    user: User,
    task: Task,
    tz: str,
    now_local: str,
) -> tuple[str, list[dict], dict, dict]:
    """Map an AI body over each upstream item → (text, sources, usage, record).
    Items run sequentially (they share the request's DB session, which isn't
    safe to use concurrently)."""
    data = LoopData.model_validate(node.data)
    upstream = ctx.get("upstream_output", "")
    cap = max(1, min(50, data.max_items or 10))
    items = _split_items(upstream, data.split_mode, cap)

    usage = _empty_usage()
    if not items:
        record = {
            "node_id": node.id,
            "type": NodeType.LOOP,
            "label": "Loop (0 items)",
            "status": "success",
            "output": "",
        }
        return "", [], usage, record

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
        output_kind="step",
    )

    results: list[str] = []
    sources: list[dict] = []
    for idx, item in enumerate(items, 1):
        item_ctx = dict(ctx)
        item_ctx["item"] = item
        item_ctx["item_index"] = str(idx)
        # If the item is a JSON object, expose its fields as {{item.field}}.
        item_struct = _try_json(item)
        if item_struct is not None:
            _flatten_json(item_struct, "item", item_ctx)
        prompt = _interpolate(data.prompt.strip() or "{{item}}", item_ctx)
        text, item_sources, item_usage = await _generate(
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
        results.append(text)
        sources.extend(item_sources)
        if item_usage.get("prompt_tokens"):
            usage["prompt_tokens"] += item_usage["prompt_tokens"]
        if item_usage.get("completion_tokens"):
            usage["completion_tokens"] += item_usage["completion_tokens"]
        if item_usage.get("cost_usd") is not None:
            usage["cost_usd"] = (usage["cost_usd"] or 0.0) + item_usage["cost_usd"]

    if data.join_with == "numbered":
        aggregated = "\n\n".join(f"{i}. {r}" for i, r in enumerate(results, 1))
    else:
        aggregated = "\n\n".join(results)

    record = {
        "node_id": node.id,
        "type": NodeType.LOOP,
        "label": f"Loop ({len(items)} items)",
        "status": "success",
        "output": aggregated,
        "prompt_tokens": usage.get("prompt_tokens") or None,
        "completion_tokens": usage.get("completion_tokens") or None,
    }
    return aggregated, sources, usage, record


async def _run_memory_node(
    node: FlowNode,
    ctx: dict[str, str],
    *,
    db,
    task: Task,
    now_local: str,
    dry_run: bool = False,
) -> tuple[str, dict]:
    """A Memory node → (text, record). Captures the upstream output; when the
    node is set to *remember*, also persists it across runs (keeping the last
    ``max_runs`` values) and emits the current value plus the recent history."""
    from sqlalchemy import select as _select

    from app.tasks.models import AutomationNodeMemory

    data = MemoryData.model_validate(node.data)
    current = ctx.get("upstream_output", "")
    name = (data.name or "Memory").strip() or "Memory"

    if not data.remember:
        # Within-run sticky note: relay the captured value (labelled so that a
        # downstream node merging several memories can tell them apart).
        text = f"[{name}]\n{current}" if current else f"[{name}] (empty)"
        record = {
            "node_id": node.id,
            "type": NodeType.MEMORY,
            "label": f"Memory: {name}",
            "status": "success",
            "output": current,
        }
        return text, record

    cap = max(1, min(50, data.max_runs or 5))
    row = (
        await db.execute(
            _select(AutomationNodeMemory).where(
                AutomationNodeMemory.task_id == task.id,
                AutomationNodeMemory.node_id == node.id,
            )
        )
    ).scalar_one_or_none()
    prev = list(row.entries) if row and row.entries else []

    parts = [f"[{name}] current run:\n{current or '(empty)'}"]
    recent = list(reversed(prev))[: cap - 1] if cap > 1 else []
    if recent:
        parts.append(f"[{name}] previous {len(recent)} run(s), newest first:")
        for e in recent:
            parts.append(f"(run {e.get('at', '?')})\n{e.get('value', '')}")
    text = "\n\n".join(parts)

    if not dry_run:
        new_entries = (prev + [{"value": current, "at": now_local}])[-cap:]
        if row is not None:
            row.entries = new_entries
            flag_modified(row, "entries")
        else:
            db.add(
                AutomationNodeMemory(
                    task_id=task.id, node_id=node.id, entries=new_entries
                )
            )
        await db.commit()  # persist now, even if a later step fails

    record = {
        "node_id": node.id,
        "type": NodeType.MEMORY,
        "label": f"Memory: {name} ({len(new_entries)} kept)",
        "status": "success",
        "output": text,
    }
    return text, record


_SUMMARY_LENGTH = {
    "short": "1-2 sentences",
    "medium": "a short paragraph",
    "detailed": "a few concise paragraphs",
}


async def _run_summarise_node(
    node: FlowNode, ctx: dict[str, str], *, db, user: User, tz: str, now_local: str
) -> tuple[str, list[dict], dict, dict]:
    """Preset AI step: summarise the upstream text → (text, sources, usage, record)."""
    data = SummariseData.model_validate(node.data)
    provider, model_id = await _resolve_provider(
        uuid.UUID(data.provider_id) if data.provider_id else None,
        data.model_id,
        db,
    )
    length = _SUMMARY_LENGTH.get(data.length, "a short paragraph")
    system = (
        "You are a summariser running inside an automation, with no human "
        "watching. Produce ONLY a clear, faithful summary of the text below — "
        f"about {length}. No preamble ('Here is'), no sign-off, no meta "
        f"commentary. The current date/time is {now_local} ({tz})."
    )
    prompt = ctx.get("upstream_output", "") or "(no input text)"
    text, sources, usage = await _generate(
        provider=provider,
        model_id=model_id,
        system=system,
        prompt=prompt,
        user=user,
        use_web_search=False,
        reasoning_effort=data.reasoning_effort,
        mcp_schemas=[],
        mcp_dispatch={},
        db=db,
    )
    record = {
        "node_id": node.id,
        "type": NodeType.SUMMARISE,
        "label": "Summarise",
        "status": "success",
        "output": text,
        "prompt_tokens": usage.get("prompt_tokens") or None,
        "completion_tokens": usage.get("completion_tokens") or None,
    }
    return text, sources, usage, record


async def _run_extract_node(
    node: FlowNode, ctx: dict[str, str], *, db, user: User, tz: str, now_local: str
) -> tuple[str, list[dict], dict, dict]:
    """Preset AI step: extract structured JSON from the upstream text."""
    data = ExtractData.model_validate(node.data)
    provider, model_id = await _resolve_provider(
        uuid.UUID(data.provider_id) if data.provider_id else None,
        data.model_id,
        db,
    )
    spec = data.spec.strip() or "the key fields present in the text"
    system = (
        "You extract structured data from text inside an automation. Return "
        "ONLY a single valid JSON object — no markdown, no code fences, no prose "
        "around it — with fields matching this spec:\n"
        f"{spec}\n"
        "Use null for anything the text doesn't provide; never invent values. "
        f"The current date/time is {now_local} ({tz})."
    )
    prompt = ctx.get("upstream_output", "") or "(no input text)"
    text, sources, usage = await _generate(
        provider=provider,
        model_id=model_id,
        system=system,
        prompt=prompt,
        user=user,
        use_web_search=False,
        reasoning_effort=data.reasoning_effort,
        mcp_schemas=[],
        mcp_dispatch={},
        db=db,
    )
    record = {
        "node_id": node.id,
        "type": NodeType.EXTRACT,
        "label": "Extract",
        "status": "success",
        "output": text,
        "prompt_tokens": usage.get("prompt_tokens") or None,
        "completion_tokens": usage.get("completion_tokens") or None,
    }
    return text, sources, usage, record


async def _post_chat_message(
    db, *, task: Task, data: ChatMessageOutputData, text: str
) -> str:
    """Workspace-output: post the result as an assistant message in a workspace
    chat. Appends to the chat's active thread so it shows up immediately."""
    if task.workspace_id is None:
        raise TaskRunError(
            "This automation isn't in a workspace, so it can't post to a chat."
        )
    if not data.chat_item_id:
        raise TaskRunError("The send-message step has no chat selected.")
    picked = uuid.UUID(data.chat_item_id)
    # The picker's id is either a notebook chat *page* (a ``kind='chat'``
    # WorkspaceItem whose ``ref_id`` is the conversation) or a top-level
    # workspace chat, which is synthesised straight from a Conversation and has
    # no item row — so its id IS the conversation id. Resolve both.
    item = await db.get(WorkspaceItem, picked)
    conv: Conversation | None
    title: str | None
    if item is not None and item.kind == "chat":
        if item.workspace_id != task.workspace_id:
            raise TaskRunError(
                "The chat this automation posts to is in a different workspace."
            )
        conv = await db.get(Conversation, item.ref_id)
        title = item.title
    else:
        conv = await db.get(Conversation, picked)
        title = conv.title if conv is not None else None
    if conv is None or conv.workspace_id != task.workspace_id:
        raise TaskRunError(
            "The chat this automation posts to no longer exists in its workspace."
        )
    msg = Message(
        conversation_id=conv.id,
        parent_id=conv.active_leaf_message_id,
        role="assistant",
        content=text or "(empty automation result)",
    )
    db.add(msg)
    await db.flush()  # assign msg.id before pointing the thread leaf at it
    conv.active_leaf_message_id = msg.id
    await db.commit()
    return f'Posted to "{title or "chat"}".'


async def _resolve_workspace_and_folder(
    db, *, task: Task, folder_item_id: str | None
) -> tuple[Workspace, User, uuid.UUID | None]:
    """Shared setup for note/sheet outputs: the workspace, its owner (whose
    Drive backs notes), and the validated target-folder item id (or None)."""
    if task.workspace_id is None:
        raise TaskRunError(
            "This automation isn't in a workspace, so it can't create items."
        )
    ws = await db.get(Workspace, task.workspace_id)
    if ws is None:
        raise TaskRunError("This automation's workspace no longer exists.")
    owner = await db.get(User, ws.user_id)
    if owner is None:
        raise TaskRunError("The workspace owner is missing.")
    parent_id: uuid.UUID | None = None
    if folder_item_id:
        folder = await db.get(WorkspaceItem, uuid.UUID(folder_item_id))
        if folder is None or folder.kind != "folder" or folder.workspace_id != ws.id:
            raise TaskRunError(
                "The folder this automation files into no longer exists in its "
                "workspace."
            )
        parent_id = folder.id
    return ws, owner, parent_id


async def _write_note(db, *, task: Task, data: NoteOutputData, text: str) -> str:
    """Workspace-output: create a new note from the Markdown result."""
    from app.files.document_build import markdown_to_doc_update
    from app.files.document_render import (
        extract_text_from_html,
        render_html_from_update,
    )
    from app.files.documents_router import create_blank_document
    from app.files.models import DocumentState
    from app.files.storage import absolute_path
    from app.workspaces.items_router import _next_position, _resolve_subfolder_id

    ws, owner, parent_id = await _resolve_workspace_and_folder(
        db, task=task, folder_item_id=data.folder_item_id
    )
    title = (data.title.strip() and _first_line_title(data.title.strip())) or (
        _first_line_title(text)
    )

    notes_folder_id = await _resolve_subfolder_id(db, ws, owner, "Notes")
    doc = await create_blank_document(
        db, owner_id=owner.id, folder_id=notes_folder_id, name=title
    )
    # Seed the Y.Doc so the note opens already populated, and mirror it onto the
    # HTML blob + content_text (preview / download / RAG) like a normal save.
    update = markdown_to_doc_update(text)
    ds = await db.get(DocumentState, doc.id)
    if ds is not None:
        ds.yjs_update = update
        ds.version = (ds.version or 0) + 1
    html = render_html_from_update(update)
    doc.content_text = extract_text_from_html(html) or None
    try:
        with open(absolute_path(doc.storage_path), "w", encoding="utf-8") as f:
            f.write(html)
        doc.size_bytes = len(html.encode("utf-8"))
    except OSError:
        logger.warning("note blob write failed", exc_info=True)

    pos = await _next_position(db, ws.id, parent_id)
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=parent_id,
        kind="note",
        ref_id=doc.id,
        title=title,
        position=pos,
        indexing_status="queued",
    )
    db.add(item)
    await db.commit()

    try:
        from app.workspaces.knowledge import index_note_for_workspace

        await index_note_for_workspace(ws.id, item.id)
    except Exception:  # noqa: BLE001 — indexing must never fail the run
        logger.warning("note index after creation failed", exc_info=True)
    return f'Created note "{title}".'


def _rows_from_text(text: str) -> list[list[str]]:
    """Best-effort parse of the upstream text into a grid of rows — a JSON array
    (of objects → header + values, of arrays, or of scalars), a Markdown table,
    or CSV/TSV lines."""
    t = text.strip()
    try:
        parsed = json.loads(t)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    if isinstance(parsed, list) and parsed:
        if isinstance(parsed[0], dict):
            headers: list[str] = []
            for row in parsed:
                for k in row.keys():
                    if k not in headers:
                        headers.append(str(k))
            out = [headers]
            for row in parsed:
                out.append([_cell(row.get(h, "")) for h in headers])
            return out
        if isinstance(parsed[0], list):
            return [[_cell(c) for c in row] for row in parsed]
        return [[_cell(x)] for x in parsed]

    lines = [ln for ln in t.splitlines() if ln.strip()]
    # Markdown table (first couple of lines contain pipes).
    if len(lines) >= 2 and all("|" in ln for ln in lines[:2]):
        rows: list[list[str]] = []
        for ln in lines:
            if set(ln.strip()) <= set("|-: "):
                continue  # separator row
            rows.append([c.strip() for c in ln.strip().strip("|").split("|")])
        if rows:
            return rows
    # CSV / TSV.
    rows = []
    for ln in lines:
        sep = "\t" if "\t" in ln else ","
        rows.append([c.strip() for c in ln.split(sep)])
    return rows or [[t]]


def _cell(v) -> str:
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


async def _write_sheet(db, *, task: Task, data: SheetOutputData, text: str) -> str:
    """Workspace-output: create a new spreadsheet from the result."""
    from app.workspaces.items_router import _next_position

    ws, _owner, parent_id = await _resolve_workspace_and_folder(
        db, task=task, folder_item_id=data.folder_item_id
    )
    title = (data.title.strip() and _first_line_title(data.title.strip())) or (
        _first_line_title(text)
    )
    rows = _rows_from_text(text)[:1000]  # cap runaway output
    celldata = [
        {"r": r, "c": c, "v": {"v": val, "m": val}}
        for r, row in enumerate(rows)
        for c, val in enumerate(row)
    ]
    ncols = max((len(r) for r in rows), default=1)
    workbook = [
        {
            "name": "Sheet1",
            "index": uuid.uuid4().hex,
            "order": 0,
            "status": 1,
            "row": max(len(rows) + 4, 24),
            "column": max(ncols + 2, 12),
            "celldata": celldata,
        }
    ]
    sheet = Spreadsheet(
        workspace_id=ws.id,
        title=title,
        data=workbook,
        content_text="\n".join("\t".join(r) for r in rows) or None,
    )
    db.add(sheet)
    await db.flush()  # assign sheet.id before the item links to it
    pos = await _next_position(db, ws.id, parent_id)
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=parent_id,
        kind="sheet",
        ref_id=sheet.id,
        title=title,
        position=pos,
    )
    db.add(item)
    await db.commit()

    try:
        from app.workspaces.knowledge import index_sheet_for_workspace

        await index_sheet_for_workspace(ws.id, item.id)
    except Exception:  # noqa: BLE001 — indexing must never fail the run
        logger.warning("sheet index after creation failed", exc_info=True)
    return f'Created sheet "{title}" ({len(rows)} rows).'


async def _run_deep_research_node(
    node: FlowNode,
    ctx: dict[str, str],
    *,
    db,
    user: User,
    tz: str,
    now_local: str,
) -> tuple[str, list[dict], dict, dict]:
    """Compound step: search → fetch the top-N pages (concurrently) → synthesise
    a single cited report. Returns ``(text, sources, usage, record)``."""
    import asyncio

    import httpx
    import trafilatura

    from app.net.safe_fetch import UnsafeURLError, safe_fetch
    from app.search.providers import SearchError, run_search
    from app.search.service import pick_search_provider

    data = DeepResearchData.model_validate(node.data)
    query = (
        _interpolate(data.query, ctx).strip()
        if data.query.strip()
        else ctx.get("upstream_output", "").strip()
    )
    query = query[:400]
    if not query:
        raise TaskRunError(
            "The deep-research step has no query and no upstream text to research."
        )
    n = max(1, min(10, data.max_pages or 5))
    provider = await pick_search_provider(db, user)
    if provider is None:
        raise TaskRunError(
            "No web-search provider is configured — add one in Search settings."
        )
    try:
        results = await run_search(provider, query, n)
    except SearchError as e:
        raise TaskRunError(f"Deep research search failed: {e}") from e
    if not results:
        raise TaskRunError(f'Deep research found no sources for "{query}".')

    async def _grab(r) -> tuple[object, str]:
        try:
            resp = await safe_fetch("GET", r.url)
            resp.raise_for_status()
            body = (trafilatura.extract(resp.text) or "").strip()
            return r, body[:2500]
        except (httpx.HTTPError, UnsafeURLError, ValueError, OSError):
            return r, ""  # unreachable page → fall back to its snippet

    grabbed = await asyncio.gather(*[_grab(r) for r in results])

    evidence_parts: list[str] = []
    sources: list[dict] = []
    for i, (r, body) in enumerate(grabbed, 1):
        sources.append({"title": r.title, "url": r.url, "snippet": r.snippet})
        text_for = body or (r.snippet or "").strip() or "(no readable text)"
        evidence_parts.append(f"[{i}] {r.title} — {r.url}\n{text_for}")
    evidence = "\n\n".join(evidence_parts)

    synth_provider, model_id = await _resolve_provider(
        uuid.UUID(data.provider_id) if data.provider_id else None,
        data.model_id,
        db,
    )
    system = _build_system_prompt(
        timezone=tz,
        use_web_search=False,
        now_local_iso=now_local,
        connector_names=None,
        output_kind="report",
    )
    prompt = (
        f"Research question: {query}\n\n"
        "Using ONLY the numbered sources below, write a thorough, well-organised "
        "report that answers the question. Cite sources inline as [1], [2], … "
        "matching their numbers. Note any disagreements or gaps between sources. "
        "Do not invent facts beyond what the sources support.\n\n"
        f"Sources:\n{evidence}"
    )
    text, synth_sources, usage = await _generate(
        provider=synth_provider,
        model_id=model_id,
        system=system,
        prompt=prompt,
        user=user,
        use_web_search=False,
        reasoning_effort=data.reasoning_effort,
        mcp_schemas=[],
        mcp_dispatch={},
        db=db,
    )
    record = {
        "node_id": node.id,
        "type": NodeType.DEEP_RESEARCH,
        "label": f"Deep research ({len(results)} sources)",
        "status": "success",
        "output": text,
        "prompt_tokens": usage.get("prompt_tokens") or None,
        "completion_tokens": usage.get("completion_tokens") or None,
    }
    return text, sources, usage, record


def _eval_condition(data: ConditionData, text: str, ctx: dict[str, str]) -> bool:
    """Evaluate a Condition node against the upstream text → True/False."""
    op = data.operator
    if op == "is_empty":
        return not text.strip()
    if op == "is_not_empty":
        return bool(text.strip())
    value = _interpolate(data.value, ctx)
    if op == "matches":
        try:
            flags = 0 if data.case_sensitive else re.IGNORECASE
            return re.search(value, text, flags) is not None
        except re.error:
            return False
    hay = text if data.case_sensitive else text.lower()
    needle = value if data.case_sensitive else value.lower()
    if op == "contains":
        return needle in hay
    if op == "not_contains":
        return needle not in hay
    if op == "equals":
        return hay.strip() == needle.strip()
    if op == "not_equals":
        return hay.strip() != needle.strip()
    return False


async def _run_router_node(
    node: FlowNode,
    *,
    db,
    user: User,
    upstream: str,
) -> tuple[str, dict, dict]:
    """Classify the upstream text into one of the router's categories.
    Returns ``(selected_handle_id, usage, record)``. Falls back to the first
    category when the model's answer matches none."""
    data = RouterData.model_validate(node.data)
    cats = data.categories
    if not cats:
        raise TaskRunError("A Router step has no categories to route to.")
    provider, model_id = await _resolve_provider(
        uuid.UUID(data.provider_id) if data.provider_id else None,
        data.model_id,
        db,
    )
    listing = "\n".join(
        f'- id "{c.id}": {c.name or c.id}'
        + (f" — {c.description}" if c.description else "")
        for c in cats
    )
    system = (
        "You are a routing classifier inside an automation. Read the input and "
        "choose the single category it best fits. Reply with ONLY that "
        "category's id — no quotes, no punctuation, no explanation."
    )
    prompt = (
        f"Categories:\n{listing}\n\nInput:\n{upstream or '(empty)'}\n\n"
        "The best category id is:"
    )
    text, _sources, usage = await _generate(
        provider=provider,
        model_id=model_id,
        system=system,
        prompt=prompt,
        user=user,
        use_web_search=False,
        reasoning_effort=data.reasoning_effort,
        mcp_schemas=[],
        mcp_dispatch={},
        db=db,
    )
    answer = text.strip().lower()
    picked = None
    for c in cats:
        cid = c.id.lower()
        if answer == cid or cid in answer or (c.name and c.name.lower() in answer):
            picked = c.id
            break
    if picked is None:
        picked = cats[0].id  # fall back to the first branch
    name = next((c.name for c in cats if c.id == picked), picked)
    record = {
        "node_id": node.id,
        "type": NodeType.ROUTER,
        "label": f"Route → {name or picked}",
        "status": "success",
        "output": picked,
        "prompt_tokens": usage.get("prompt_tokens") or None,
        "completion_tokens": usage.get("completion_tokens") or None,
    }
    return picked, usage, record


def _flow_timezone(graph: FlowGraph, task: Task) -> str:
    """The schedule trigger's timezone, falling back to the task's."""
    for n in graph.nodes:
        if n.type == NodeType.TRIGGER_SCHEDULE:
            try:
                return ScheduleTriggerData.model_validate(n.data).timezone
            except Exception:  # noqa: BLE001 - malformed data → task default
                break
    return task.timezone


def _successor_types(graph: FlowGraph) -> dict[str, set[str]]:
    """node_id → the set of node types it feeds into (its downstream kinds)."""
    out: dict[str, set[str]] = {}
    by_id = {n.id: n for n in graph.nodes}
    for e in graph.edges:
        tgt = by_id.get(e.target)
        if tgt is not None:
            out.setdefault(e.source, set()).add(tgt.type)
    return out


async def run_graph_flow(
    *,
    task: Task,
    graph: FlowGraph,
    user: User,
    run_started_at: datetime,
    trigger_payload: str | None = None,
    db,
    stop_at: str | None = None,
    pinned: dict[str, str] | None = None,
    dry_run: bool = False,
) -> tuple[str, list[dict], dict, list[dict]]:
    """Execute a flow graph as a DAG → ``(report, sources, usage, node_runs)``.

    Nodes run in topological order. Each node's input is the merge of its
    predecessors' outputs (a single predecessor — the linear case — passes
    straight through, so Simple tasks and linear chains behave identically).
    A node's output is available downstream as ``{{node_<id>.output}}`` and, for
    the immediate next node, ``{{upstream_output}}``.

    Fan-out (a node feeding several downstream nodes) and multiple output sinks
    are supported. **Control nodes (Condition / Router) drive active-path
    execution**: a node runs only if at least one incoming edge is *active*, and
    an edge leaving a control node is active only via the handle that node
    selected. Everything downstream of an unselected branch is skipped. The run
    report is the text feeding an active ``output.report`` node if present, else
    the last processing node's output; each active action sink appends a note.
    """
    partial = stop_at is not None
    if not is_executable_graph(graph, require_output=not partial):
        raise TaskRunError(
            "This flow can't run yet — it needs one trigger, no loops, and "
            "connected steps."
        )

    order = topological_order(graph)
    by_id = {n.id: n for n in graph.nodes}
    succ_types = _successor_types(graph)
    control_ids = {n.id for n in graph.nodes if n.type in CONTROL_TYPES}
    in_edges: dict[str, list] = {}
    for e in graph.edges:
        in_edges.setdefault(e.target, []).append(e)

    # "Run to here": only execute the target node and its ancestors.
    run_set = ancestors_of(graph, stop_at) if partial and stop_at in by_id else None
    pinned = pinned or {}

    tz = _flow_timezone(graph, task)
    now_local = run_started_at.astimezone(_tz.utc).isoformat(timespec="minutes")

    outputs: dict[str, str] = {}  # node_id → text output (for {{node_x.output}})
    structured: dict[str, object] = {}  # node_id → parsed JSON (for {{...json.path}})
    inputs_by_node: dict[str, str] = {}  # node_id → merged input (for the inspector)
    active: set[str] = set()  # nodes that actually ran (on the taken path)
    selected: dict[str, set[str]] = {}  # control node_id → handles it fired
    sources: list[dict] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}
    node_runs: list[dict] = []
    ai_count = sum(1 for n in graph.nodes if n.type == NodeType.AI_PROMPT)
    ai_seen = 0
    last_processing_output = ""  # fallback run report when there's no report node
    report_from_output: str | None = None  # an output.report node's input, if any
    action_notes: list[str] = []

    def _edge_active(e) -> bool:
        if e.source not in active:
            return False
        if e.source in control_ids:
            return (e.source_handle or "") in selected.get(e.source, set())
        return True

    def _accum_usage(u: dict) -> None:
        if u.get("prompt_tokens"):
            usage["prompt_tokens"] += u["prompt_tokens"]
        if u.get("completion_tokens"):
            usage["completion_tokens"] += u["completion_tokens"]
        if u.get("cost_usd") is not None:
            usage["cost_usd"] = (usage["cost_usd"] or 0.0) + u["cost_usd"]

    for nid in order:
        node = by_id[nid]

        # "Run to here": ignore nodes that aren't the target or its ancestors.
        if run_set is not None and nid not in run_set:
            continue

        if node.type in (NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_MANUAL):
            active.add(nid)
            outputs[nid] = trigger_payload or ""
            structured[nid] = _try_json(trigger_payload or "")
            continue

        # Pinned (dev-time): use the frozen value instead of executing, so you
        # can iterate downstream without re-calling the model / MCP / search.
        if nid in pinned:
            active.add(nid)
            outputs[nid] = pinned[nid]
            structured[nid] = _try_json(pinned[nid])
            last_processing_output = pinned[nid]
            node_runs.append(
                {
                    "node_id": nid,
                    "type": node.type,
                    "label": "Pinned",
                    "status": "pinned",
                    "input": "\n\n".join(
                        outputs[e.source]
                        for e in in_edges.get(nid, [])
                        if outputs.get(e.source)
                    ),
                    "output": pinned[nid],
                }
            )
            continue

        # A node runs only if an incoming edge is active. All-inactive → skip
        # (and it stays inactive, so its own downstream skips too).
        node_in_edges = in_edges.get(nid, [])
        active_srcs = [e.source for e in node_in_edges if _edge_active(e)]
        # A Merge in "wait for all" mode requires *every* incoming branch to be
        # active — if any branch was skipped, the merge doesn't fire.
        if node.type == NodeType.MERGE:
            try:
                _wait_all = MergeData.model_validate(node.data).mode == "all"
            except Exception:  # noqa: BLE001 — malformed → default to wait-all
                _wait_all = True
            if _wait_all and (
                not node_in_edges or len(active_srcs) != len(node_in_edges)
            ):
                active_srcs = []  # force skip until all branches arrive
        if not active_srcs:
            outputs[nid] = ""
            node_runs.append(
                {
                    "node_id": nid,
                    "type": node.type,
                    "label": "Skipped",
                    "status": "skipped",
                    "output": "",
                }
            )
            continue
        active.add(nid)
        upstream = "\n\n".join(outputs[s] for s in active_srcs if outputs.get(s))
        inputs_by_node[nid] = upstream
        # Field access to the immediate upstream's JSON (single predecessor).
        upstream_struct = (
            structured.get(active_srcs[0]) if len(active_srcs) == 1 else None
        )
        ctx = _step_context(
            upstream=upstream,
            trigger_payload=trigger_payload or "",
            now_local=now_local,
            outputs=outputs,
            structured=structured,
            upstream_struct=upstream_struct,
        )

        # Test runs don't perform output side effects (no note/card/message
        # created) — they just report what *would* happen.
        if dry_run and node.type in OUTPUT_TYPES:
            outputs[nid] = upstream
            if node.type == NodeType.OUTPUT_REPORT:
                report_from_output = upstream
            node_runs.append(
                {
                    "node_id": nid,
                    "type": node.type,
                    "label": "Output (dry run)",
                    "status": "success",
                    "output": "(test run — nothing was created)",
                }
            )
            continue

        try:
            if node.type == NodeType.CONDITION:
                data = ConditionData.model_validate(node.data)
                # Test a specific value (e.g. {{json.status}}) or the whole upstream.
                left = _interpolate(data.source, ctx) if data.source.strip() else upstream
                result = _eval_condition(data, left, ctx)
                selected[nid] = {"true" if result else "false"}
                outputs[nid] = upstream  # pass the text through on the taken branch
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": NodeType.CONDITION,
                        "label": "Condition",
                        "status": "success",
                        "output": f"{data.operator} → {'true' if result else 'false'}",
                    }
                )

            elif node.type == NodeType.ROUTER:
                picked, router_usage, record = await _run_router_node(
                    node, db=db, user=user, upstream=upstream
                )
                _accum_usage(router_usage)
                selected[nid] = {picked}
                outputs[nid] = upstream
                node_runs.append(record)

            elif node.type == NodeType.MERGE:
                data = MergeData.model_validate(node.data)
                sep = {"blank": "\n\n", "newline": "\n", "space": " "}.get(
                    data.separator, "\n\n"
                )
                merged = sep.join(outputs[s] for s in active_srcs if outputs.get(s))
                outputs[nid] = merged
                last_processing_output = merged
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": NodeType.MERGE,
                        "label": f"Merge ({len(active_srcs)} branch"
                        + ("es" if len(active_srcs) != 1 else "")
                        + ")",
                        "status": "success",
                        "output": merged,
                    }
                )

            elif node.type == NodeType.DELAY:
                secs = max(0, min(_DELAY_CAP_SECONDS, DelayData.model_validate(node.data).seconds or 0))
                if secs:
                    await asyncio.sleep(secs)
                outputs[nid] = upstream  # pass the text through unchanged
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": NodeType.DELAY,
                        "label": f"Delay {secs}s",
                        "status": "success",
                        "output": f"Paused {secs}s.",
                    }
                )

            elif node.type == NodeType.SEARCH_WEB:
                text, node_sources, record = await _run_search_node(
                    node, ctx, db=db, user=user
                )
                sources.extend(node_sources)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.FETCH_PAGE:
                text, node_sources, record = await _run_fetch_node(node, ctx)
                sources.extend(node_sources)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.SUMMARISE:
                text, node_sources, s_usage, record = await _run_summarise_node(
                    node, ctx, db=db, user=user, tz=tz, now_local=now_local
                )
                sources.extend(node_sources)
                _accum_usage(s_usage)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.EXTRACT:
                text, node_sources, e_usage, record = await _run_extract_node(
                    node, ctx, db=db, user=user, tz=tz, now_local=now_local
                )
                sources.extend(node_sources)
                _accum_usage(e_usage)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.DEEP_RESEARCH:
                text, node_sources, dr_usage, record = await _run_deep_research_node(
                    node, ctx, db=db, user=user, tz=tz, now_local=now_local
                )
                sources.extend(node_sources)
                _accum_usage(dr_usage)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.LOOP:
                text, node_sources, loop_usage, record = await _run_loop_node(
                    node, ctx, db=db, user=user, task=task, tz=tz, now_local=now_local
                )
                sources.extend(node_sources)
                _accum_usage(loop_usage)
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.MEMORY:
                text, record = await _run_memory_node(
                    node, ctx, db=db, task=task, now_local=now_local, dry_run=dry_run
                )
                node_runs.append(record)
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.AI_PROMPT:
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
                # Shape this step's output for what it feeds: a board card wants JSON,
                # a report/note wants prose, anything else is an intermediate step.
                downs = succ_types.get(nid, set())
                if NodeType.OUTPUT_BOARD_CARD in downs:
                    output_kind = "board_card"
                elif downs & OUTPUT_TYPES:
                    output_kind = "report"
                else:
                    output_kind = "step"
                system = _build_system_prompt(
                    timezone=tz,
                    use_web_search=data.use_web_search,
                    now_local_iso=now_local,
                    connector_names=names,
                    output_kind=output_kind,
                )
                # Blank prompt → default to consuming the upstream text, so an AI
                # step dropped after a search/fetch "just works" without config.
                prompt = _interpolate(data.prompt.strip() or "{{upstream_output}}", ctx)
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
                _accum_usage(node_usage)
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": NodeType.AI_PROMPT,
                        "label": f"AI step {ai_seen}" if ai_count > 1 else "AI step",
                        "status": "success",
                        "output": text,
                        "prompt_tokens": node_usage.get("prompt_tokens") or None,
                        "completion_tokens": node_usage.get("completion_tokens") or None,
                    }
                )
                outputs[nid] = text
                last_processing_output = text

            elif node.type == NodeType.OUTPUT_BOARD_CARD:
                note = await _file_board_card(
                    db,
                    task=task,
                    data=BoardCardOutputData.model_validate(node.data),
                    text=upstream,
                )
                action_notes.append(note)
                outputs[nid] = upstream
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": node.type,
                        "label": "Create card",
                        "status": "success",
                        "output": note,
                    }
                )

            elif node.type == NodeType.OUTPUT_CHAT_MESSAGE:
                note = await _post_chat_message(
                    db,
                    task=task,
                    data=ChatMessageOutputData.model_validate(node.data),
                    text=upstream,
                )
                action_notes.append(note)
                outputs[nid] = upstream
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": node.type,
                        "label": "Send message",
                        "status": "success",
                        "output": note,
                    }
                )

            elif node.type == NodeType.OUTPUT_NOTE:
                note = await _write_note(
                    db,
                    task=task,
                    data=NoteOutputData.model_validate(node.data),
                    text=upstream,
                )
                action_notes.append(note)
                outputs[nid] = upstream
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": node.type,
                        "label": "Create note",
                        "status": "success",
                        "output": note,
                    }
                )

            elif node.type == NodeType.OUTPUT_SHEET:
                note = await _write_sheet(
                    db,
                    task=task,
                    data=SheetOutputData.model_validate(node.data),
                    text=upstream,
                )
                action_notes.append(note)
                outputs[nid] = upstream
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": node.type,
                        "label": "Create sheet",
                        "status": "success",
                        "output": note,
                    }
                )

            else:  # NodeType.OUTPUT_REPORT
                report_from_output = upstream
                outputs[nid] = upstream
                node_runs.append(
                    {
                        "node_id": nid,
                        "type": node.type,
                        "label": "Report",
                        "status": "success",
                        "output": "Saved as the run report.",
                    }
                )
        except Exception as _exc:  # noqa: BLE001 — per-node error handling
            if (node.data or {}).get("on_error") != "continue":
                raise
            outputs[nid] = ""
            structured[nid] = None
            node_runs.append(
                {
                    "node_id": nid,
                    "type": node.type,
                    "label": "Error (continued)",
                    "status": "error",
                    "input": upstream,
                    "output": str(_exc)[:500],
                }
            )
            continue

        # Expose this node's JSON (if it emitted any) for downstream field refs.
        structured[nid] = _try_json(outputs.get(nid, ""))

    # The run's report: the text feeding a report node if there is one, else the
    # last processing node's output. Action sinks append their one-line notes.
    report = (
        report_from_output
        if report_from_output is not None
        else last_processing_output
    )
    for note in action_notes:
        report = f"{report}\n\n---\n\n*{note}*"

    # Attach each executed node's input to its record (for the inspector's
    # "what this step received" panel). Pinned/skip records set their own.
    for r in node_runs:
        if "input" not in r:
            r["input"] = inputs_by_node.get(r["node_id"], "")

    # De-dup sources by URL across the whole graph, preserving order.
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
