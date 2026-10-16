"""Brute-force protection that can't be turned against the account owner (R-002).

The old lockout counted failures per *account*: five wrong passwords from
anywhere locked the account, and the lock also ended every session the
owner had open. So anyone who knew a username could log the admin out and
keep them out, around the clock.

Now:

* Failures are counted per **account and IP address** (Redis, expiring
  after ``LOCKOUT_COOLDOWN_MINUTES``). Five from one address lock *that
  address* out of *that account* — the owner, elsewhere, is unaffected.
* An **account-wide** lock remains as a backstop for a spray from many
  addresses, at ``ACCOUNT_LOCKOUT_THRESHOLD`` consecutive failures.
* A device the owner already trusted (it passed MFA, "remember this
  device") gets past both locks — it still needs the right password.
* Locks stop new password logins only. They never end a session.
"""
from __future__ import annotations

import uuid

from app.config import get_settings


def _key(user_id: uuid.UUID, ip: str) -> str:
    return f"login_fail:{user_id}:{ip or '-'}"


async def ip_failures(user_id: uuid.UUID, ip: str) -> int:
    from app.redis_client import redis

    try:
        return int(await redis.get(_key(user_id, ip)) or 0)
    except Exception:  # noqa: BLE001 — Redis down: fall back to the account lock
        return 0


async def ip_locked(user_id: uuid.UUID, ip: str) -> bool:
    return await ip_failures(user_id, ip) >= get_settings().LOCKOUT_THRESHOLD


async def record_ip_failure(user_id: uuid.UUID, ip: str) -> int:
    """Count one failure from ``ip``; returns the new count."""
    from app.redis_client import redis

    ttl = max(60, get_settings().LOCKOUT_COOLDOWN_MINUTES * 60)
    try:
        key = _key(user_id, ip)
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, ttl)
        return n
    except Exception:  # noqa: BLE001
        return 0


async def clear(user_id: uuid.UUID, ip: str | None = None) -> None:
    """Forget failures — for one address (a successful login) or all of
    them (an admin unlock)."""
    from app.redis_client import redis

    try:
        if ip is not None:
            await redis.delete(_key(user_id, ip))
            return
        async for k in redis.scan_iter(match=f"login_fail:{user_id}:*"):
            await redis.delete(k)
    except Exception:  # noqa: BLE001
        pass


__all__ = ["clear", "ip_failures", "ip_locked", "record_ip_failure"]
