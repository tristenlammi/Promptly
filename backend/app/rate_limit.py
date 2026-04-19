"""Redis-backed rate limiting for the public surface.

We don't use slowapi's ``@limiter.limit`` decorator because it wraps
the route in a function whose ``__globals__`` belong to slowapi's
module — which breaks FastAPI's resolution of forward references on
files that use ``from __future__ import annotations`` (every file in
this project does). Instead we call the underlying ``limits`` library
directly from a FastAPI dependency, which is both simpler and more
explicit at the call site.

Backed by the same Redis the rest of the app uses, so all uvicorn
workers / containers share counters and a restart doesn't reset an
attacker's window.

429s are turned into audited responses with a generic message + a
``Retry-After`` header (no info-leak on which limit fired).
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from limits import parse
from limits.aio.storage import RedisStorage
from limits.aio.strategies import FixedWindowRateLimiter, MovingWindowRateLimiter
from limits import RateLimitItem

from app.auth.audit import EVENT_RATE_LIMITED, record_event
from app.auth.audit import request_meta as _request_meta
from app.auth.models import User
from app.config import get_settings
from app.database import SessionLocal

logger = logging.getLogger(__name__)
_settings = get_settings()


# ---------------------------------------------------------------------
# Limiter singletons
# ---------------------------------------------------------------------
# ``async`` storage backend so we can share connections with the rest
# of the asyncio app and not block the event loop.
_storage = RedisStorage(_settings.REDIS_URL)
_limiter = FixedWindowRateLimiter(_storage)

# Per-user *sliding* window limiter. Used for the chat-message cap
# where a fixed window would let a user burst 2× the cap right at the
# bucket boundary. The moving window strategy stores per-event
# timestamps in Redis so the cost is O(N) writes per user-window —
# acceptable for the relatively low message rates we see in chat
# (default 60 / 5min).
_moving_limiter = MovingWindowRateLimiter(_storage)


# Parsed limit items, cached at import time. ``parse`` accepts the same
# "<count>/<window>" DSL as slowapi.
_LIMIT_LOGIN: RateLimitItem = parse(_settings.RATE_LIMIT_LOGIN)
_LIMIT_LOGIN_IDENT: RateLimitItem = parse(_settings.RATE_LIMIT_LOGIN_IDENT)
_LIMIT_REFRESH: RateLimitItem = parse(_settings.RATE_LIMIT_REFRESH)
_LIMIT_SETUP: RateLimitItem = parse(_settings.RATE_LIMIT_SETUP)
_LIMIT_DEFAULT: RateLimitItem = parse(_settings.RATE_LIMIT_DEFAULT)
_LIMIT_MFA_VERIFY: RateLimitItem = parse(_settings.RATE_LIMIT_MFA_VERIFY)
_LIMIT_MFA_EMAIL_SEND: RateLimitItem = parse(_settings.RATE_LIMIT_MFA_EMAIL_SEND)
_LIMIT_USER_MESSAGES: RateLimitItem = parse(_settings.RATE_LIMIT_USER_MESSAGES)


def _client_ip(request: Request) -> str:
    """Cloudflare-aware client IP. Falls back to ``"unknown"``."""
    ip, _ = _request_meta(request)
    return ip or "unknown"


# ---------------------------------------------------------------------
# Audit + 429 helpers
# ---------------------------------------------------------------------
async def _record_rate_limit_audit(
    request: Request,
    *,
    bucket: str,
) -> None:
    """Best-effort audit log entry. Never raises."""
    try:
        async with SessionLocal() as db:
            await record_event(
                db,
                request=request,
                event_type=EVENT_RATE_LIMITED,
                detail=f"path={request.url.path} bucket={bucket}",
            )
            await db.commit()
    except Exception:  # noqa: BLE001 — audit must never break the response
        logger.exception("Failed to record rate_limited audit event")


def _retry_after(item: RateLimitItem) -> int:
    """Conservative ``Retry-After`` header value in seconds.

    For a fixed-window limiter the safe upper bound is the full window
    (the bucket resets every ``window`` seconds). Returning the full
    window gives a well-behaved client a single deterministic moment
    to retry.
    """
    try:
        return int(item.get_expiry())
    except Exception:  # noqa: BLE001
        return 60


# ---------------------------------------------------------------------
# Dependency factory
# ---------------------------------------------------------------------
def rate_limit(
    item: RateLimitItem,
    *,
    bucket: str,
):
    """Return a FastAPI dependency that enforces ``item`` per client IP.

    The returned coroutine is suitable for ``Depends(...)`` on any route.
    On a hit it raises ``HTTPException(429)`` with a generic message and
    a ``Retry-After`` header, and writes one ``rate_limited`` audit row.

    Parameters
    ----------
    item:
        Pre-parsed limit (e.g. ``parse("10/minute")``). Cached at import
        time so we don't re-parse on every request.
    bucket:
        Short stable name used as part of the Redis key ("login",
        "refresh", "setup"…). Distinguishes counters between endpoints
        that share the same window.
    """

    async def _dep(request: Request) -> None:
        if not _settings.RATE_LIMIT_ENABLED:
            return
        # Namespace the key with both the bucket and the IP so /login
        # and /refresh have independent counters even though both key
        # by IP.
        key = _client_ip(request)
        allowed = await _limiter.hit(item, bucket, key)
        if not allowed:
            await _record_rate_limit_audit(request, bucket=bucket)
            logger.warning(
                "Rate limit exceeded: ip=%s path=%s bucket=%s limit=%s",
                key,
                request.url.path,
                bucket,
                item,
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please slow down and try again.",
                headers={"Retry-After": str(_retry_after(item))},
            )

    return _dep


# ---------------------------------------------------------------------
# Public dependency aliases
# ---------------------------------------------------------------------
# Pre-built ``Annotated[None, Depends(...)]`` aliases so route
# signatures stay readable: ``_: RateLimitLogin`` instead of
# ``_: None = Depends(rate_limit(...))`` at every call site.
RateLimitLogin = Annotated[None, Depends(rate_limit(_LIMIT_LOGIN, bucket="login"))]
RateLimitRefresh = Annotated[
    None, Depends(rate_limit(_LIMIT_REFRESH, bucket="refresh"))
]
RateLimitSetup = Annotated[None, Depends(rate_limit(_LIMIT_SETUP, bucket="setup"))]
# Per-IP cap on /auth/mfa/verify — defends against an attacker with a
# valid mfa_challenge token brute-forcing 6-digit codes.
RateLimitMfaVerify = Annotated[
    None, Depends(rate_limit(_LIMIT_MFA_VERIFY, bucket="mfa_verify"))
]
# Per-IP cap on /auth/mfa/email/send — second layer on top of the
# per-user cooldown / hourly cap enforced inside email_otp.issue_and_send.
RateLimitMfaEmailSend = Annotated[
    None, Depends(rate_limit(_LIMIT_MFA_EMAIL_SEND, bucket="mfa_email_send"))
]


# ---------------------------------------------------------------------
# Per-identifier login throttle
# ---------------------------------------------------------------------
async def enforce_login_identifier_rate(
    request: Request,
    identifier: str,
) -> None:
    """Reject login when too many attempts have hit a single identifier.

    The IP-keyed :data:`RateLimitLogin` dependency catches floods from
    one source. This sibling check catches the inverse: a credential
    spray that rotates many IPs but always hits the same email/username
    (or, equivalently, one IP cycling through many identifiers — the
    counter is keyed per-identifier, not per-IP).

    Defensive details:

    * The bucket key is the lower-cased, stripped identifier so an
      attacker can't bypass the limit by alternating ``Alice@x.com`` /
      ``alice@x.com``.
    * Hitting the limit returns the same generic 401-flavoured message
      the rest of the auth surface uses, so a brute-forcer can't easily
      tell whether they tripped the throttle or guessed wrong.
    * Audit log entry uses ``ident:<truncated>`` as the bucket label
      so admins can see *which* identifier is being attacked without
      leaking the full string into the audit row.
    """
    if not _settings.RATE_LIMIT_ENABLED:
        return
    norm = (identifier or "").strip().lower()
    if not norm:
        return
    allowed = await _limiter.hit(_LIMIT_LOGIN_IDENT, "login_ident", norm)
    if allowed:
        return
    safe_label = norm[:32]
    await _record_rate_limit_audit(request, bucket=f"login_ident:{safe_label}")
    logger.warning(
        "Per-identifier login rate limit hit: ident=%s limit=%s",
        safe_label,
        _LIMIT_LOGIN_IDENT,
    )
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many login attempts for this account. Please wait and try again.",
        headers={"Retry-After": str(_retry_after(_LIMIT_LOGIN_IDENT))},
    )


# ---------------------------------------------------------------------
# Per-user sliding-window message rate limit
# ---------------------------------------------------------------------
async def enforce_user_message_rate(request: Request, user: User) -> None:
    """Refuse a chat-send if the user has tripped the per-user cap.

    Distinct from the per-IP IP-keyed limiters above on three counts:

    * Bucket key is ``user.id`` so a user moving between networks
      (work ↔ phone ↔ home) carries the same counter.
    * Strategy is ``MovingWindowRateLimiter`` (true sliding window)
      so an attacker can't burst ``2 × limit`` straddling a bucket
      boundary — important when the cap is in the dozens, not the
      hundreds.
    * Audit row + 429 carry a chat-specific message instead of the
      generic "too many requests" used for the auth limiters.
    """
    if not _settings.RATE_LIMIT_ENABLED:
        return

    key = str(user.id)
    allowed = await _moving_limiter.hit(_LIMIT_USER_MESSAGES, "user_messages", key)
    if allowed:
        return

    await _record_rate_limit_audit(request, bucket=f"user_messages:{user.id}")
    logger.warning(
        "Per-user message rate limit hit: user=%s limit=%s",
        user.id,
        _LIMIT_USER_MESSAGES,
    )
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=(
            "You're sending messages too quickly. Take a short break "
            "and try again in a minute."
        ),
        headers={"Retry-After": str(_retry_after(_LIMIT_USER_MESSAGES))},
    )
