"""DB-aware MCP layer: resolve connectors, build tool schemas, dispatch.

The chat router calls :func:`build_mcp_tools_for_turn` once per turn to get
(a) OpenAI tool schemas to advertise and (b) a dispatch map from the
advertised tool name back to ``(connector_id, real_tool_name)``. Keeping an
explicit map (rather than parsing the namespaced name) means truncation /
sanitisation of long names can't break dispatch.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import decrypt_secret
from app.groups.models import UserGroupMember
from app.mcp.client import McpError, call_tool, fetch_tools
from app.mcp.models import (
    ConnectorGroup,
    McpConnector,
    WorkspaceMcpConnector,
)

logger = logging.getLogger("promptly.mcp.service")

# OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$.
_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]")
_MAX_NAME = 64


def slugify(name: str) -> str:
    """Lowercase, underscores, alnum only — for the tool namespace prefix."""
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")
    return (s or "mcp")[:24]


def _safe_tool_name(slug: str, tool: str, taken: set[str]) -> str:
    raw = f"mcp__{slug}__{tool}"
    name = _NAME_RE.sub("_", raw)[:_MAX_NAME]
    # De-dup within the turn (truncation could collide for very long names).
    base = name
    i = 2
    while name in taken:
        suffix = f"_{i}"
        name = base[: _MAX_NAME - len(suffix)] + suffix
        i += 1
    taken.add(name)
    return name


def _is_blocked_destructive(annotations: dict[str, Any]) -> bool:
    """MVP is read-leaning: a tool the server flags destructive (and not
    read-only) is blocked from the model's tool list."""
    if not annotations:
        return False
    if annotations.get("destructiveHint") is True and not annotations.get(
        "readOnlyHint"
    ):
        return True
    return False


def _auth_headers(connector: McpConnector) -> dict[str, str]:
    if connector.auth_header_name and connector.auth_value_encrypted:
        try:
            return {
                connector.auth_header_name: decrypt_secret(
                    connector.auth_value_encrypted
                )
            }
        except Exception:  # noqa: BLE001 — bad ciphertext shouldn't crash a turn
            logger.warning("mcp: failed decrypting auth for %s", connector.slug)
    return {}


async def connectors_for_turn(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None = None,
    workspace_id: uuid.UUID | None = None,
) -> list[McpConnector]:
    """Enabled connectors available for this turn.

    Three ways a connector reaches a turn (OR'd, de-duplicated):

    * ``global`` — available to everyone, everywhere.
    * ``restricted`` + attached to ``workspace_id`` — context scope: its
      tools appear in chats inside that workspace.
    * ``restricted`` + granted to a group ``user_id`` belongs to — identity
      scope: the member can use its tools in any chat.
    """
    by_id: dict[uuid.UUID, McpConnector] = {}

    rows = (
        (
            await db.execute(
                select(McpConnector).where(
                    McpConnector.enabled.is_(True),
                    McpConnector.availability == "global",
                )
            )
        )
        .scalars()
        .all()
    )
    for c in rows:
        by_id[c.id] = c

    if workspace_id is not None:
        ws_rows = (
            (
                await db.execute(
                    select(McpConnector)
                    .join(
                        WorkspaceMcpConnector,
                        WorkspaceMcpConnector.connector_id == McpConnector.id,
                    )
                    .where(
                        McpConnector.enabled.is_(True),
                        McpConnector.availability == "restricted",
                        WorkspaceMcpConnector.workspace_id == workspace_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        for c in ws_rows:
            by_id[c.id] = c

    if user_id is not None:
        grp_rows = (
            (
                await db.execute(
                    select(McpConnector)
                    .join(
                        ConnectorGroup,
                        ConnectorGroup.connector_id == McpConnector.id,
                    )
                    .join(
                        UserGroupMember,
                        UserGroupMember.group_id == ConnectorGroup.group_id,
                    )
                    .where(
                        McpConnector.enabled.is_(True),
                        McpConnector.availability == "restricted",
                        UserGroupMember.user_id == user_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        for c in grp_rows:
            by_id[c.id] = c

    return list(by_id.values())


def build_tools_from_connectors(
    connectors: list[McpConnector],
) -> tuple[list[dict[str, Any]], dict[str, tuple[uuid.UUID, str]]]:
    """(OpenAI tool schemas, {advertised_name: (connector_id, real_tool)}).

    Honours each connector's allow-list and drops destructive tools (MVP).
    """
    schemas: list[dict[str, Any]] = []
    dispatch: dict[str, tuple[uuid.UUID, str]] = {}
    taken: set[str] = set()

    for c in connectors:
        allow = c.allowed_tools  # None = all; [] = none
        for tool in c.tool_catalog or []:
            real = tool.get("name")
            if not real:
                continue
            if allow is not None and real not in allow:
                continue
            if _is_blocked_destructive(tool.get("annotations") or {}):
                continue
            advertised = _safe_tool_name(c.slug, real, taken)
            schemas.append(
                {
                    "type": "function",
                    "function": {
                        "name": advertised,
                        "description": (
                            f"[{c.name}] {tool.get('description') or real}"
                        )[:1024],
                        "parameters": tool.get("input_schema")
                        or {"type": "object", "properties": {}},
                    },
                }
            )
            dispatch[advertised] = (c.id, real)
    return schemas, dispatch


def _native_api_key(connector: McpConnector) -> str:
    if not connector.auth_value_encrypted:
        return ""
    try:
        return decrypt_secret(connector.auth_value_encrypted)
    except Exception:  # noqa: BLE001
        return ""


async def call_connector_tool(
    db: AsyncSession,
    *,
    connector_id: uuid.UUID,
    real_tool: str,
    arguments: dict[str, Any],
) -> str:
    """Invoke a tool on its connector. Raises :class:`McpError` on failure.

    Routes by ``kind``: native connectors (UniFi/Omada) hit our first-party
    client; ``mcp`` connectors speak the MCP protocol.
    """
    connector = await db.get(McpConnector, connector_id)
    if connector is None or not connector.enabled:
        raise McpError("Connector is no longer available.")

    if connector.kind == "unifi":
        from app.mcp.unifi import UniFiError, call_unifi_tool

        try:
            return await call_unifi_tool(
                connector.url, _native_api_key(connector), real_tool, arguments
            )
        except UniFiError as e:
            raise McpError(str(e)) from e

    return await call_tool(
        connector.url,
        real_tool,
        arguments,
        headers=_auth_headers(connector),
    )


async def refresh_catalog(db: AsyncSession, connector: McpConnector) -> int:
    """Re-fetch + cache the connector's tool catalog. Returns the tool count.
    Raises :class:`McpError` on connection failure.

    Native connectors have a *fixed* catalog — "refresh" just probes the
    appliance to confirm reachability, then stamps the known tool set.
    """
    if connector.kind == "unifi":
        from app.mcp.unifi import UNIFI_TOOLS, UniFiError, probe

        try:
            await probe(connector.url, _native_api_key(connector))
        except UniFiError as e:
            raise McpError(str(e)) from e
        connector.tool_catalog = UNIFI_TOOLS
        connector.tools_refreshed_at = datetime.now(timezone.utc)
        await db.commit()
        return len(UNIFI_TOOLS)

    tools = await fetch_tools(connector.url, headers=_auth_headers(connector))
    connector.tool_catalog = tools
    connector.tools_refreshed_at = datetime.now(timezone.utc)
    await db.commit()
    return len(tools)
