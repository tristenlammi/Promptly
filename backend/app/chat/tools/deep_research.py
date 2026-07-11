"""``deep_research`` — let the model launch the full Deep Research pipeline.

The user-triggered Deep Research feature (``app.research.engine.run_research``)
runs a decompose → parallel-search+read → gap-check → synthesise pipeline. This
tool exposes the *evidence-gathering* half of that pipeline to the chat model,
so it can decide mid-conversation that a question warrants real multi-source
research and then synthesise the answer inline from the returned evidence.

The shape mirrors :class:`~app.chat.tools.run_agents.RunAgentsTool`: one
heavyweight call per turn, a long timeout, and a returned evidence bundle +
deduped citations the parent model writes its final answer from (it must NOT
re-search). Unlike the endpoint, this tool has **no side effects of its own** —
it neither persists a separate message nor renders a PDF. The report is just the
assistant's normal reply, and the citations ride the chat router's existing
``on_sources`` hook onto that message. Keeping the two paths on one shared core
(``gather_research_evidence``) means the investigation logic can never diverge.
"""
from __future__ import annotations

import logging
from typing import Any

from app.chat.models import Conversation
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.tools.deep_research")

_MAX_QUERY_CHARS = 600


def _progress_label(ev: dict[str, Any]) -> str | None:
    """Map a research event dict to a short human progress line.

    Returns ``None`` for events that don't warrant a spinner update, so the
    tool-activity card shows "Reading example.com" rather than a frozen string.
    """
    kind = ev.get("event")
    if kind == "research_start":
        return "Planning the investigation…"
    if kind == "research_decomposed":
        n = len(ev.get("subquestions") or [])
        return f"Researching {n} angles…" if n else "Researching…"
    if kind == "research_searching":
        return "Searching the web…"
    if kind == "research_reading":
        url = ev.get("url") or ""
        host = url.split("/", 3)[2] if "://" in url else ""
        return f"Reading {host}…" if host else "Reading a source…"
    if kind == "research_gap_start":
        return "Checking for gaps…"
    if kind == "research_gap_done":
        return "Synthesising findings…"
    return None


class DeepResearchTool(Tool):
    name = "deep_research"
    # Search-driven, like run_agents: only advertised when Tools AND web
    # search are both on (see registry / router category gating).
    category = "agents"
    # One heavyweight investigation per turn — each call already fans out
    # across several angles with its own search+read budget.
    max_per_turn = 1
    # The pipeline awaits several parallel angles plus a gap-check pass; the
    # engine's own per-search/-fetch timeouts bound each step, this is the
    # backstop for the whole investigation.
    timeout_seconds = 300.0
    # The evidence doc is capped at ~35k chars by the engine; leave headroom
    # for the instruction preamble.
    max_content_chars = 36_000
    description = (
        "Run a thorough, multi-source web investigation on a question and get "
        "back structured, cited evidence to write your answer from. It breaks "
        "the question into several angles, searches and reads multiple sources "
        "per angle IN PARALLEL, checks for gaps, and returns the collected "
        "evidence with numbered citations. Use it when a question is genuinely "
        "open-ended or comparative and benefits from broad, current coverage "
        "across many sources — e.g. 'the state of X', 'compare A vs B vs C', a "
        "landscape / impact / history overview. Do NOT use it for a single "
        "fact (call `web_search`) or to read one specific page (call "
        "`fetch_url`). One call does the whole investigation; you then write "
        "the final report yourself from the evidence it returns."
    )
    prompt_hint = (
        "Kick off a full multi-angle web investigation (parallel search + read "
        "+ gap-check) and get back cited evidence to synthesise from. Best for "
        "broad, open-ended, or comparative questions. For one fact use "
        "web_search; for one page use fetch_url."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The research question or topic to investigate, phrased as "
                    "a self-contained question."
                ),
                "maxLength": _MAX_QUERY_CHARS,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ToolError("`query` is required and must be a non-empty string")
        query = query.strip()[:_MAX_QUERY_CHARS]

        conv = await ctx.db.get(Conversation, ctx.conversation_id)
        if conv is None or conv.provider_id is None or not conv.model_id:
            raise ToolError(
                "Can't run deep research: this conversation has no model "
                "configured."
            )

        # The whole pipeline is web-driven; bail early if search isn't set up.
        from app.search.service import pick_search_provider

        if await pick_search_provider(ctx.db, ctx.user) is None:
            raise ToolError(
                "Can't run deep research: no web-search provider is configured. "
                "Ask an admin to enable one in Search settings."
            )

        # Resolve the research model — admin-configured pro model if set, else
        # this conversation's own model. Lazy imports keep the tool-load module
        # graph acyclic (registry → this tool) and avoid importing FastAPI /
        # the research router at chat-tool import time.
        from fastapi import HTTPException

        from app.research.engine import gather_research_evidence
        from app.research.router import _resolve_research_model

        try:
            provider, model_id = await _resolve_research_model(
                ctx.db, ctx.user, conv.provider_id, conv.model_id
            )
        except HTTPException as exc:  # bad / disabled provider
            raise ToolError(
                "Can't run deep research: the conversation's model is "
                "unavailable."
            ) from exc

        logger.info(
            "deep_research user=%s conv=%s query=%r",
            ctx.user.id,
            ctx.conversation_id,
            query[:80],
        )

        def _on_progress(ev: dict[str, Any]) -> None:
            label = _progress_label(ev)
            if label:
                ctx.report_progress(label, data={"event": ev.get("event")})

        evidence = await gather_research_evidence(
            query=query,
            db=ctx.db,
            user=ctx.user,
            conversation_id=ctx.conversation_id,
            user_message_id=ctx.user_message_id,
            provider=provider,
            model_id=model_id,
            on_progress=_on_progress,
        )

        if evidence.source_count == 0:
            raise ToolError(
                "Deep research found no usable sources for that query — try "
                "web_search directly, or rephrase the question."
            )

        content = (
            "You ran deep research on the user's question. Structured, cited "
            "evidence gathered from multiple sources across "
            f"{evidence.angle_count} angles is below. Write your final answer "
            "for the user NOW from this evidence, citing inline with [1], [2] "
            "matching the source indices. The sources were already searched and "
            "read — do NOT call web_search, fetch_url, run_agents, or "
            "deep_research again to re-verify; only search if a specific fact "
            "the user explicitly asked for is missing from all of the evidence "
            "below.\n\n" + evidence.evidence_doc
        )
        meta: dict[str, Any] = {
            "source_count": evidence.source_count,
            "angle_count": evidence.angle_count,
        }
        return ToolResult(content=content, sources=evidence.sources, meta=meta)


__all__ = ["DeepResearchTool"]
