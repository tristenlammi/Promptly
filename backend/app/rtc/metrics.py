"""LiveKit's own Prometheus counters, read for the Admin > Calls usage card:
bytes sent to people (the home's upload), and when the server started (so
the hourly check knows which public address it learned at start).

Upload is a rate, so each read stores (time, total) in Redis and the next
read divides by the gap.
"""
from __future__ import annotations

import json
import logging
import re
import time

import httpx

from app.rtc import config

logger = logging.getLogger(__name__)

_SAMPLE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.eE+-]+|NaN|[+-]Inf)\s*$")
_KEY = "calls:metrics:last"


def parse(text: str) -> dict[str, list[tuple[dict[str, str], float]]]:
    out: dict[str, list[tuple[dict[str, str], float]]] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = _SAMPLE.match(line.strip())
        if not m:
            continue
        name, labels_raw, value = m.groups()
        labels = dict(re.findall(r'(\w+)="((?:[^"\\]|\\.)*)"', labels_raw or ""))
        try:
            v = float(value)
        except ValueError:
            continue
        out.setdefault(name, []).append((labels, v))
    return out


def bytes_out(samples: dict) -> float | None:
    """Total bytes LiveKit has sent to people since it started."""
    for name in ("livekit_packet_bytes", "livekit_packet_bytes_total", "livekit_node_bytes_total"):
        rows = samples.get(name)
        if rows:
            return sum(v for labels, v in rows if labels.get("direction", labels.get("type", "")) in ("outgoing", "out"))
    return None


async def read() -> dict | None:
    """{"bytes_out", "started_at", "participants"} or None when LiveKit's
    metrics port doesn't answer."""
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(config.metrics_url())
            r.raise_for_status()
    except Exception:  # noqa: BLE001 — the card says "not available"
        return None
    s = parse(r.text)
    started = None
    for name in ("process_start_time_seconds",):
        if s.get(name):
            started = s[name][0][1]
    participants = None
    if s.get("livekit_participant_total"):
        participants = sum(v for _, v in s["livekit_participant_total"])
    return {"bytes_out": bytes_out(s), "started_at": started, "participants": participants}


async def upload_bps(redis, current: dict | None) -> float | None:
    """Bits per second sent since the previous read (None the first time,
    or when LiveKit restarted in between)."""
    if not current or current.get("bytes_out") is None:
        return None
    now = time.time()
    prev = None
    try:
        raw = await redis.get(_KEY)
        prev = json.loads(raw) if raw else None
        await redis.set(_KEY, json.dumps({"t": now, "b": current["bytes_out"]}), ex=3600)
    except Exception:  # noqa: BLE001
        logger.debug("metrics sample not stored", exc_info=True)
    if not prev:
        return None
    dt = now - float(prev["t"])
    db = current["bytes_out"] - float(prev["b"])
    if dt <= 0.5 or db < 0:
        return None
    return db * 8 / dt
