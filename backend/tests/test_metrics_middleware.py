"""The access-log middleware must actually feed the metrics window.

Unit-testing ``record_request`` only proves the collector works — not that
anything calls it. That wiring is a lazy import inside the middleware's
``finally`` block, which is exactly the kind of thing that silently stops
working after a refactor and leaves a health panel confidently reporting
zero traffic forever.

So this drives the real ``RequestContextMiddleware`` over a real ASGI app.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.logging_setup import RequestContextMiddleware
from app.observability import metrics


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/api/ok")
    async def ok() -> dict:
        return {"ok": True}

    @app.get("/api/boom")
    async def boom() -> dict:
        raise ValueError("intentional")

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok"}

    metrics.reset()
    yield TestClient(app, raise_server_exceptions=False)
    metrics.reset()


def test_successful_request_is_recorded(client):
    client.get("/api/ok")

    snap = metrics.snapshot()
    assert snap["requests"]["total"] == 1
    assert snap["requests"]["by_class"]["2xx"] == 1
    assert snap["latency_ms"]["samples"] == 1


def test_failing_request_is_recorded_as_an_error(client):
    client.get("/api/boom")

    snap = metrics.snapshot()
    assert snap["requests"]["total"] == 1
    assert snap["requests"]["by_class"]["5xx"] == 1


def test_health_probe_is_excluded(client):
    """The container health check runs every few seconds; counting it would
    swamp the real traffic stats and make the error rate meaningless."""
    client.get("/api/health")

    assert metrics.snapshot()["requests"]["total"] == 0


def test_metrics_failure_cannot_break_a_request(client, monkeypatch):
    """Metrics are diagnostics — they must never be able to take down the
    thing they're measuring."""

    def explode(**_kwargs):
        raise RuntimeError("metrics backend on fire")

    monkeypatch.setattr(metrics, "record_request", explode)

    response = client.get("/api/ok")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
