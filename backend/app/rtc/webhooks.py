"""LiveKit's webhooks: signed with our API secret (a JWT carrying the body's
SHA-256), verified here, then handed to whichever feature owns the room's
name prefix (``app.rtc.names``).

Features register with ``@on("v_")``; a handler gets the parsed
``livekit.api.WebhookEvent``. Every verified webhook also stamps "last
heard from LiveKit" (the checklist's "Webhooks arriving") and adds finished
time in voice to the daily usage minutes.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable

from livekit import api

from app.rtc import config, names

logger = logging.getLogger(__name__)

Handler = Callable[[api.WebhookEvent], Awaitable[None]]
_handlers: dict[str, list[Handler]] = {}

LAST_KEY = "calls:webhook:last"
USAGE_KEY = "calls:usage:seconds:{day}"  # per UTC day, kept 40 days


class BadSignature(Exception):
    pass


def on(prefix: str) -> Callable[[Handler], Handler]:
    if prefix not in names.PREFIXES:
        raise ValueError(f"unregistered LiveKit room prefix {prefix!r}")

    def deco(fn: Handler) -> Handler:
        _handlers.setdefault(prefix, []).append(fn)
        return fn

    return deco


def verify(body: str, auth_header: str | None) -> api.WebhookEvent:
    pair = config.keys()
    if pair is None or not auth_header:
        raise BadSignature("no key pair or no signature")
    token = auth_header.split(" ", 1)[1] if auth_header.lower().startswith("bearer ") else auth_header
    try:
        return api.WebhookReceiver(api.TokenVerifier(*pair)).receive(body, token)
    except Exception as exc:  # noqa: BLE001 — any failure is a refusal
        raise BadSignature(str(exc)) from exc


async def handle(event: api.WebhookEvent, redis) -> None:
    try:
        await redis.set(LAST_KEY, str(time.time()), ex=40 * 86400)
    except Exception:  # noqa: BLE001
        logger.debug("couldn't stamp webhook time", exc_info=True)
    room = event.room.name if event.HasField("room") else ""
    prefix = names.prefix_of(room) if room else None
    if event.event == "participant_left" and prefix in names.USAGE_PREFIXES:
        await _add_usage(event, redis)
    for fn in _handlers.get(prefix or "", []):
        try:
            await fn(event)
        except Exception:  # noqa: BLE001 — one feature's bug mustn't drop the rest
            logger.exception("webhook handler %s failed for %s", getattr(fn, "__name__", fn), event.event)


async def _add_usage(event: api.WebhookEvent, redis) -> None:
    p = event.participant
    joined = p.joined_at_ms / 1000 if p.joined_at_ms else float(p.joined_at or 0)
    left = float(event.created_at or time.time())
    if not joined or left <= joined:
        return
    seconds = min(left - joined, 24 * 3600)
    day = datetime.fromtimestamp(left, tz=timezone.utc).strftime("%Y%m%d")
    key = USAGE_KEY.format(day=day)
    try:
        await redis.incrbyfloat(key, seconds)
        await redis.expire(key, 40 * 86400)
    except Exception:  # noqa: BLE001
        logger.debug("usage not counted", exc_info=True)


async def last_heard(redis) -> float | None:
    try:
        raw = await redis.get(LAST_KEY)
        return float(raw) if raw else None
    except Exception:  # noqa: BLE001
        return None


async def minutes_last_days(redis, days: int = 30) -> int:
    now = datetime.now(timezone.utc)
    keys = [USAGE_KEY.format(day=datetime.fromtimestamp(now.timestamp() - d * 86400, tz=timezone.utc).strftime("%Y%m%d")) for d in range(days)]
    try:
        vals = await redis.mget(keys)
    except Exception:  # noqa: BLE001
        return 0
    return int(sum(float(v) for v in vals if v) // 60)
