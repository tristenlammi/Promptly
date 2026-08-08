"""In-process runtime metrics.

Promptly had no metrics of any kind — no Prometheus, no OpenTelemetry, no
statsd. That was survivable until several resource-starvation bugs turned up
in quick succession (a pooled DB connection held for a whole generation,
100 MB uploads blocking the event loop, background tasks being collected
mid-flight). Each of those was fixed blind: there was no way to confirm the
fix held in production, or to notice the next one before users did.

The questions this exists to answer are narrow and specific:

* How close is the DB pool to its ceiling? (``pool_size + max_overflow`` = 30)
* How many generations are in flight right now?
* Is the event loop being blocked?
* How many requests are failing, and how slow is the slow tail?
* Is memory climbing?

Deliberately **not** a Prometheus dependency. This is a single-box,
self-hosted app whose operator is an admin looking at a settings page, not an
SRE with Grafana — so the numbers are collected in-process and rendered in the
admin panel. A scrape endpoint can be layered on later without changing any of
the collection below.

Everything here is cheap and bounded: counters are plain ints, latency is a
fixed-size ring buffer. Nothing is persisted — a restart resets the window,
which is the honest behaviour for a process-local view.
"""
from __future__ import annotations

import time
from collections import deque
from threading import Lock
from typing import Any

# Rolling window of request latencies (milliseconds). 1024 samples is enough
# for a stable p95/p99 on a small instance while staying trivially bounded —
# at ~8 bytes per entry this is single-digit KB.
_LATENCY_WINDOW = 1024

_lock = Lock()
_latencies: deque[int] = deque(maxlen=_LATENCY_WINDOW)
_requests_total = 0
_requests_by_class: dict[str, int] = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}
_slowest: tuple[int, str] | None = None  # (ms, route)
_started_at = time.time()


def record_request(*, route: str, status_code: int | None, elapsed_ms: int) -> None:
    """Record one completed request. Called from the access-log middleware,
    which already computes the elapsed time — so this adds no extra timing
    work and no second middleware."""
    global _requests_total, _slowest
    with _lock:
        _requests_total += 1
        _latencies.append(elapsed_ms)
        if status_code is None:
            # Client disconnected or the handler died before responding.
            _requests_by_class["5xx"] += 1
        else:
            bucket = f"{status_code // 100}xx"
            if bucket in _requests_by_class:
                _requests_by_class[bucket] += 1
        if _slowest is None or elapsed_ms > _slowest[0]:
            _slowest = (elapsed_ms, route)


def _percentile(sorted_values: list[int], pct: float) -> int:
    if not sorted_values:
        return 0
    # Nearest-rank: simple, no interpolation, and correct for the small
    # sample sizes this window holds.
    k = max(0, min(len(sorted_values) - 1, int(round(pct / 100 * len(sorted_values))) - 1))
    return sorted_values[k]


def _rss_bytes() -> int | None:
    """Resident set size, read from procfs. Returns None off Linux."""
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    # e.g. "VmRSS:    123456 kB"
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _pool_stats() -> dict[str, Any]:
    """DB pool occupancy — the metric behind the outage loop that a reply
    holding a connection for its whole generation used to cause."""
    from app.database import engine

    pool = engine.pool
    try:
        checked_out = pool.checkedout()
        size = pool.size()
        overflow = pool.overflow()
    except Exception:  # noqa: BLE001 — never let a metrics read break the page
        return {"available": False}

    # ``overflow()`` is how many beyond ``size`` are currently open; it goes
    # negative before the pool has filled, so clamp for the ceiling maths.
    max_overflow = getattr(pool, "_max_overflow", 0) or 0
    capacity = size + max_overflow
    return {
        "available": True,
        "checked_out": checked_out,
        "size": size,
        "overflow": max(0, overflow),
        "capacity": capacity,
        "utilisation_pct": round(checked_out / capacity * 100, 1) if capacity else 0.0,
    }


def _stream_stats() -> dict[str, Any]:
    from app.chat import stream_runner

    sessions = list(stream_runner._sessions.values())
    return {
        "active": sum(1 for s in sessions if not s.done),
        "retained": len(sessions),  # includes recently-finished, kept for replay
    }


def snapshot() -> dict[str, Any]:
    """Point-in-time view of everything worth watching."""
    from app.background import pending_count

    with _lock:
        samples = sorted(_latencies)
        total = _requests_total
        by_class = dict(_requests_by_class)
        slowest = _slowest

    return {
        "uptime_seconds": int(time.time() - _started_at),
        "requests": {
            "total": total,
            "by_class": by_class,
            # Error rate over the process lifetime, not the latency window —
            # they answer different questions and conflating them hides
            # a burst that has since stopped.
            "error_rate_pct": (
                round((by_class["5xx"] / total) * 100, 2) if total else 0.0
            ),
        },
        "latency_ms": {
            "samples": len(samples),
            "p50": _percentile(samples, 50),
            "p95": _percentile(samples, 95),
            "p99": _percentile(samples, 99),
            "max": samples[-1] if samples else 0,
            "slowest_route": slowest[1] if slowest else None,
            "slowest_ms": slowest[0] if slowest else 0,
        },
        "db_pool": _pool_stats(),
        "streams": _stream_stats(),
        "background_tasks": pending_count(),
        "memory_rss_bytes": _rss_bytes(),
    }


def reset() -> None:
    """Clear the rolling window (tests)."""
    global _requests_total, _slowest
    with _lock:
        _latencies.clear()
        _requests_total = 0
        for k in _requests_by_class:
            _requests_by_class[k] = 0
        _slowest = None


__all__ = ["record_request", "snapshot", "reset"]
