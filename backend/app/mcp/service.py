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
from app.mcp.client import McpError, McpToolFailed, call_tool, fetch_tools, normalise_schema
from app.mcp.models import (
    ConnectorGroup,
    ConnectorUser,
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


def auth_header_value(header_name: str | None, value: str) -> str:
    """Add the ``Bearer`` scheme when the user pasted a bare token.

    Home Assistant, GitHub and most MCP servers want
    ``Authorization: Bearer <token>``, but the thing you copy out of
    their UI is just ``<token>``. Expecting every admin to know they
    must type the word "Bearer" in front of it produces a 401 that reads
    like a bad token — the least diagnosable failure in the whole setup.

    Applied at *send* time rather than on save, so connectors that were
    already saved with a bare token start working without being
    re-entered.

    Only ever touches ``Authorization``: ``X-API-KEY`` and friends take
    a raw value, and prefixing those would break them. A value that
    already contains whitespace is left alone — that's a scheme the user
    supplied deliberately (``Bearer``, ``Basic``, ``Token``…), and
    second-guessing it would be worse than doing nothing.
    """
    if (header_name or "").strip().lower() != "authorization":
        return value
    token = value.strip()
    if not token or " " in token or "	" in token:
        return value
    return f"Bearer {token}"


def _auth_headers(connector: McpConnector) -> dict[str, str]:
    if connector.auth_header_name and connector.auth_value_encrypted:
        try:
            return {
                connector.auth_header_name: auth_header_value(
                    connector.auth_header_name,
                    decrypt_secret(connector.auth_value_encrypted),
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

    SINGLE-TENANT / GLOBAL: connectors are resolved globally — every enabled
    connector reachable by the grant logic is available to the acting user.

    Four ways a connector reaches a turn (OR'd, de-duplicated):

    * ``global`` — available to everyone.
    * ``restricted`` + attached to ``workspace_id`` — context scope.
    * ``restricted`` + granted to a group ``user_id`` belongs to — identity scope.
    * ``restricted`` + granted to ``user_id`` directly — identity scope.
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

        usr_rows = (
            (
                await db.execute(
                    select(McpConnector)
                    .join(
                        ConnectorUser,
                        ConnectorUser.connector_id == McpConnector.id,
                    )
                    .where(
                        McpConnector.enabled.is_(True),
                        McpConnector.availability == "restricted",
                        ConnectorUser.user_id == user_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        for c in usr_rows:
            by_id[c.id] = c

    return list(by_id.values())


def build_tools_from_connectors(
    connectors: list[McpConnector],
    *,
    ask_first: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, tuple[uuid.UUID, str]]]:
    """(OpenAI tool schemas, {advertised_name: (connector_id, real_tool)}).

    Honours each connector's allow-list. Destructive tools are dropped —
    unless ``ask_first``: chat can offer them, because a call there doesn't
    run until the user approves it on an approval card. Automations have
    nobody to ask, so they keep the old behaviour.
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
            destructive = _is_blocked_destructive(tool.get("annotations") or {})
            if destructive and not ask_first:
                continue
            advertised = _safe_tool_name(c.slug, real, taken)
            schemas.append(
                {
                    "type": "function",
                    "function": {
                        "name": advertised,
                        "description": (
                            f"[{c.name}]"
                            + (" (the user approves it before it runs)" if destructive else "")
                            + f" {tool.get('description') or real}"
                        )[:1024],
                        # Normalised here too, for catalogs stored
                        # before refresh started cleaning them (R-160).
                        "parameters": normalise_schema(tool.get("input_schema")),
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


async def authorize_connector_tool(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID | None,
    connector_id: uuid.UUID,
    real_tool: str,
    allow_destructive: bool = False,
) -> McpConnector:
    """The one decision: may *this* user call this tool, right now?

    Chat enforces this by only ever building tools from
    :func:`connectors_for_turn` + the allow-list + the destructive block.
    Anything that calls a connector by stored id (commands, automations,
    device lookups) must come through here instead, or it skips all three
    — which is exactly how a shared command used to let anyone run the
    owner's tool on a connector they had no access to (roadmap R-031).

    ``allow_destructive`` is only for callers that have already put a human
    confirmation in front of the call (a command with "ask before running").
    Raises :class:`McpError` with a user-safe message when refused.
    """
    reachable = await connectors_for_turn(
        db, user_id=user_id, workspace_id=workspace_id
    )
    connector = next((c for c in reachable if c.id == connector_id), None)
    if connector is None:
        existing = await db.get(McpConnector, connector_id)
        if existing is not None and not existing.enabled:
            # Say *why* when it's simply been turned off — that's actionable.
            raise McpError(f"{existing.name} is switched off.")
        raise McpError("That connector isn't available to you.")
    entry = next(
        (t for t in connector.tool_catalog or [] if t.get("name") == real_tool),
        None,
    )
    if entry is None:
        raise McpError(f"{connector.name} doesn't offer a tool called {real_tool!r}.")
    if connector.allowed_tools is not None and real_tool not in connector.allowed_tools:
        raise McpError(f"{real_tool!r} is switched off on {connector.name}.")
    if not allow_destructive and _is_blocked_destructive(entry.get("annotations") or {}):
        raise McpError(
            f"{real_tool!r} can change things, so it needs a command set to "
            "'ask before running'."
        )
    return connector


async def call_connector_tool(
    db: AsyncSession,
    *,
    connector_id: uuid.UUID,
    real_tool: str,
    arguments: dict[str, Any],
    allow_destructive: bool = False,
) -> str:
    """Invoke a tool on its connector. Raises :class:`McpError` on failure.

    Routes by ``kind``: native connectors (UniFi/Omada) hit our first-party
    client; ``mcp`` connectors speak the MCP protocol.

    *Who* may call it is the caller's job (:func:`authorize_connector_tool`
    or a dispatch map built from :func:`connectors_for_turn`). *What* may be
    called is enforced here for every caller: the tool must be in the
    connector's catalog and on its allow-list, and a destructive tool needs
    ``allow_destructive`` (a human confirmed it). The automation MCP step
    once called any tool name its graph JSON contained (R-006).
    """
    connector = await db.get(McpConnector, connector_id)
    if connector is None or not connector.enabled:
        raise McpError("Connector is no longer available.")
    entry = next(
        (t for t in connector.tool_catalog or [] if t.get("name") == real_tool), None
    )
    if entry is None:
        raise McpError(f"{connector.name} doesn't offer a tool called {real_tool!r}.")
    if connector.allowed_tools is not None and real_tool not in connector.allowed_tools:
        raise McpError(f"{real_tool!r} is switched off on {connector.name}.")
    if not allow_destructive and _is_blocked_destructive(entry.get("annotations") or {}):
        raise McpError(f"{real_tool!r} can change things and needs a confirmation to run.")

    try:
        if connector.kind == "unifi":
            from app.mcp.unifi import UniFiError, call_unifi_tool

            try:
                out = await call_unifi_tool(
                    connector.url, _native_api_key(connector), real_tool, arguments
                )
            except UniFiError as e:
                raise McpError(str(e)) from e
        else:
            out = await call_tool(
                connector.url,
                real_tool,
                arguments,
                headers=_auth_headers(connector),
                transport=connector.transport or "http",
            )
    except McpToolFailed:
        # The connector answered; the tool said no. Reachable is healthy.
        await record_health(connector.id, ok=True)
        raise
    except McpError as e:
        await record_health(connector.id, ok=False, error=str(e))
        raise
    await record_health(connector.id, ok=True)
    return out


_TARGET_KEYS = ("name", "entity_id", "area", "device", "target", "room", "query", "path", "repo", "title")


async def describe_call(
    db: AsyncSession, connector_id: uuid.UUID, real_tool: str, arguments: dict[str, Any] | None
) -> dict[str, Any]:
    """What a connector call did, for the chat's activity card (R-166):
    "Home Assistant · Turn off · garage". A call that changes something in
    the outside world is marked so it doesn't read like a lookup."""
    connector = await db.get(McpConnector, connector_id)
    entry = next(
        (t for t in (connector.tool_catalog if connector else None) or [] if t.get("name") == real_tool),
        {},
    )
    ann = entry.get("annotations") or {}
    args = arguments or {}
    target = next(
        (str(args[k]) for k in _TARGET_KEYS if isinstance(args.get(k), (str, int, float)) and str(args[k]).strip()),
        None,
    )
    if target is None:
        target = next((str(v) for v in args.values() if isinstance(v, str) and v.strip()), None)
    return {
        "connector": connector.name if connector else "Connector",
        "tool": real_tool,
        "title": ann.get("title") or re.sub(r"(?<!^)(?=[A-Z])|_", " ", real_tool).strip().capitalize(),
        **({"target": target[:80]} if target else {}),
        # Unannotated tools may change things; only a read-only hint says not.
        "acts": not ann.get("readOnlyHint", False),
        "destructive": _is_blocked_destructive(ann),
    }


# Consecutive transport failures before admins are told (once per streak).
ALERT_AFTER_FAILURES = 3


async def record_health(
    connector_id: uuid.UUID, *, ok: bool, error: str | None = None
) -> None:
    """Stamp a connector's health in its own short session, so callers in
    the middle of a chat stream or command run keep their transaction to
    themselves. Never raises — health is bookkeeping."""
    from app.database import SessionLocal

    try:
        async with SessionLocal() as s:
            c = await s.get(McpConnector, connector_id)
            if c is None:
                return
            now = datetime.now(timezone.utc)
            if ok:
                c.last_ok_at = now
                c.consecutive_failures = 0
                await s.commit()
                return
            c.last_error = (error or "Failed")[:1000]
            c.last_error_at = now
            c.consecutive_failures = (c.consecutive_failures or 0) + 1
            alert = c.consecutive_failures == ALERT_AFTER_FAILURES
            name, cid, last_error = c.name, c.id, c.last_error
            await s.commit()
            if alert:
                await _alert_admins_connector_down(s, name, cid, last_error)
    except Exception:  # noqa: BLE001
        logger.exception("Couldn't record health for connector %s", connector_id)


async def _alert_admins_connector_down(
    db: AsyncSession, name: str, connector_id: uuid.UUID, error: str
) -> None:
    from app.auth.models import User
    from app.notifications.dispatch import notify_user

    admins = (
        await db.execute(
            select(User).where(User.role == "admin", User.disabled.is_(False))
        )
    ).scalars().all()
    for a in admins:
        await notify_user(
            user_id=a.id,
            category="system_alert",
            title=f"Connector “{name}” isn't working",
            body=f"The last {ALERT_AFTER_FAILURES} attempts failed: {error[:300]}",
            url="/admin?tab=connectors",
            tag=f"connector-down-{connector_id}",
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
            await _note_refresh_failure(db, connector, str(e))
            raise McpError(str(e)) from e
        connector.tool_catalog = UNIFI_TOOLS
        connector.tools_refreshed_at = datetime.now(timezone.utc)
        connector.last_ok_at = connector.tools_refreshed_at
        connector.consecutive_failures = 0
        await db.commit()
        return len(UNIFI_TOOLS)

    try:
        tools = await fetch_tools(
            connector.url,
            headers=_auth_headers(connector),
            transport=connector.transport or "http",
        )
    except McpError as e:
        await _note_refresh_failure(db, connector, str(e))
        raise
    connector.tool_catalog = tools
    connector.tools_refreshed_at = datetime.now(timezone.utc)
    connector.last_ok_at = connector.tools_refreshed_at
    connector.consecutive_failures = 0
    await db.commit()
    return len(tools)


async def _note_refresh_failure(
    db: AsyncSession, connector: McpConnector, error: str
) -> None:
    connector.last_error = error[:1000]
    connector.last_error_at = datetime.now(timezone.utc)
    connector.consecutive_failures = (connector.consecutive_failures or 0) + 1
    alert = connector.consecutive_failures == ALERT_AFTER_FAILURES
    await db.commit()
    if alert:
        await _alert_admins_connector_down(
            db, connector.name, connector.id, connector.last_error or error
        )


async def refresh_all_catalogs() -> dict[str, int]:
    """Keep every enabled connector's tool list current (R-160): tools
    added or removed upstream used to stay stale until an admin pressed
    Refresh. Runs on the worker every few hours; failures land in health."""
    from app.database import SessionLocal

    done = {"ok": 0, "failed": 0}
    async with SessionLocal() as db:
        ids = list(
            (
                await db.execute(
                    select(McpConnector.id).where(McpConnector.enabled.is_(True))
                )
            ).scalars()
        )
        for cid in ids:
            c = await db.get(McpConnector, cid)
            if c is None:
                continue
            try:
                await refresh_catalog(db, c)
                done["ok"] += 1
            except McpError:
                done["failed"] += 1
            except Exception:  # noqa: BLE001
                await db.rollback()
                done["failed"] += 1
                logger.exception("catalog refresh crashed for connector %s", cid)
    logger.info("Connector catalog refresh: %s", done)
    return done
