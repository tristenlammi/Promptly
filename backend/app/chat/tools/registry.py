"""Tool registry — one source of truth for "which tools exist".

Concrete tool modules register themselves at import time by appending to
the module-level ``REGISTRY`` list. The chat router asks for the OpenAI
JSON for the live set, then dispatches by name when the model picks
one. Keeping the registry a plain list (rather than a dict keyed by
name) lets the chat router preserve a deterministic order across
``tools[]`` payloads, which some providers cache on.
"""
from __future__ import annotations

from typing import Any

from app.chat.tools.base import Tool
from app.chat.tools.echo import EchoTool
from app.chat.tools.fetch_url import FetchUrlTool
from app.chat.tools.generate_image import GenerateImageTool
from app.chat.tools.generate_pdf import GeneratePdfTool
from app.chat.tools.web_search import WebSearchTool

# NOTE: ``AttachDemoFileTool`` used to sit between ``EchoTool`` and
# ``GeneratePdfTool``. It was the Phase A1 smoke-test for the
# attachment plumbing and has been retired from the registry because
# models were invoking it for real user requests (e.g. "build me a
# website") — the tool hard-forces a ``.txt`` extension, so HTML ended
# up as an un-previewable text blob. Code output belongs inline as a
# markdown fence (caught by the Code Artifact side panel) and
# documents belong in ``generate_pdf``; there is no longer any user
# need for a generic "attach an arbitrary text file" tool. The class
# is kept in ``attach_demo.py`` purely as reference + in case a future
# test wants to re-register it locally.
REGISTRY: list[Tool] = [
    EchoTool(),
    GeneratePdfTool(),
    GenerateImageTool(),
    WebSearchTool(),
    FetchUrlTool(),
]

# Quick name -> instance lookup so dispatch isn't an O(n) scan over the
# registry on every model-emitted call. Built once at import time and
# kept private so callers go through ``get_tool`` and we have one place
# to add NotFound logging or feature-flag gating later.
_BY_NAME: dict[str, Tool] = {t.name: t for t in REGISTRY}


def get_tool(name: str) -> Tool | None:
    """Return the registered tool with ``name`` or None."""
    return _BY_NAME.get(name)


def list_openai_tools(
    categories: set[str] | None = None,
) -> list[dict[str, Any]]:
    """OpenAI-format ``tools[]`` payload for the requested categories.

    ``categories=None`` returns every registered tool (legacy callers
    + admin / debug paths). The chat router passes a concrete set —
    e.g. ``{"artefact", "search"}`` when both the Tools toggle and
    web-search are on, ``{"search"}`` when search is auto/always but
    artefact tools are off, etc. Categories the model didn't opt into
    are simply not advertised, so it can't call them.
    """
    if categories is None:
        return [t.to_openai_schema() for t in REGISTRY]
    return [
        t.to_openai_schema()
        for t in REGISTRY
        if (getattr(t, "category", "artefact") in categories)
    ]


def tools_in(categories: set[str]) -> list[Tool]:
    """Return registered Tool *instances* for the given categories.

    Used by the tool-aware system prompt builder so it doesn't have to
    re-inspect the OpenAI schema dicts to figure out which prompt
    hints belong on screen this turn.
    """
    return [
        t
        for t in REGISTRY
        if (getattr(t, "category", "artefact") in categories)
    ]


__all__ = ["REGISTRY", "get_tool", "list_openai_tools", "tools_in"]
