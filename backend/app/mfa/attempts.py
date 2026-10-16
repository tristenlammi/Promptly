"""A cap on second-factor guesses (R-003).

TOTP verification had no per-user or per-challenge limit — only a per-IP
rate — so anyone holding a leaked password could keep guessing codes, and
one challenge token stayed usable for its full ten minutes. Email codes
already had a 5-attempt cap; this brings TOTP and backup codes in line:

* a challenge is **burned** after ``PER_CHALLENGE`` wrong codes, and after
  it's used successfully (no replay);
* after ``PER_USER`` wrong codes in an hour, second-factor sign-in for that
  account pauses for the rest of the hour and the owner is told.
"""
from __future__ import annotations

import uuid

PER_CHALLENGE = 5
PER_USER = 10
WINDOW_S = 3600
CHALLENGE_TTL_S = 15 * 60


def _jti_key(jti: str) -> str:
    return f"mfa_fail:jti:{jti}"


def _burned_key(jti: str) -> str:
    return f"mfa_burned:{jti}"


def _user_key(user_id: uuid.UUID) -> str:
    return f"mfa_fail:user:{user_id}"


async def _get(key: str) -> int:
    from app.redis_client import redis

    try:
        return int(await redis.get(key) or 0)
    except Exception:  # noqa: BLE001
        return 0


async def blocked_reason(user_id: uuid.UUID, jti: str | None) -> str | None:
    """Why this attempt is refused before even checking the code, or None."""
    if jti and await _get(_burned_key(jti)):
        return "challenge"
    if jti and await _get(_jti_key(jti)) >= PER_CHALLENGE:
        return "challenge"
    if await _get(_user_key(user_id)) >= PER_USER:
        return "user"
    return None


async def record_failure(user_id: uuid.UUID, jti: str | None) -> bool:
    """Count a wrong code. True when this failure just paused the account."""
    from app.redis_client import redis

    try:
        if jti:
            n = int(await redis.incr(_jti_key(jti)))
            if n == 1:
                await redis.expire(_jti_key(jti), CHALLENGE_TTL_S)
        u = int(await redis.incr(_user_key(user_id)))
        if u == 1:
            await redis.expire(_user_key(user_id), WINDOW_S)
        return u == PER_USER
    except Exception:  # noqa: BLE001
        return False


async def record_success(user_id: uuid.UUID, jti: str | None) -> None:
    """Burn the challenge so it can't be replayed; reset the counters."""
    from app.redis_client import redis

    try:
        if jti:
            await redis.set(_burned_key(jti), 1, ex=CHALLENGE_TTL_S)
            await redis.delete(_jti_key(jti))
        await redis.delete(_user_key(user_id))
    except Exception:  # noqa: BLE001
        pass


__all__ = ["PER_CHALLENGE", "PER_USER", "blocked_reason", "record_failure", "record_success"]
