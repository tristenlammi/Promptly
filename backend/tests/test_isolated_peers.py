"""Requests from the isolated (converter) container never reach a route (M1)."""
from __future__ import annotations

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


def test_the_backend_has_it_outermost():
    from app.main import app

    assert any(m.cls is IsolatedPeerMiddleware for m in app.user_middleware)
    assert app.user_middleware[0].cls is IsolatedPeerMiddleware
