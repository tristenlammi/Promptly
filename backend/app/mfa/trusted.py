"""Trusted-device cookies that let a known device skip MFA for N days.

Threat model
------------
A trusted-device record is essentially a *long-lived* second factor —
"this browser, on this OS, has been verified". So:

* The plaintext token is 256 bits of random and never travels except as
  an HttpOnly + Secure cookie scoped to ``/api``.
* The DB only stores the sha256 of the token, so a stolen DB dump
  can't be replayed against a live deployment.
* The cookie is bound to ``MFA_TRUSTED_DEVICE_COOKIE_NAME`` and expires
  in lockstep with the DB row at ``MFA_TRUSTED_DEVICE_DAYS``.
* Bumping ``users.token_version`` (admin "log out everywhere", password
  change, MFA reset) does *not* automatically revoke trusted devices —
  that's deliberate, because the user expects "log me out" to mean "kill
  my access tokens". The "Disable MFA" path *does* delete every device
  on its way out, and the user can revoke individual devices from
  settings.

Cookie attributes are driven by the same ``COOKIE_SECURE`` /
``COOKIE_SAMESITE`` settings as the refresh cookie so dev/prod parity
is automatic.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import request_meta
from app.auth.utils import sha256_token
from app.config import get_settings
from app.mfa.models import MfaTrustedDevice

_settings = get_settings()


def _ttl() -> timedelta:
    return timedelta(days=_settings.MFA_TRUSTED_DEVICE_DAYS)


def _max_age_seconds() -> int:
    return _settings.MFA_TRUSTED_DEVICE_DAYS * 24 * 60 * 60


# ---------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------
def set_trusted_cookie(response: Response, plaintext_token: str) -> None:
    """Write the trusted-device cookie. Production-safe defaults."""
    response.set_cookie(
        key=_settings.MFA_TRUSTED_DEVICE_COOKIE_NAME,
        value=plaintext_token,
        max_age=_max_age_seconds(),
        httponly=True,
        secure=_settings.COOKIE_SECURE,
        samesite=_settings.COOKIE_SAMESITE,
        # Scope to /api so it never accompanies an SPA static asset
        # request — there's no JS that needs to read it.
        path="/api",
    )


def clear_trusted_cookie(response: Response) -> None:
    response.delete_cookie(
        key=_settings.MFA_TRUSTED_DEVICE_COOKIE_NAME,
        path="/api",
    )


def cookie_token(request: Request) -> str | None:
    """Return the plaintext trust token from the request cookie, if any."""
    return request.cookies.get(_settings.MFA_TRUSTED_DEVICE_COOKIE_NAME)


# ---------------------------------------------------------------------
# DB operations
# ---------------------------------------------------------------------
async def issue(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    request: Request,
) -> str:
    """Mint a new trust record + return the plaintext token to set as a cookie.

    Caller commits. The plaintext is *never* persisted — only its
    sha256 lives in the DB.
    """
    plaintext = secrets.token_urlsafe(32)
    ip, ua = request_meta(request)
    db.add(
        MfaTrustedDevice(
            user_id=user_id,
            token_hash=sha256_token(plaintext),
            label=ua[:512],
            ip=ip[:64],
            expires_at=datetime.now(timezone.utc) + _ttl(),
        )
    )
    return plaintext


async def lookup_active(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    plaintext_token: str,
) -> MfaTrustedDevice | None:
    """Return the matching, non-expired device row or None."""
    if not plaintext_token:
        return None
    row = await db.scalar(
        select(MfaTrustedDevice).where(
            MfaTrustedDevice.user_id == user_id,
            MfaTrustedDevice.token_hash == sha256_token(plaintext_token),
        )
    )
    if row is None:
        return None
    if row.expires_at <= datetime.now(timezone.utc):
        return None
    return row


async def touch(db: AsyncSession, device: MfaTrustedDevice) -> None:
    """Update ``last_used_at`` to now. Caller commits."""
    device.last_used_at = datetime.now(timezone.utc)


async def list_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
) -> list[MfaTrustedDevice]:
    """All non-expired devices for the user, newest first."""
    now = datetime.now(timezone.utc)
    rows = await db.execute(
        select(MfaTrustedDevice)
        .where(
            MfaTrustedDevice.user_id == user_id,
            MfaTrustedDevice.expires_at > now,
        )
        .order_by(MfaTrustedDevice.created_at.desc())
    )
    return list(rows.scalars().all())


async def revoke(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
) -> bool:
    """Delete a single device row. Returns True if anything was deleted."""
    row = await db.scalar(
        select(MfaTrustedDevice).where(
            MfaTrustedDevice.user_id == user_id,
            MfaTrustedDevice.id == device_id,
        )
    )
    if row is None:
        return False
    await db.delete(row)
    return True


async def revoke_all(db: AsyncSession, *, user_id: uuid.UUID) -> int:
    """Delete every device row for ``user_id``. Returns count deleted."""
    rows = await db.execute(
        select(MfaTrustedDevice).where(MfaTrustedDevice.user_id == user_id)
    )
    devices = list(rows.scalars().all())
    for row in devices:
        await db.delete(row)
    return len(devices)
