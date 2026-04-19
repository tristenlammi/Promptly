"""Shared async Redis client used for streaming state + future ARQ jobs."""
from __future__ import annotations

from redis.asyncio import Redis, from_url

from app.config import get_settings

_settings = get_settings()

# One connection pool shared across the app. `decode_responses=True` gives us
# str in / str out for JSON payloads and pubsub channels.
redis: Redis = from_url(
    _settings.REDIS_URL,
    encoding="utf-8",
    decode_responses=True,
    socket_keepalive=True,
    health_check_interval=30,
)


async def close_redis() -> None:
    """Graceful shutdown hook — called from the FastAPI lifespan."""
    try:
        await redis.aclose()
    except Exception:  # noqa: BLE001 — best-effort shutdown
        pass
