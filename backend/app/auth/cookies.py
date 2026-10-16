"""Whether auth cookies carry the ``Secure`` flag (R-254).

``COOKIE_SECURE`` used to be a hard ``true`` that ``.env`` couldn't even
reach (the variable wasn't passed into the container). On a plain-HTTP LAN
install — ``http://192.168.1.20:8091``, the common first-run setup — the
browser refuses to store a Secure cookie, so the session was lost on every
reload and every 15 minutes.

``auto`` (the default) leaves ``Secure`` off only for a plain-HTTP request
to a host that can't be a public site: localhost, a private or link-local
IP, or a LAN-style name (``.local``, ``.lan``, ``.home.arpa``, a bare
single-label name). Everything else — any public domain, including one
behind a TLS tunnel, whose scheme nginx can't see — keeps ``Secure``.
``true`` / ``false`` force it either way.
"""
from __future__ import annotations

import ipaddress
from contextvars import ContextVar

from app.config import get_settings

# Host (and scheme) of the request being handled, set by the request
# middleware so cookie-setting code deep in a router needn't pass the
# request down.
_request_host: ContextVar[str | None] = ContextVar("promptly_request_host", default=None)
_request_https: ContextVar[bool] = ContextVar("promptly_request_https", default=False)

_LAN_SUFFIXES = (".localhost", ".local", ".lan", ".home.arpa", ".internal", ".home")


def remember_request(host: str | None, *, https: bool) -> None:
    _request_host.set(host)
    _request_https.set(https)


def _bare_host(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):  # [::1]:8091
        return host[1:].split("]", 1)[0]
    if host.count(":") == 1:
        return host.split(":", 1)[0]
    return host


def is_local_host(host: str | None) -> bool:
    """A host only reachable on a private network (or this machine)."""
    if not host:
        return False
    name = _bare_host(host)
    if name == "localhost" or name.endswith(_LAN_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        # No dot: a bare machine name ("nas", "promptly") — LAN-only.
        return "." not in name
    return is_local_ip(ip)


# Explicit ranges: ``ip.is_private`` also covers documentation and other
# special-purpose blocks that aren't anyone's LAN. 100.64/10 (carrier-grade
# NAT) is where Tailscale puts devices — a tailnet is a private network.
_LOCAL_NETS = [
    ipaddress.ip_network(n)
    for n in (
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
        "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10",
    )
]


def is_local_ip(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address | str") -> bool:
    try:
        addr = ipaddress.ip_address(ip) if isinstance(ip, str) else ip
    except ValueError:
        return False
    if getattr(addr, "ipv4_mapped", None):
        addr = addr.ipv4_mapped
    return any(addr in net for net in _LOCAL_NETS if net.version == addr.version)


def cookie_secure() -> bool:
    mode = str(get_settings().COOKIE_SECURE).strip().lower()
    if mode in ("true", "1", "yes", "on"):
        return True
    if mode in ("false", "0", "no", "off"):
        return False
    # auto
    if _request_https.get():
        return True
    return not is_local_host(_request_host.get())
