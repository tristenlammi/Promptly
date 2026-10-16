"""Automation copilot (A2) — draft a flow graph from plain language.

The flagship "AI-first" move: the user describes what they want in a
sentence, a model drafts the node graph, and it renders in the editor
for review. The graph is plain JSON and the node catalogue is small +
well-typed, so this is a constrained generation problem, not a
free-for-all — we hand the model the exact schema, the user's available
models to fill AI nodes with, and validate/repair the result before it
ever reaches the canvas.

Also powers "explain this flow" and "diagnose this failed run".
"""
from __future__ import annotations

import json
import logging
import re
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.models_config.models import ModelProvider
from app.tasks.flow_graph import (
    FlowGraph,
    NodeType,
    is_executable_graph,
)

logger = logging.getLogger("promptly.tasks.copilot")


class CopilotError(Exception):
    """A copilot request failed in a way worth showing the user verbatim."""


# The node catalogue the drafter may use, with the exact ``data`` shape
# for each. Kept terse — the model reads this as its API reference.
_NODE_CATALOG = """\
TRIGGERS (exactly one, no incoming edges):
- trigger.schedule  data: {frequency:"hourly|daily|weekly|monthly", hour:0-23, minute:0-59, weekday:0-6|null, day_of_month:1-28|null, timezone:"<IANA>"}
- trigger.manual    data: {}                         (run only on demand)
- trigger.webhook   data: {}                         (an inbound URL starts it; body → {{trigger.payload}} / {{trigger.json.<field>}}, headers → {{trigger.headers.<name>}})
- trigger.event     data: {event:"file_added|card_moved|item_created", folder_id:null, column:null, board_item_id:null, item_kind:null}   (details → {{trigger.json.*}}, e.g. {{trigger.json.file_id}})

PROCESSING (each reads upstream text, emits text):
- ai.prompt      data: {prompt, provider_id, model_id, use_web_search:false, connector_ids:[]}
- ai.summarise   data: {length:"short|medium|detailed", provider_id, model_id}
- ai.extract     data: {spec:"<fields wanted>", provider_id, model_id}   (emits JSON)
- search.web     data: {query:"", count:5}                                 (blank query = search upstream text)
- fetch.page     data: {url:"", max_chars:8000}                            (blank url = first URL in upstream)
- http.request   data: {method:"GET|POST|PUT|PATCH|DELETE", url, headers:[{name,value}], body:"", timeout_s:30, fail_on_error_status:true, allow_private_network:false}
- research.deep  data: {query:"", max_pages:5, provider_id, model_id}      (search+read+cited report)
- mcp.action     data: {connector_id, tool_name, arguments:"{\"key\": \"{{upstream_output}}\"}"}   (call a connector tool directly; arguments is a JSON template)
- workspace.read data: {mode:"search|item|file", query:"", title:"", item_id:null, file_id:"", top_k:6}   (workspace only: search the workspace, read one note/board/sheet/roster by title, or a file's text by id — e.g. file_id:"{{trigger.json.file_id}}")
- loop.foreach   data: {split_mode:"lines|json", prompt:"...{{item}}...", provider_id, model_id, max_items:10, join_with:"blank|numbered"}
- memory.store   data: {name:"Memory", remember:true, max_runs:5}          (remembers across runs; compare to last time)
- flow.delay     data: {seconds:5}

CONTROL (route, don't transform; use source_handle on their outgoing edges):
- control.condition  data: {source:"", operator:"contains|not_contains|equals|not_equals|matches|is_empty|is_not_empty", value:"", case_sensitive:false}  handles: "true","false"
- control.router     data: {categories:[{id,name,description}], provider_id, model_id}  (AI classifier; handles are the category ids)
- flow.merge         data: {mode:"all|any", separator:"blank|newline|space"}  (join branches)

OUTPUTS (terminal, no outgoing edges; at least one required):
- output.report       data: {notify:true}                       (the run report — the default sink)
- output.board_card   data: {board_item_id:null, column:"todo", priority:"medium", update_existing:false}   (workspace only)
- output.chat_message data: {chat_item_id:null}                  (workspace only)
- output.note         data: {title:"", folder_item_id:null}      (workspace only)
- output.sheet        data: {title:"", folder_item_id:null}      (workspace only)

TEMPLATES you can use in any text/url/prompt/query field:
  {{upstream_output}}  {{node_<id>.output}}  {{json.<path>}}  {{node_<id>.json.<path>}}
  {{trigger.payload}}  {{trigger.json.<field>}}  {{date}} {{time}} {{datetime}} (the schedule's timezone)
  {{secret.NAME}}      (only inside http.request — the credentials vault)
"""

