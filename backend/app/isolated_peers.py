"""Refuse requests from the containers that run untrusted input (review M1).

The backend shares an internal network with a container that processes
things nobody vetted: ``convert-net`` with Gotenberg (LibreOffice opening
any uploaded document). uvicorn listens on every interface, so a document
that gets LibreOffice to make a request could call
``http://backend:8000/api/internal/*`` directly, unthrottled, as a
"service call" from a private address.

That service never calls the backend (Gotenberg answers conversions
synchronously, no webhooks), so every request whose socket peer is an
isolated container is refused here, before routing.

The peers are found by name (``ISOLATED_PEER_HOSTS``, default
``convert``) through Docker's DNS, refreshed every few seconds so a
restarted container's new address is picked up. Matching their exact
addresses, rather than the networks' subnets, keeps working on installs
whose networks Docker numbered differently and never catches the backend's
own siblings (the arq worker shares those networks). ``ISOLATED_PEER_CIDRS``
adds address ranges to refuse on top, for setups that pin subnets.

No request waits on DNS. The names are looked up on a background thread
that starts with the app and repeats every few seconds, and a request is
checked against the last answer. Where the converter isn't running the
lookup can take seconds to fail (Docker asks the upstream resolver), and
that used to stall whichever request found the answer out of date. It
fails closed: a slow lookup never erases the addresses already known (they
are replaced only by a lookup that has answered), and until the very first
lookup has answered nothing but the container's own loopback gets through
(a short wait, then 503).
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import threading
import time
import weakref

from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings

logger = logging.getLogger("promptly.isolated_peers")

_REFRESH_S = 5.0
# How long a request waits for the very first lookup before it's turned away.
_FIRST_WAIT_S = 1.0


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
        # Set once a lookup has answered; with no names there's nothing to ask.
        self._known = threading.Event()
        if not self.hosts:
            self._known.set()
        self._thread: threading.Thread | None = None
        self._start = threading.Lock()

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

    def start(self) -> None:
        """Start (or restart) the background lookups. Returns at once."""
        if not self.hosts:
            return
        with self._start:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=_keep_fresh, args=(weakref.ref(self),), name="isolated-peers", daemon=True
            )
            self._thread.start()

    def _refresh(self) -> None:
        # However long this takes, the last answer stands until it returns.
        self._ips = type(self)._lookup(self.hosts)
        self._known.set()

    async def addresses(self) -> frozenset[str] | None:
        """The isolated containers' addresses as last looked up, without
        waiting on DNS. ``None`` when no lookup has answered yet."""
        self.start()
        if not self._known.is_set():
            # Only ever at boot. A moment for the first answer, never the whole lookup.
            until = time.monotonic() + _FIRST_WAIT_S
            while not self._known.is_set() and time.monotonic() < until:
                await asyncio.sleep(0.02)
            if not self._known.is_set():
                return None
        return self._ips

    async def verdict(self, peer: str | None) -> bool | None:
        """True: refuse. False: let through. None: can't say yet (refuse, try again)."""
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
        known = await self.addresses()
        if known is None:
            # Another container is never the loopback (the health check is).
            return False if ip.is_loopback else None
        return str(ip) in known

    async def is_isolated(self, peer: str | None) -> bool:
        """Refuse this peer? Not knowing yet counts as yes."""
        return await self.verdict(peer) is not False


def _keep_fresh(ref: "weakref.ref[IsolatedPeers]") -> None:
    """Look the names up now and every ``_REFRESH_S`` after, for as long as
    the object is in use. Its own thread, so a slow resolver holds up nothing."""
    while True:
        peers = ref()
        if peers is None:
            return
        try:
            peers._refresh()
        except Exception:  # noqa: BLE001 - keep the last answer and try again
            logger.exception("isolated peers: lookup failed")
        del peers
        time.sleep(_REFRESH_S)


def _from_settings() -> IsolatedPeers:
    s = get_settings()
    split = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]  # noqa: E731
    return IsolatedPeers(split(s.ISOLATED_PEER_HOSTS), split(s.ISOLATED_PEER_CIDRS))


class IsolatedPeerMiddleware:
    """403 for any HTTP or WebSocket request from an isolated container."""

    def __init__(self, app: ASGIApp, peers: IsolatedPeers | None = None) -> None:
        self.app = app
        self.peers = peers or _from_settings()
        # Built when the app starts, so the first lookup is done before the first request.
        self.peers.start()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            client = scope.get("client")
            peer = client[0] if client else None
            verdict = await self.peers.verdict(peer)
            if verdict is None:
                # No lookup has answered yet (the first seconds after boot, with a
                # slow resolver): not let through, and not called isolated either.
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1013})
                    return
                await send(
                    {
                        "type": "http.response.start",
                        "status": 503,
                        "headers": [(b"content-type", b"application/json"), (b"retry-after", b"1")],
                    }
                )
                await send({"type": "http.response.body", "body": b'{"detail":"Starting up"}'})
                return
            if verdict:
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
