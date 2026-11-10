"""Signed-out sessions end now, not when their access token expires (L3).

Signing out revokes the refresh token, but the access token the browser
held (15 minutes) kept working until it expired: someone who had copied it
stayed in. Signing out now also records the session id (``sid``, carried by
every access and refresh token of one sign-in) in Redis for as long as an
access token can live, and every authenticated request checks it: one
Redis ``EXISTS`` per request.

Redis down: the check fails open, as the refresh-token revocation does,
so an outage doesn't sign everyone out.
"""
from __future__ import annotations

import logging

from app.config import get_settings

logger = logging.getLogger("promptly.auth.revoked_sessions")


def _key(sid: str) -> str:
    return f"promptly:revoked-sid:{sid}"


def _ttl() -> int:
    # The longest an access token from this session can still be presented,
    # plus a margin for clock skew. The refresh side has its own (jti) entry.
    return int(get_settings().ACCESS_TOKEN_TTL_MINUTES) * 60 + 120


async def revoke_session(sid: str | None) -> None:
    if not sid:
        return
    from app.redis_client import redis

    try:
        await redis.set(_key(sid), "1", ex=_ttl())
    except Exception:  # noqa: BLE001 - the cookie is still cleared
        logger.warning("couldn't record a signed-out session id")


async def session_revoked(sid: str | None) -> bool:
    if not sid or not isinstance(sid, str):
        return False
    from app.redis_client import redis

    try:
        return bool(await redis.exists(_key(sid)))
    except Exception:  # noqa: BLE001 - fail open, like the refresh check
        return False