_SYSTEM_PROMPT = """You design automation flow graphs for Promptly's node engine.

Return ONE JSON object and nothing else (no prose, no markdown fence):
{
  "nodes": [{"id": "<short unique string>", "type": "<node type>", "position": {"x": <int>, "y": <int>}, "data": {<per-type>}}],
  "edges": [{"source": "<node id>", "target": "<node id>", "source_handle": "<handle or omit>"}]
}

RULES:
- Exactly one trigger node, and it has no incoming edges.
- At least one output node (output.report is the safe default), and outputs have no outgoing edges.
- Every node must be reachable from the trigger (connect the chain).
- No cycles.
- Use only the node types in the catalogue below, with their exact data shape.
- Lay nodes left-to-right: trigger at x≈0, each subsequent stage +260 on x; stack parallel branches on y (±140).
- For a control.condition, give BOTH a "true" and (if used) "false" outgoing edge via source_handle.
- For a control.router, the outgoing edges' source_handle must equal a category id you defined.
- Only use output.board_card / chat_message / note / sheet when the flow is for a workspace (you'll be told). Their target ids are null — the user picks them after.
- Fill ai.* / router / research / loop provider_id + model_id from the AVAILABLE MODELS list (use the first one unless the request implies otherwise). If none are listed, leave them null.
- Keep it as simple as the request allows. Prefer one clean path over cleverness.

NODE CATALOGUE:
""" + _NODE_CATALOG


