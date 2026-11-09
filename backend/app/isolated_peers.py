"""Refuse requests from the containers that run untrusted input (review M1).

The backend shares two internal networks with containers that process
things nobody vetted: ``sandbox-net`` with the code sandbox (the model's
Python) and ``convert-net`` with Gotenberg (LibreOffice opening any
uploaded document). uvicorn listens on every interface, so code in the
sandbox, or a document that gets LibreOffice to make a request, could call
``http://backend:8000/api/internal/*`` directly, unthrottled, as a
"service call" from a private address.

Neither service ever calls the backend (the sandbox only answers jobs;
Gotenberg answers conversions synchronously, no webhooks), so every request
whose socket peer is one of them is refused here, before routing.

The peers are found by name (``ISOLATED_PEER_HOSTS``, default
``sandbox,convert``) through Docker's DNS, refreshed every few seconds so a
restarted container's new address is picked up. Matching their exact
addresses, rather than the networks' subnets, keeps working on installs
whose networks Docker numbered differently and never catches the backend's
own siblings (the arq worker shares those networks). ``ISOLATED_PEER_CIDRS``
adds address ranges to refuse on top, for setups that pin subnets.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time

from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings

logger = logging.getLogger("promptly.isolated_peers")

_REFRESH_S = 5.0


class IsolatedPeers:
    def __init__(self, hosts: list[str], cidrs: list[str]) -> None:
        self.hosts = [h for h in hosts if h]
        self.nets = []
        for c in cidrs:
            try:
                self.nets.append(ipaddress.ip_network(c, strict=False))
            except ValueError:
                logger.warning("ISOLATED_PEER_CIDRS: ignoring %r", c)
        self._ips: frozenset[str] = frozenset()
        self._at = 0.0
        self._lock = asyncio.Lock()

    @staticmethod
    def _lookup(hosts: list[str]) -> frozenset[str]:
        out: set[str] = set()
        for h in hosts:
            try:
                for info in socket.getaddrinfo(h, None, type=socket.SOCK_STREAM):
                    out.add(str(ipaddress.ip_address(info[4][0])))
            except (OSError, ValueError):
                continue  # not running (or not on a shared network): nothing to refuse
        return frozenset(out)

    async def addresses(self) -> frozenset[str]:
        if time.monotonic() - self._at < _REFRESH_S:
            return self._ips
        async with self._lock:
            if time.monotonic() - self._at >= _REFRESH_S:
                self._ips = await asyncio.to_thread(self._lookup, self.hosts)
                self._at = time.monotonic()
        return self._ips

    async def is_isolated(self, peer: str | None) -> bool:
        if not peer:
            return False
        try:
            ip = ipaddress.ip_address(peer)
        except ValueError:
            return False
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if any(ip in n for n in self.nets):
            return True
        return str(ip) in await self.addresses()


def _from_settings() -> IsolatedPeers:
    s = get_settings()
    split = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]  # noqa: E731
    return IsolatedPeers(split(s.ISOLATED_PEER_HOSTS), split(s.ISOLATED_PEER_CIDRS))


class IsolatedPeerMiddleware:
    """403 for any HTTP or WebSocket request from an isolated container."""

    def __init__(self, app: ASGIApp, peers: IsolatedPeers | None = None) -> None:
        self.app = app
        self.peers = peers or _from_settings()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            client = scope.get("client")
            peer = client[0] if client else None
            if await self.peers.is_isolated(peer):
                logger.warning("refused a request from isolated container %s to %s", peer, scope.get("path"))
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send({"type": "http.response.body", "body": b'{"detail":"Forbidden"}'})
                return
        await self.app(scope, receive, send)
