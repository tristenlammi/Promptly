"""Which hosts a credential may be sent to (R-005)."""
from __future__ import annotations

import re

# A hostname, optionally with a leading ``*.`` wildcard. No scheme, port or path.
_HOST_RE = re.compile(r"^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")


def normalise_hosts(raw: list[str]) -> list[str]:
    """Clean an admin-typed list; raises ValueError naming a bad entry."""
    out: list[str] = []
    for item in raw:
        h = (item or "").strip().lower().rstrip(".")
        if not h:
            continue
        h = re.sub(r"^https?://", "", h).split("/")[0].split(":")[0]
        if not _HOST_RE.fullmatch(h):
            raise ValueError(f"{item!r} isn't a host name (like api.github.com or *.example.com)")
        if h not in out:
            out.append(h)
    if len(out) > 20:
        raise ValueError("At most 20 hosts per credential.")
    return out


def host_allowed(host: str, patterns: list[str]) -> bool:
    """Empty list = any host. ``*.example.com`` matches subdomains only."""
    if not patterns:
        return True
    host = (host or "").lower().rstrip(".")
    for p in patterns:
        if p.startswith("*."):
            if host.endswith(p[1:]) and host != p[2:]:
                return True
        elif host == p:
            return True
    return False
