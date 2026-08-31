"""Transport-level MCP client calls (streamable-HTTP and SSE).

Thin wrappers over the official ``mcp`` SDK. Each
call opens a short-lived session (connect → initialize → do → close) — MCP
sessions are cheap and this keeps us stateless, which suits an admin-managed
set of remote servers we poll occasionally + call per tool-use.

Every call is guarded:
* **SSRF** — the URL passes ``assert_provider_url_safe`` before we connect,
  so a connector can't be pointed at an internal/metadata address.
* **Timeout** — a slow/hung server can't stall a chat turn forever.
* **Result cap** — a tool can't dump megabytes into the model's context.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
from typing import Any

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

from app.net.safe_fetch import assert_provider_url_safe

logger = logging.getLogger("promptly.mcp.client")

MCP_TIMEOUT_S = 30
MAX_TOOL_RESULT_CHARS = 20_000


class McpError(RuntimeError):
    """A connector call failed (bad URL, unreachable, protocol error)."""


def _tool_annotations(tool: Any) -> dict[str, Any]:
    """Extract the read-only / destructive hints MCP tools may carry so the
    UI + allow-list logic can reason about safety."""
    ann = getattr(tool, "annotations", None)
    if ann is None:
        return {}
    out: dict[str, Any] = {}
    for key in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
        val = getattr(ann, key, None)
        if val is not None:
            out[key] = val
    title = getattr(ann, "title", None)
    if title:
        out["title"] = title
    return out


# Which wire protocol a server speaks. Streamable-HTTP is the current
# standard and stays the default; SSE is the older transport that plenty
# of real servers still expose — Home Assistant's MCP Server integration
# among them — so supporting both is the difference between "works with
# the servers people actually run" and "works in theory".
TRANSPORTS: tuple[str, ...] = ("http", "sse")


@asynccontextmanager
async def _open(url: str, headers: dict[str, str] | None, transport: str):
    """Open a session against ``url`` using the named transport.

    The two SDK clients have the same shape but different arities
    (streamable-HTTP yields a third element), so this normalises them to
    one ``(read, write)`` contract and everything above stays
    transport-agnostic.
    """
    if transport == "sse":
        async with sse_client(url, headers=headers or {}) as (read, write):
            yield read, write
    else:
        async with streamablehttp_client(url, headers=headers or {}) as (
            read,
            write,
            _,
        ):
            yield read, write


async def fetch_tools(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    transport: str = "http",
) -> list[dict[str, Any]]:
    """Connect and return the server's tool catalog (``tools/list``).

    Each entry: ``{name, description, input_schema, annotations}``. Raises
    :class:`McpError` on any failure — the admin "test connection" path
    surfaces the message.
    """
    assert_provider_url_safe(url)

    async def _do() -> list[dict[str, Any]]:
        async with _open(url, headers, transport) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                return [
                    {
                        "name": t.name,
                        "description": t.description or "",
                        "input_schema": t.inputSchema
                        or {"type": "object", "properties": {}},
                        "annotations": _tool_annotations(t),
                    }
                    for t in result.tools
                ]

    try:
        return await asyncio.wait_for(_do(), timeout=MCP_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise McpError(f"Timed out connecting to {url}") from e
    except McpError:
        raise
    except Exception as e:  # noqa: BLE001 — surface a clean message to the admin
        raise McpError(f"Couldn't list tools: {e}") from e


async def call_tool(
    url: str,
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    headers: dict[str, str] | None = None,
    transport: str = "http",
) -> str:
    """Invoke ``name`` on the server and return a text result (capped).

    Non-text content blocks are summarised by type. ``isError`` results are
    prefixed so the model knows the tool failed. Raises :class:`McpError`
    on transport failure (the chat router turns that into a tool error).
    """
    assert_provider_url_safe(url)

    async def _do() -> str:
        async with _open(url, headers, transport) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments or {})
                return _extract_text(result)

    try:
        return await asyncio.wait_for(_do(), timeout=MCP_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise McpError(f"Tool '{name}' timed out") from e
    except McpError:
        raise
    except Exception as e:  # noqa: BLE001
        raise McpError(f"Tool '{name}' failed: {e}") from e


def _extract_text(result: Any) -> str:
    parts: list[str] = []
    for block in getattr(result, "content", None) or []:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
        else:
            parts.append(f"[{getattr(block, 'type', 'content')} block]")
    text = "\n".join(parts).strip() or "(tool returned no content)"
    if getattr(result, "isError", False):
        text = "The tool reported an error:\n" + text
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = text[:MAX_TOOL_RESULT_CHARS] + "\n…[truncated]"
    return text


__all__ = ["fetch_tools", "call_tool", "McpError", "MAX_TOOL_RESULT_CHARS"]
