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
import json
from contextlib import asynccontextmanager
import logging
from typing import Any

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

from app.net.safe_fetch import UnsafeURLError, assert_provider_url_safe

logger = logging.getLogger("promptly.mcp.client")

MCP_TIMEOUT_S = 30
MAX_TOOL_RESULT_CHARS = 20_000


class McpError(RuntimeError):
    """A connector call failed (bad URL, unreachable, protocol error)."""


class McpToolFailed(McpError):
    """The server ran the tool and it reported failure (an ``isError``
    result, or Home Assistant's ``response_type: "error"``). It used to
    come back as ordinary text, so "close the garage" failing in Home
    Assistant still spoke "Garage closed." and logged a green tick (R-130).
    """


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


def describe_error(exc: BaseException) -> str:
    """Flatten an exception into something an admin can act on.

    The MCP SDK runs its transport inside an anyio task group, so any
    real failure — a 404, a 401, a refused connection — comes back
    wrapped as ``ExceptionGroup: unhandled errors in a task group``.
    Printing that verbatim tells the person configuring a connector
    absolutely nothing, which is exactly the moment they most need to
    know whether it was the URL, the token, or the server.

    So: walk the group, keep the leaves, and name their types.
    """
    leaves: list[str] = []

    def _walk(e: BaseException) -> None:
        inner = getattr(e, "exceptions", None)
        if inner:
            for sub in inner:
                _walk(sub)
            return
        # First line only: httpx appends a two-line MDN footer to its
        # status errors, which is noise in a one-line admin message.
        text = str(e).strip().splitlines()[0].strip() if str(e).strip() else ""
        name = type(e).__name__
        leaves.append(f"{name}: {text}" if text else name)

    _walk(exc)
    # De-duplicate while keeping order — a retrying transport often
    # reports the same refusal several times.
    seen: set[str] = set()
    unique = [x for x in leaves if not (x in seen or seen.add(x))]
    return "; ".join(unique[:3]) or type(exc).__name__


def url_problem(exc: UnsafeURLError) -> str:
    """What an admin should do about a refused connector URL. The common
    Home Assistant mistakes (no ``http://``, an unresolvable ``.local``
    name) used to surface as a bare 500 (R-157)."""
    if exc.reason == "bad_scheme":
        return (
            "Use a full address starting with http:// or https:// — for "
            "example http://192.168.1.10:8123/mcp_server/sse."
        )
    if exc.reason == "dns_failure":
        return (
            f"{exc}. The server can't look that name up — if it's a .local "
            "name, use the device's IP address instead."
        )
    return str(exc)


async def check_url(url: str) -> None:
    """Refuse unsafe or unresolvable connector URLs with a usable message.
    The DNS lookup runs off the event loop (one worker serves everyone)."""
    try:
        await asyncio.to_thread(assert_provider_url_safe, url)
    except UnsafeURLError as e:
        raise McpError(url_problem(e)) from e


# Keywords some providers reject in a function schema. A connector's raw
# schema used to go out verbatim, so one oddly-shaped tool could fail every
# Tools-on chat for users on those models (R-160).
_DROP_SCHEMA_KEYS = frozenset({"$schema", "$id", "$comment", "$defs", "definitions"})


def normalise_schema(schema: Any) -> dict[str, Any]:
    """An object schema every provider accepts: local ``$ref``s inlined,
    meta keywords dropped, ``type: object`` with ``properties`` at the top."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    defs = {**(schema.get("definitions") or {}), **(schema.get("$defs") or {})}

    def _walk(node: Any, depth: int) -> Any:
        if depth > 12:
            return {}
        if isinstance(node, list):
            return [_walk(x, depth + 1) for x in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            target = defs.get(ref.rsplit("/", 1)[-1])
            merged = {**(target or {}), **{k: v for k, v in node.items() if k != "$ref"}}
            return _walk(merged, depth + 1)
        return {
            k: _walk(v, depth + 1)
            for k, v in node.items()
            if k not in _DROP_SCHEMA_KEYS and k != "$ref"
        }

    out = _walk(schema, 0)
    out["type"] = "object"
    if not isinstance(out.get("properties"), dict):
        out["properties"] = {}
    return out


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
    await check_url(url)

    async def _do() -> list[dict[str, Any]]:
        async with _open(url, headers, transport) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                # Servers may page their catalog; only page one used to be
                # read (R-160). Bounded so a looping cursor can't hang us.
                tools: list[Any] = []
                cursor: str | None = None
                for _ in range(50):
                    result = (
                        await session.list_tools(cursor)
                        if cursor
                        else await session.list_tools()
                    )
                    tools.extend(result.tools)
                    cursor = getattr(result, "nextCursor", None)
                    if not cursor:
                        break
                return [
                    {
                        "name": t.name,
                        "description": t.description or "",
                        "input_schema": normalise_schema(t.inputSchema),
                        "annotations": _tool_annotations(t),
                    }
                    for t in tools
                ]

    try:
        return await asyncio.wait_for(_do(), timeout=MCP_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise McpError(f"Timed out connecting to {url}") from e
    except McpError:
        raise
    except Exception as e:  # noqa: BLE001 — surface a clean message to the admin
        raise McpError(f"Couldn't list tools — {describe_error(e)}") from e


async def call_tool(
    url: str,
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    headers: dict[str, str] | None = None,
    transport: str = "http",
) -> str:
    """Invoke ``name`` on the server and return a text result (capped).

    Non-text content blocks are summarised by type. Raises
    :class:`McpToolFailed` when the tool reports failure and
    :class:`McpError` on transport failure — every caller (chat, commands,
    automations, Wyoming) treats both as a failed run.
    """
    await check_url(url)

    async def _do() -> str:
        async with _open(url, headers, transport) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments or {})
                text = _extract_text(result)
                if getattr(result, "isError", False) or _reports_error(text):
                    raise McpToolFailed(_failure_message(name, text))
                return text

    try:
        return await asyncio.wait_for(_do(), timeout=MCP_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise McpError(f"Tool '{name}' timed out") from e
    except McpError:
        raise
    except Exception as e:  # noqa: BLE001
        raise McpError(
            f"Tool '{name}' failed — {describe_error(e)}"
        ) from e


def _extract_text(result: Any) -> str:
    parts: list[str] = []
    for block in getattr(result, "content", None) or []:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
        else:
            parts.append(f"[{getattr(block, 'type', 'content')} block]")
    text = "\n".join(parts).strip() or "(tool returned no content)"
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = text[:MAX_TOOL_RESULT_CHARS] + "\n…[truncated]"
    return text


def _reports_error(text: str) -> bool:
    """Home Assistant answers an intent it couldn't carry out with a normal
    result whose JSON says ``"response_type": "error"``."""
    if '"response_type"' not in text:
        return False
    try:
        data = json.loads(text)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("response_type") == "error"


def _failure_message(name: str, text: str) -> str:
    """The tool's own explanation, readable on its own (it's spoken, logged
    in History and shown in chat)."""
    detail: object = text
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            speech = ((data.get("speech") or {}).get("plain") or {}).get("speech")
            detail = speech or (data.get("data") or {}).get("code") or text
    except (ValueError, AttributeError, TypeError):
        pass
    detail = str(detail).strip()
    if len(detail) > 500:
        detail = detail[:500] + "…"
    return f"{name} failed: {detail}" if detail else f"{name} failed."


__all__ = [
    "fetch_tools",
    "call_tool",
    "check_url",
    "normalise_schema",
    "url_problem",
    "McpError",
    "McpToolFailed",
    "MAX_TOOL_RESULT_CHARS",
]
