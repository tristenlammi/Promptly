"""Native UniFi connector (Phase 10b) — read-only.

Calls Ubiquiti's official **UniFi Network Integration API** directly (no
container, no MCP server): base ``{console}/proxy/network/integration/v1``,
auth via the read-only ``X-API-KEY`` header. We expose a small, fixed set
of *summarising* read tools (rather than dumping raw JSON) so the model
gets signal, not 3,000 lines — the whole reason we go native here.

Verified surface (UniFi OS 9.3+): ``GET /v1/sites``,
``/v1/sites/{siteId}/clients``, ``/v1/sites/{siteId}/devices``. WAN-event
history isn't in the GA integration API (legacy/cookie-auth) — a later add.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.net.safe_fetch import assert_provider_url_safe

logger = logging.getLogger("promptly.mcp.unifi")

_INTEGRATION_PATH = "/proxy/network/integration/v1"
_TIMEOUT_S = 20
_MAX_ROWS = 60


class UniFiError(RuntimeError):
    """A UniFi API call failed (auth, unreachable, bad response)."""


# Fixed catalog — same shape as a discovered MCP tool so the connector
# machinery (namespacing, allow-list, schemas) treats it uniformly.
UNIFI_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_sites",
        "description": "List the UniFi sites on this controller (id + name). "
        "Use a site id with the other tools; most home setups have one.",
        "input_schema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True, "title": "List UniFi sites"},
    },
    {
        "name": "list_clients",
        "description": "List currently-connected clients with signal, IP, "
        "uplink AP and usage — use to diagnose slow/weak Wi-Fi.",
        "input_schema": {
            "type": "object",
            "properties": {
                "site_id": {
                    "type": "string",
                    "description": "Optional; defaults to the first site.",
                }
            },
        },
        "annotations": {"readOnlyHint": True, "title": "List UniFi clients"},
    },
    {
        "name": "list_devices",
        "description": "List UniFi devices (APs, switches, gateways) with "
        "model, state, firmware and client load.",
        "input_schema": {
            "type": "object",
            "properties": {
                "site_id": {
                    "type": "string",
                    "description": "Optional; defaults to the first site.",
                }
            },
        },
        "annotations": {"readOnlyHint": True, "title": "List UniFi devices"},
    },
]


def _g(obj: dict, *keys: str, default: Any = None) -> Any:
    """First present (non-None) key from ``keys`` — UniFi field names vary
    a little across versions, so we try a few candidates."""
    for k in keys:
        if isinstance(obj, dict) and obj.get(k) is not None:
            return obj[k]
    return default


def _rows(payload: Any) -> list[dict]:
    """Integration API responses are usually ``{data: [...]}`` (paginated);
    tolerate a bare list too."""
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        return []
    if isinstance(payload, list):
        return payload
    return []


async def _get(console_url: str, api_key: str, path: str) -> Any:
    assert_provider_url_safe(console_url)
    base = console_url.rstrip("/") + _INTEGRATION_PATH
    url = base + path
    headers = {"X-API-KEY": api_key, "Accept": "application/json"}
    try:
        # UniFi consoles serve a self-signed cert — verify=False is expected
        # for a LAN appliance the admin explicitly configured.
        async with httpx.AsyncClient(verify=False, timeout=_TIMEOUT_S) as c:
            resp = await c.get(url, headers=headers)
    except httpx.HTTPError as e:
        raise UniFiError(f"Couldn't reach the UniFi controller: {e}") from e
    if resp.status_code == 401 or resp.status_code == 403:
        raise UniFiError("UniFi rejected the API key (401/403).")
    if resp.status_code >= 400:
        raise UniFiError(f"UniFi API error {resp.status_code}.")
    try:
        return resp.json()
    except ValueError as e:
        raise UniFiError("UniFi returned a non-JSON response.") from e


async def _first_site_id(console_url: str, api_key: str) -> str:
    rows = _rows(await _get(console_url, api_key, "/sites"))
    if not rows:
        raise UniFiError("No UniFi sites found on this controller.")
    return str(_g(rows[0], "id", "_id", "name", default=""))


async def probe(console_url: str, api_key: str) -> int:
    """Connection test — returns the site count. Raises UniFiError."""
    return len(_rows(await _get(console_url, api_key, "/sites")))


# --------------------------------------------------------------------
# Tool handlers (return concise text summaries)
# --------------------------------------------------------------------
async def _tool_list_sites(console_url: str, api_key: str, _args: dict) -> str:
    rows = _rows(await _get(console_url, api_key, "/sites"))
    if not rows:
        return "No sites found."
    lines = [
        f"- {_g(s, 'name', default='(unnamed)')} (id: {_g(s, 'id', '_id', default='?')})"
        for s in rows
    ]
    return f"{len(rows)} site(s):\n" + "\n".join(lines)


async def _tool_list_clients(console_url: str, api_key: str, args: dict) -> str:
    site = args.get("site_id") or await _first_site_id(console_url, api_key)
    rows = _rows(await _get(console_url, api_key, f"/sites/{site}/clients"))
    total = len(rows)
    out: list[str] = []
    for c in rows[:_MAX_ROWS]:
        name = _g(c, "name", "hostname", "displayName", "mac", "macAddress", default="?")
        ip = _g(c, "ipAddress", "ip", default="")
        conn = _g(c, "type", "connectionType", default="")
        signal = _g(c, "signal", "rssi", "signalStrength")
        uplink = _g(c, "uplinkDeviceName", "apName", "uplinkMac")
        bits = [str(name)]
        if ip:
            bits.append(str(ip))
        if conn:
            bits.append(str(conn).lower())
        if signal is not None:
            bits.append(f"signal {signal}")
        if uplink:
            bits.append(f"via {uplink}")
        out.append("- " + " · ".join(bits))
    head = f"{total} connected client(s)"
    if total > _MAX_ROWS:
        head += f" (showing first {_MAX_ROWS})"
    return head + ":\n" + "\n".join(out) if out else head + "."


async def _tool_list_devices(console_url: str, api_key: str, args: dict) -> str:
    site = args.get("site_id") or await _first_site_id(console_url, api_key)
    rows = _rows(await _get(console_url, api_key, f"/sites/{site}/devices"))
    out: list[str] = []
    for d in rows[:_MAX_ROWS]:
        name = _g(d, "name", "model", "mac", "macAddress", default="?")
        model = _g(d, "model", default="")
        kind = _g(d, "type", "deviceType", default="")
        state = _g(d, "state", "status", default="")
        fw = _g(d, "firmwareVersion", "version", default="")
        clients = _g(d, "numClients", "clientCount", "numSta")
        bits = [str(name)]
        if model:
            bits.append(str(model))
        if kind:
            bits.append(str(kind).lower())
        if state:
            bits.append(f"state {state}")
        if fw:
            bits.append(f"fw {fw}")
        if clients is not None:
            bits.append(f"{clients} clients")
        out.append("- " + " · ".join(bits))
    return f"{len(rows)} device(s):\n" + "\n".join(out) if out else "No devices found."


_HANDLERS = {
    "list_sites": _tool_list_sites,
    "list_clients": _tool_list_clients,
    "list_devices": _tool_list_devices,
}


async def call_unifi_tool(
    console_url: str, api_key: str, real_tool: str, args: dict
) -> str:
    handler = _HANDLERS.get(real_tool)
    if handler is None:
        raise UniFiError(f"Unknown UniFi tool: {real_tool}")
    return await handler(console_url, api_key, args or {})


__all__ = ["UNIFI_TOOLS", "call_unifi_tool", "probe", "UniFiError"]
