"""Basic auth with app passwords, for devices (WP-8.3).

WebDAV (WP-8.4) and resumable uploads accept ``Authorization: Basic`` with
an app password. Wrong attempts count against the same per-IP limit as
password sign-ins (``RATE_LIMIT_LOGIN``) — only the failures, so a phone
syncing a thousand photos isn't throttled by its own success.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.app_passwords import AppPasswordRejected, authenticate, parse_basic

REALM = 'Basic realm="Promptly", charset="UTF-8"'
_BUCKET = "app_password_fail"


def challenge(detail: str = "Sign in with an app password from Settings → Devices.") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": REALM})


async def _too_many(ip: str) -> bool:
    from app import rate_limit

    if not rate_limit._settings.RATE_LIMIT_ENABLED:
        return False
    return not await rate_limit._limiter.test(rate_limit._LIMIT_LOGIN, _BUCKET, ip)


async def _note_failure(ip: str) -> None:
    from app import rate_limit

    if rate_limit._settings.RATE_LIMIT_ENABLED:
        await rate_limit._limiter.hit(rate_limit._LIMIT_LOGIN, _BUCKET, ip)


async def user_from_basic(db: AsyncSession, authorization: str | None, *, scope: str, ip: str):
    """The user behind a Basic header with an app password allowed
    ``scope`` — or 401 (with a Basic challenge), 403 for a missing scope,
    429 after too many wrong ones from this address."""
    from app.auth.audit import record_event, safe_dict
    from app.auth.events import EVENT_APP_PASSWORD_FAILED

    creds = parse_basic(authorization)
    if creds is None:
        raise challenge()
    if await _too_many(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many wrong sign-ins. Wait a minute and try again.",
            headers={"Retry-After": "60"},
        )
    try:
        user, row = await authenticate(db, creds[0], creds[1], scope=scope, ip=ip)
    except AppPasswordRejected as e:
        if e.forbidden:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from None
        await _note_failure(ip)
        try:
            await record_event(db, request=None, ip=ip, user_agent="", event_type=EVENT_APP_PASSWORD_FAILED,
                               user_id=None, identifier=(creds[0] or "")[:120], detail=safe_dict({"reason": str(e)}))
            await db.commit()
        except Exception:  # noqa: BLE001 — the audit row must never change the answer
            pass
        raise challenge(str(e)) from None
    # What this device changes is counted as its own (the mass-delete guard,
    # "restore everything this device deleted").
    from app.auth.credential import set_credential

    set_credential(f"app_password:{row.id}")
    return user


def client_ip(request: Request) -> str:
    from app.rate_limit import _client_ip

    return _client_ip(request)


__all__ = ["REALM", "challenge", "client_ip", "user_from_basic"]
