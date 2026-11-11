"""Requests from the isolated (converter) container never reach a route (M1)."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.isolated_peers import IsolatedPeerMiddleware, IsolatedPeers


async def _ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _client(peers: IsolatedPeers, peer_ip: str) -> httpx.AsyncClient:
    app = IsolatedPeerMiddleware(_ok_app, peers=peers)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(peer_ip, 1234)), base_url="http://backend:8000")


@pytest.fixture
def peers(monkeypatch):
    p = IsolatedPeers(["convert"], ["172.31.250.0/24"])
    monkeypatch.setattr(IsolatedPeers, "_lookup", staticmethod(lambda hosts: frozenset({"172.20.5.2", "172.21.0.3"})))
    return p


async def test_isolated_containers_are_refused(peers):
    for ip in ("172.20.5.2", "172.21.0.3", "172.31.250.9", "::ffff:172.20.5.2"):
        async with _client(peers, ip) as c:
            r = await c.post("/api/internal/tus-hook")
            assert r.status_code == 403, ip


async def test_everyone_else_gets_through(peers):
    for ip in ("172.20.5.9", "127.0.0.1", "192.168.1.20"):
        async with _client(peers, ip) as c:
            assert (await c.get("/api/health")).status_code == 200, ip


async def test_a_slow_lookup_holds_up_no_request_and_forgets_nothing(monkeypatch):
    """Where the converter isn't running the lookup can take seconds to fail.
    No request waits for it, and the addresses already known stay refused."""
    import threading
    import time

    from app import isolated_peers

    monkeypatch.setattr(isolated_peers, "_REFRESH_S", 0.05)
    slow, release, calls = threading.Event(), threading.Event(), []

    def lookup(hosts):
        calls.append(1)
        if len(calls) > 1:
            slow.set()
            release.wait(10)  # the resolver has stopped answering
            return frozenset()
        return frozenset({"172.20.5.2"})

    monkeypatch.setattr(IsolatedPeers, "_lookup", staticmethod(lookup))
    p = IsolatedPeers(["convert"], [])
    try:
        async with _client(p, "172.20.5.2") as c:
            assert (await c.get("/api/health")).status_code == 403
        assert await asyncio.to_thread(slow.wait, 5)  # the next lookup is stuck
        started = time.monotonic()
        async with _client(p, "172.20.5.9") as c:
            assert (await c.get("/api/health")).status_code == 200
        async with _client(p, "172.20.5.2") as c:
            assert (await c.get("/api/health")).status_code == 403  # still refused
        assert time.monotonic() - started < 1.0
    finally:
        release.set()
    # Once it answers "not there", the address is let go.
    for _ in range(100):
        if not await p.is_isolated("172.20.5.2"):
            break
        await asyncio.sleep(0.02)
    assert not await p.is_isolated("172.20.5.2")


async def test_before_the_first_answer_nothing_but_loopback_gets_through(monkeypatch):
    """Fail closed: with no answer yet, a request is turned away after a short
    wait (503, try again) rather than let through or left hanging."""
    import threading
    import time

    from app import isolated_peers

    monkeypatch.setattr(isolated_peers, "_FIRST_WAIT_S", 0.1)
    release = threading.Event()

    def lookup(hosts):
        release.wait(10)
        return frozenset({"172.20.5.2"})

    monkeypatch.setattr(IsolatedPeers, "_lookup", staticmethod(lookup))
    p = IsolatedPeers(["convert"], ["172.31.250.0/24"])
    try:
        started = time.monotonic()
        async with _client(p, "172.20.5.9") as c:
            r = await c.get("/api/health")
            assert r.status_code == 503 and r.headers["retry-after"] == "1"
        async with _client(p, "172.20.5.2") as c:
            assert (await c.get("/api/health")).status_code == 503
        assert await p.is_isolated("172.20.5.2") and await p.is_isolated("172.20.5.9")
        async with _client(p, "172.31.250.9") as c:
            assert (await c.get("/api/health")).status_code == 403  # a pinned range needs no lookup
        async with _client(p, "127.0.0.1") as c:
            assert (await c.get("/api/health")).status_code == 200  # the container's own health check
        assert time.monotonic() - started < 2.0
    finally:
        release.set()
    for _ in range(100):
        if await p.verdict("172.20.5.9") is False:
            break
        await asyncio.sleep(0.02)
    async with _client(p, "172.20.5.9") as c:
        assert (await c.get("/api/health")).status_code == 200
    async with _client(p, "172.20.5.2") as c:
        assert (await c.get("/api/health")).status_code == 403


async def test_no_names_means_no_lookups():
    p = IsolatedPeers([], ["172.31.250.0/24"])
    assert not await p.is_isolated("172.20.5.9") and await p.is_isolated("172.31.250.9")
    assert p._thread is None


def test_the_backend_has_it_outermost():
    from app.main import app

    assert any(m.cls is IsolatedPeerMiddleware for m in app.user_middleware)
    assert app.user_middleware[0].cls is IsolatedPeerMiddleware
