"""Runtime metrics collection.

These back the admin health panel, which exists because several
resource-starvation bugs were fixed blind — there was no way to confirm a fix
held, or to notice the next one before users did.

The properties worth pinning are that the numbers are *correct* (a percentile
that lies is worse than no percentile) and that collection is bounded and
can never break a request.
"""
from __future__ import annotations

import pytest

from app.observability import metrics


@pytest.fixture(autouse=True)
def _reset():
    metrics.reset()
    yield
    metrics.reset()


def test_counts_requests_by_status_class():
    metrics.record_request(route="GET /a", status_code=200, elapsed_ms=10)
    metrics.record_request(route="GET /b", status_code=204, elapsed_ms=10)
    metrics.record_request(route="GET /c", status_code=404, elapsed_ms=10)
    metrics.record_request(route="GET /d", status_code=500, elapsed_ms=10)

    snap = metrics.snapshot()

    assert snap["requests"]["total"] == 4
    assert snap["requests"]["by_class"]["2xx"] == 2
    assert snap["requests"]["by_class"]["4xx"] == 1
    assert snap["requests"]["by_class"]["5xx"] == 1
    assert snap["requests"]["error_rate_pct"] == 25.0


def test_missing_status_counts_as_a_failure():
    """No response means the handler died or the client vanished — either
    way it isn't a success, and silently dropping it would flatter the
    error rate."""
    metrics.record_request(route="GET /x", status_code=None, elapsed_ms=5)

    assert metrics.snapshot()["requests"]["by_class"]["5xx"] == 1


def test_percentiles_are_actually_percentiles():
    for i in range(1, 101):  # 1..100 ms
        metrics.record_request(route="GET /x", status_code=200, elapsed_ms=i)

    lat = metrics.snapshot()["latency_ms"]

    assert lat["samples"] == 100
    assert lat["p50"] == 50
    assert lat["p95"] == 95
    assert lat["p99"] == 99
    assert lat["max"] == 100


def test_latency_window_is_bounded():
    """A per-request unbounded list would be a slow memory leak on a
    long-running process."""
    for i in range(metrics._LATENCY_WINDOW * 3):
        metrics.record_request(route="GET /x", status_code=200, elapsed_ms=i)

    snap = metrics.snapshot()

    assert snap["latency_ms"]["samples"] == metrics._LATENCY_WINDOW
    # Totals keep counting even though samples roll over — they answer
    # different questions.
    assert snap["requests"]["total"] == metrics._LATENCY_WINDOW * 3


def test_slowest_route_is_tracked_across_the_whole_run():
    """Deliberately not windowed: "what's the worst thing that happened"
    shouldn't scroll away."""
    metrics.record_request(route="GET /fast", status_code=200, elapsed_ms=5)
    metrics.record_request(route="POST /slow", status_code=200, elapsed_ms=9000)
    metrics.record_request(route="GET /fast", status_code=200, elapsed_ms=5)

    lat = metrics.snapshot()["latency_ms"]

    assert lat["slowest_route"] == "POST /slow"
    assert lat["slowest_ms"] == 9000


def test_empty_state_is_all_zeroes_not_a_crash():
    snap = metrics.snapshot()

    assert snap["requests"]["total"] == 0
    assert snap["requests"]["error_rate_pct"] == 0.0
    assert snap["latency_ms"]["p99"] == 0
    assert snap["latency_ms"]["slowest_route"] is None


def test_snapshot_reports_the_pool_ceiling():
    """The pool ceiling is the number behind the outage loop: exhausting it
    blocked /api/health too, so the container got restarted mid-stream."""
    pool = metrics.snapshot()["db_pool"]

    assert pool["available"] is True
    # pool_size=10 + max_overflow=20
    assert pool["capacity"] == 30
    assert 0 <= pool["utilisation_pct"] <= 100


def test_snapshot_includes_the_live_subsystem_gauges():
    snap = metrics.snapshot()

    assert snap["streams"]["active"] >= 0
    assert snap["background_tasks"] >= 0
    assert snap["uptime_seconds"] >= 0
