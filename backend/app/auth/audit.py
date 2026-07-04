"""Helpers for writing rows to the ``auth_events`` audit log.

Centralised so:

* Every call site uses the same request-meta extraction (Cloudflare's
  ``CF-Connecting-IP`` header, then ``X-Forwarded-For``, then the
  socket peer) and the same length caps.
* Adding a new event type means importing one constant — no scattered
  ``"login_fail"`` magic strings.
* Tests can monkeypatch ``record_event`` if they don't want noise.

Callers are responsible for committing the surrounding transaction;
this helper only stages the row via ``db.add``. That keeps audit
inserts atomic with the action they describe — a failed commit means
the event never happened *and* never appears in the log.
"""
from __future__ import annotations

import ipaddress
import uuid
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.events import AuthEvent
from app.config import get_settings

# Re-export the canonical event-type constants so callers only need to
# import from one place.
from app.auth.events import (  # noqa: F401
    EVENT_APP_SETTINGS_CHANGED,
    EVENT_BUDGET_EXCEEDED,
    EVENT_DISABLE,
    EVENT_ENABLE,
    EVENT_FILE_UPLOAD_REJECTED,
    EVENT_FORCE_LOGOUT_ALL,
    EVENT_GENERATED_RERENDER_FAILED,
    EVENT_GENERATED_SOURCE_EDITED,
    EVENT_LOCKOUT,
    EVENT_LOGIN_FAIL,
    EVENT_LOGIN_SUCCESS,
    EVENT_LOGOUT,
    EVENT_MFA_BACKUP_USED,
    EVENT_MFA_DEVICE_REVOKED,
    EVENT_MFA_DEVICE_TRUSTED,
    EVENT_MFA_ENROLLED,
    EVENT_MFA_FAIL,
    EVENT_MFA_RESET,
    EVENT_MFA_VERIFIED,
    EVENT_PASSWORD_CHANGE,
    EVENT_PASSWORD_RESET_BY_ADMIN,
    EVENT_RATE_LIMITED,
    EVENT_REFRESH_REJECTED,
    EVENT_SSRF_BLOCKED,
    EVENT_TOKEN_REFRESH,
    EVENT_TOOL_FAILED,
    EVENT_TOOL_INVOKED,
    EVENT_UNLOCK,
)


def _peer_is_trusted_proxy(peer: str) -> bool:
    """True when the socket peer is one of the configured trusted proxies.

    Forwarded client-IP headers are only honoured when the machine that
    actually opened the TCP connection to us is a trusted reverse proxy
    (nginx / a fronting tunnel). A client that reaches the backend directly
    on a public IP is not trusted, so it cannot forge its source IP to
    defeat the per-IP login/MFA rate limiters."""
    if not peer:
        return False
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(ip in net for net in get_settings().trusted_proxy_networks)


def request_meta(request: Request | None) -> tuple[str, str]:
    """Extract (client_ip, user_agent) from a Starlette request.

    Client-IP resolution is **spoof-resistant**: forwarded headers are
    trusted ONLY when ``request.client.host`` (the unspoofable socket peer)
    is a configured trusted proxy (``TRUSTED_PROXY_IPS`` — the private
    docker/nginx range by default). From a trusted proxy the preference is:

      1. ``CF-Connecting-IP`` — set by Cloudflare's tunnel/proxy.
      2. ``X-Real-IP`` — set by our nginx to the connection's ``$remote_addr``.
      3. ``X-Forwarded-For`` (first hop) — fallback.

    From an **untrusted** peer (e.g. someone hitting the backend port
    directly) all forwarded headers are ignored and we use the raw socket
    peer, which a client cannot forge.

    Returns empty strings rather than ``None`` so callers don't need null
    guards before length-capping. Both fields are capped to the column
    widths defined in 0007_security_foundation.
    """
    if request is None:
        return ("", "")

    headers = request.headers
    peer = (request.client.host if request.client else "") or ""
    if _peer_is_trusted_proxy(peer):
        ip = (
            headers.get("CF-Connecting-IP")
            or headers.get("X-Real-IP")
            or headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or peer
            or ""
        )
    else:
        # Untrusted / direct peer — never trust forwarded headers.
        ip = peer
    ua = headers.get("User-Agent", "") or ""
    return (ip[:64], ua[:512])


async def record_event(
    db: AsyncSession,
    *,
    event_type: str,
    request: Request | None = None,
    user_id: uuid.UUID | None = None,
    identifier: str = "",
    detail: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> AuthEvent:
    """Stage an audit event on the current session.

    Caller commits. Pass either ``request`` (preferred — handles header
    extraction) or pre-extracted ``ip`` / ``user_agent`` strings (useful
    for background jobs that don't have a Request object).
    """
    if ip is None or user_agent is None:
        req_ip, req_ua = request_meta(request)
        if ip is None:
            ip = req_ip
        if user_agent is None:
            user_agent = req_ua

    event = AuthEvent(
        user_id=user_id,
        identifier=(identifier or "")[:320],
        ip=(ip or "")[:64],
        user_agent=(user_agent or "")[:512],
        event_type=event_type[:48],
        detail=(detail[:512] if detail else None),
    )
    db.add(event)
    return event


def safe_dict(payload: dict[str, Any], *, redact: tuple[str, ...] = ()) -> str:
    """Serialise a small dict for the ``detail`` column with redaction.

    Used by admin endpoints to record "what changed" without ever
    spilling sensitive fields (passwords, SMTP credentials, MFA
    secrets) into the audit log.
    """
    parts: list[str] = []
    for key, value in payload.items():
        if key in redact:
            parts.append(f"{key}=***")
        else:
            parts.append(f"{key}={value!r}")
    return ", ".join(parts)[:512]