def _extract_json(text: str) -> dict:
    """Pull the JSON object out of a model reply (tolerating a stray fence
    or a line of preamble)."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t.strip())
    # Fall back to the first {...last} span if there's surrounding chatter.
    if not t.startswith("{"):
        start, end = t.find("{"), t.rfind("}")
        if start != -1 and end > start:
            t = t[start : end + 1]
    return json.loads(t)


async def _resolve_copilot_model(
    db: AsyncSession, user: User
) -> tuple[ModelProvider, str, list[dict]]:
    """Pick the model that *drafts* the graph, and return the catalogue of
    models the drafter may assign to AI nodes."""
    from app.models_config.router import list_available_models_for

    models = await list_available_models_for(user, db)
    if not models:
        raise CopilotError(
            "No models are available — add a provider before using the copilot."
        )
    # Draft with the first available model (the same default the pickers use).
    drafter = models[0]
    provider = await db.get(ModelProvider, drafter.provider_id)
    if provider is None or not provider.enabled:
        raise CopilotError("The drafting model's provider is unavailable.")
    catalog = [
        {"provider_id": str(m.provider_id), "model_id": m.model_id, "name": m.display_name}
        for m in models[:12]
    ]
    return provider, drafter.model_id, catalog


async def _metered(db: AsyncSession, user: User, **kw) -> str:
    """One copilot model call, charged to the user like a chat turn: refused
    when their budget is used up, and recorded in usage (R-011)."""
    from app.billing.usage import check_budget, record_usage
    from app.models_config.provider import model_router

    if (await check_budget(db, user)).verdict == "blocked":
        raise CopilotError("Your usage budget is used up.")
    usage: dict = {}
    chunks: list[str] = []
    # Recorded below as a full turn, so not billed again as a side call.
    async for tok in model_router.stream_chat(usage_out=usage, bill=False, **kw):
        chunks.append(tok)
    try:
        await record_usage(
            db,
            user_id=user.id,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
        )
        await db.commit()
    except Exception:  # noqa: BLE001 — metering must not break the copilot
        logger.exception("recording copilot usage failed")
    return "".join(chunks)


async def draft_graph(
    db: AsyncSession,
    *,
    user: User,
    description: str,
    in_workspace: bool,
) -> FlowGraph:
    """Draft → validate → (repair once) → return an executable FlowGraph.

    Never persists — the caller hands it to the editor for review.
    """
    from app.models_config.provider import ChatMessage

    description = (description or "").strip()
    if len(description) < 3:
        raise CopilotError("Describe what the automation should do.")

    provider, model_id, catalog = await _resolve_copilot_model(db, user)
    default = catalog[0] if catalog else None
    context = (
        "AVAILABLE MODELS (provider_id, model_id — fill AI nodes from these):\n"
        + json.dumps(catalog, indent=2)
        + f"\n\nDefault model to use unless the request implies otherwise: "
        + (json.dumps(default) if default else "none")
        + f"\n\nThis flow is {'FOR A WORKSPACE (workspace outputs allowed)' if in_workspace else 'a personal automation (use output.report; no workspace outputs)'}."
        + f"\n\nUSER REQUEST:\n{description}"
    )

    async def _call(extra: str = "") -> str:
        return await _metered(
            db,
            user,
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=context + extra)],
            system=_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=3000,
        )

    def _build(raw: str) -> FlowGraph:
        obj = _extract_json(raw)
        obj.setdefault("version", 1)
        obj["mode"] = "advanced"
        # Stamp a stable position for any node the model left unplaced.
        for i, n in enumerate(obj.get("nodes", [])):
            n.setdefault("position", {"x": i * 260, "y": 0})
        graph = FlowGraph.model_validate(obj)
        if not is_executable_graph(graph):
            raise ValueError(
                "the graph isn't a runnable DAG (needs one trigger, ≥1 output, "
                "no loops, every node connected)"
            )
        return graph

    try:
        raw = await _call()
    except CopilotError:
        raise
    except Exception as exc:  # noqa: BLE001 — provider error et al.
        raise CopilotError(
            f"The drafting model didn't respond: {str(exc)[:200]}"
        ) from exc

    try:
        return _build(raw)
    except Exception as first_err:  # noqa: BLE001
        # One repair attempt: hand the model its own output + the error.
        try:
            raw2 = await _call(
                f"\n\nYour previous answer was invalid ({first_err}). "
                "Return corrected JSON only:\n" + raw[:2000]
            )
            return _build(raw2)
        except Exception as second_err:  # noqa: BLE001
            logger.warning("copilot draft failed twice: %s", second_err)
            raise CopilotError(
                "Couldn't turn that into a valid flow. Try describing the "
                "steps more concretely (trigger → what to do → where the "
                "result goes)."
            ) from second_err


async def explain_graph(
    db: AsyncSession, *, user: User, graph: FlowGraph
) -> str:
    """Plain-language walkthrough of what a flow does — for the 'Explain'
    action. Best-effort; returns a short markdown summary."""
    from app.models_config.provider import ChatMessage

    provider, model_id, _ = await _resolve_copilot_model(db, user)
    graph_json = json.dumps(graph.model_dump(mode="json").get("nodes", []))
    sys = (
        "You explain automation flows to their owner. Given the node list, "
        "write 2-4 short sentences (plain language, no JSON, no node ids) "
        "describing what the automation does end to end: what starts it, what "
        "each step does, and where the result goes."
    )
    text = await _metered(
        db,
        user,
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=graph_json)],
        system=sys,
        temperature=0.3,
        max_tokens=400,
    )
    return text.strip() or "This flow has no steps yet."


async def diagnose_run(
    db: AsyncSession,
    *,
    user: User,
    graph: FlowGraph,
    node_runs: list[dict],
    error: str | None,
) -> str:
    """Given a failed run's per-node records, explain what went wrong and how
    to fix it — for the 'Diagnose' action on a failed run."""
    from app.models_config.provider import ChatMessage

    provider, model_id, _ = await _resolve_copilot_model(db, user)
    # Trim node records to the fields that matter (drop big outputs).
    trimmed = [
        {
            "node_id": r.get("node_id"),
            "type": r.get("type"),
            "status": r.get("status"),
            "label": r.get("label"),
            "output": (r.get("output") or "")[:400],
            **({"unresolved_variables": r["unresolved"]} if r.get("unresolved") else {}),
        }
        for r in (node_runs or [])
    ]
    # The flow itself (each step's settings, trimmed) — the graph was a
    # parameter but never reached the prompt, so Diagnose guessed (R-146).
    steps = [
        {
            "id": n.id,
            "type": str(getattr(n.type, "value", n.type)),
            "settings": json.dumps(n.data or {}, ensure_ascii=False, default=str)[:600],
        }
        for n in graph.nodes
    ]
    edges = [f"{e.source} -> {e.target}" for e in graph.edges][:60]
    payload = json.dumps(
        {"error": error, "flow": {"steps": steps, "edges": edges}, "run": trimmed},
        ensure_ascii=False,
    )
    sys = (
        "You are debugging a failed automation run. Given the per-node results "
        "and the top-level error, say in 2-4 sentences what most likely went "
        "wrong and the concrete fix (which node, what to change). Plain "
        "language, no JSON."
    )
    text = await _metered(
        db,
        user,
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=payload)],
        system=sys,
        temperature=0.3,
        max_tokens=500,
    )
    return text.strip() or "No diagnosis available."


__all__ = ["draft_graph", "explain_graph", "diagnose_run", "CopilotError"]
