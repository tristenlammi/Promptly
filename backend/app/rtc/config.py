"""The LiveKit key pair and where the LiveKit server is.

Clients always connect to ``/livekit`` on this site (nginx proxies it), so
the only URLs here are the backend's own way in: the API (RoomService) and
the Prometheus metrics port.
"""
from __future__ import annotations

import socket
import time

from app.config import get_settings

# What the browser connects to: same origin, through nginx.
CLIENT_PATH = "/livekit"

_PLACEHOLDER = "change-me"
_resolved: tuple[float, str] | None = None
_RESOLVE_TTL = 60.0


def keys() -> tuple[str, str] | None:
    """(api_key, api_secret), or None when calls aren't set up (missing or
    still the .env.example placeholder)."""
    s = get_settings()
    key, secret = (s.LIVEKIT_API_KEY or "").strip(), (s.LIVEKIT_API_SECRET or "").strip()
    if not key or not secret or key.startswith(_PLACEHOLDER) or secret.startswith(_PLACEHOLDER):
        return None
    return key, secret


def configured() -> bool:
    return keys() is not None


def _host() -> str:
    """``livekit`` when that container is on our network (Docker Desktop,
    test stacks), else the Docker host (Linux: host networking)."""
    global _resolved
    now = time.monotonic()
    if _resolved and now - _resolved[0] < _RESOLVE_TTL:
        return _resolved[1]
    try:
        socket.getaddrinfo("livekit", 7880, proto=socket.IPPROTO_TCP)
        host = "livekit"
    except OSError:
        host = "host.docker.internal"
    _resolved = (now, host)
    return host


def api_url() -> str:
    override = (get_settings().LIVEKIT_API_URL or "").strip().rstrip("/")
    return override or f"http://{_host()}:7880"


def metrics_url() -> str:
    override = (get_settings().LIVEKIT_API_URL or "").strip().rstrip("/")
    port = get_settings().LIVEKIT_METRICS_PORT
    if override:
        # Same host as the API override, LiveKit's metrics port.
        head = override.split("://", 1)
        hostport = head[-1].split("/", 1)[0]
        host = hostport.rsplit(":", 1)[0]
        return f"{head[0]}://{host}:{port}/metrics" if len(head) == 2 else f"http://{host}:{port}/metrics"
    return f"http://{_host()}:{port}/metrics"


def media_ports() -> tuple[int, int]:
    s = get_settings()
    return s.LIVEKIT_UDP_PORT, s.LIVEKIT_TCP_PORT
