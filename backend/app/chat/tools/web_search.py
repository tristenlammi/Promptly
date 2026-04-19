"""``web_search`` — search the web for citations.

Phase D1's first-class search tool. Wraps the existing
:func:`app.search.providers.run_search` plumbing (provider resolution,
SSRF-guarded fetches, dedup) so the model can ask for fresh facts in
the middle of a turn instead of relying on a forced pre-search that
fires whether the question needs it or not.

The tool returns a single ``ToolResult`` whose:

* ``content`` — a numbered, model-friendly text rendering of the hits.
  The model sees ``[1] Title — snippet`` lines and a brief reminder
  to cite inline; this is byte-identical to the Phase 7.5 prompt block
  so existing models fine-tuned on the old formatting keep behaving.
* ``sources`` — the structured citations the chat router drains onto
  the assistant ``messages.sources`` JSONB. Powers the existing
  ``SourcesFooter`` chip + the new inline ``[n]`` citation chips.
* ``meta`` — provider type + query, surfaced on the ``tool_finished``
  SSE event so the UI can show "searched Brave for 'foo'" on the chip.

Per-turn cap: 3 invocations. A single chat turn that searches more
than three times is almost always a runaway loop — the model is
better off summarising what it has and asking the user for help. The
hard cap matches the existing per-turn budget pattern set by
``GenerateImageTool``.
"""
from __future__ import annotations

import logging
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.search.providers import SearchError, run_search
from app.search.service import pick_search_provider

logger = logging.getLogger("promptly.tools.web_search")

_MAX_QUERY_CHARS = 400
_MAX_RESULTS = 10


class WebSearchTool(Tool):
    name = "web_search"
    category = "search"
    description = (
        "Search the public web for up-to-date information and return "
        "structured citations. Call this whenever the user's question "
        "depends on facts that change after your training cutoff "
        "(news, prices, sports scores, software versions, recent events, "
        "people's current roles, etc.) or asks for sources / 'look up' / "
        "'check the web'. Each result includes a title, URL, and a short "
        "snippet — cite them inline using [1], [2], ... in your reply. "
        "Prefer ONE focused query over several broad ones; you can call "
        "this tool again with a refined query if the first pass missed."
    )
    prompt_hint = (
        "Run a web search and get back numbered citations. Use whenever "
        "the user wants fresh facts, recent news, or asks you to look "
        "something up. Cite results inline with [1], [2] in your reply."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The search query. Keep it concise and keyword-y "
                    "(under 15 words is ideal); a search engine, not a "
                    "chat assistant, is reading this. Drop pleasantries "
                    "and conversational filler."
                ),
                "maxLength": _MAX_QUERY_CHARS,
            },
            "count": {
                "type": "integer",
                "description": (
                    "Number of results to return (1-10). Defaults to "
                    "the user's configured search-result count if "
                    "omitted; bump only when the question genuinely "
                    "needs a wide net."
                ),
                "minimum": 1,
                "maximum": _MAX_RESULTS,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    }
    # Three searches per turn is enough for "search, refine, double-
    # check" patterns without letting a confused model burn the user's
    # search-API quota in one turn.
    max_per_turn = 3

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        query = args.get("query")
        count = args.get("count")

        if not isinstance(query, str) or not query.strip():
            raise ToolError("`query` is required and must be a non-empty string")
        query = query.strip()
        if len(query) > _MAX_QUERY_CHARS:
            raise ToolError(
                f"`query` exceeds {_MAX_QUERY_CHARS}-char limit"
            )
        if count is not None:
            if not isinstance(count, int) or isinstance(count, bool):
                raise ToolError("`count`, when provided, must be an integer")
            if count < 1 or count > _MAX_RESULTS:
                raise ToolError(
                    f"`count` must be between 1 and {_MAX_RESULTS}"
                )

        provider = await pick_search_provider(ctx.db, ctx.user)
        if provider is None:
            raise ToolError(
                "No web-search provider is configured for this account. "
                "Ask an admin to enable SearXNG / Brave / Tavily / Google "
                "PSE in Search settings."
            )

        try:
            results = await run_search(provider, query, count=count)
        except SearchError as e:
            logger.warning(
                "web_search tool failure user=%s provider=%s err=%s",
                ctx.user.id,
                provider.type,
                e,
            )
            raise ToolError(f"Search failed: {e}") from e

        if not results:
            return ToolResult(
                content=(
                    f"No results for {query!r} via {provider.type}. "
                    "Tell the user the search came back empty and ask "
                    "them to refine the query."
                ),
                sources=[],
                meta={
                    "provider": provider.type,
                    "query": query,
                    "result_count": 0,
                },
            )

        # Render the model-facing content. Numbered list keeps the
        # citation contract identical to the legacy "always" path so
        # existing prompt habits (cite with [n]) keep working.
        lines = [f"Search results for {query!r}:"]
        for idx, r in enumerate(results, start=1):
            snippet = (r.snippet or "").strip().replace("\n", " ")
            lines.append(f"[{idx}] {r.title}")
            lines.append(f"    URL: {r.url}")
            if snippet:
                lines.append(f"    Snippet: {snippet}")
        lines.append("")
        lines.append(
            "Cite the sources you actually rely on inline with [1], [2], "
            "etc. If none of them answer the question, say so plainly."
        )
        content = "\n".join(lines)

        sources = [
            {"title": r.title, "url": r.url, "snippet": r.snippet}
            for r in results
        ]

        logger.info(
            "web_search ok user=%s provider=%s n=%d q=%r",
            ctx.user.id,
            provider.type,
            len(results),
            query[:80],
        )

        return ToolResult(
            content=content,
            sources=sources,
            meta={
                "provider": provider.type,
                "query": query,
                "result_count": len(results),
            },
        )


__all__ = ["WebSearchTool"]
