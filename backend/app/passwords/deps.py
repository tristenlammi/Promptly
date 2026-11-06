"""Who's asking, for the vault's API.

Two things are needed for anything touching ciphertext:

* a Promptly identity: a bearer JWT on the web, or a device token elsewhere;
* a vault session, issued after proving ``auth_key``.

Not ``get_current_user``: it's bearer-only and blocks on ``must_change_password``.
A temporary password an admin set says nothing about the vault, which has its
own proof.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import _get_singleton_user, _resolve_custom_user
from app.auth.models import User
from app.config import get_settings
from app.database import get_db
from app.logging_setup import bind_user
from app.passwords.models import PwDevice, PwSession, PwSettings

DEVICE_PREFIX = "pwd_"
SESSION_PREFIX = "pws_"
SESSION_IDLE = timedelta(minutes=30)
SESSION_HARD = timedelta(hours=24)
_bearer = HTTPBearer(auto_error=False)

SCOPE_VAULT = "vault"
SCOPE_MAIL_CODES = "mail_codes"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii", "ignore")).hexdigest()


def new_device_token() -> str:
    return DEVICE_PREFIX + secrets.token_urlsafe(36)


def new_session_token() -> str:
    return SESSION_PREFIX + secrets.token_urlsafe(36)


def now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class VaultIdentity:
    user: User
    device: PwDevice | None = None


_DENIED = HTTPException(status.HTTP_401_UNAUTHORIZED, "Session is no longer valid", headers={"WWW-Authenticate": "Bearer"})


async def get_vault_identity(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> VaultIdentity:
    settings = get_settings()
    token = credentials.credentials if credentials else None

    if token and token.startswith(DEVICE_PREFIX):
        device = await db.scalar(select(PwDevice).where(PwDevice.token_hash == hash_token(token)))
        if device is None or device.revoked_at is not None:
            raise _DENIED
        user = await db.get(User, device.user_id)
        # "Sign out everywhere" bumps token_version, and that reaches devices.
        if user is None or user.disabled or device.token_version != user.token_version:
            raise _DENIED
        if not device.last_seen_at or now() - device.last_seen_at > timedelta(minutes=5):
            await db.execute(update(PwDevice).where(PwDevice.id == device.id).values(last_seen_at=now()))
            await db.commit()
        bind_user(user.id)
        request.state.pw_device_id = device.id
        return VaultIdentity(user=user, device=device)

    if settings.SINGLE_USER_MODE:
        single = await _get_singleton_user(db)
        bind_user(single.id)
        return VaultIdentity(user=single)

    user = await _resolve_custom_user(credentials, db)
    bind_user(user.id)
    return VaultIdentity(user=user)


async def get_vault_user(identity: VaultIdentity = Depends(get_vault_identity)) -> VaultIdentity:
    """A device token must hold the ``vault`` scope for this."""
    if identity.device is not None and SCOPE_VAULT not in (identity.device.scopes or []):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This device can't reach the vault.")
    return identity


@dataclass
class VaultSession:
    user: User
    device: PwDevice | None
    session: PwSession


async def require_session(
    identity: VaultIdentity = Depends(get_vault_user),
    x_vault_session: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> VaultSession:
    if not x_vault_session or not x_vault_session.startswith(SESSION_PREFIX):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "vault_locked")
    row = await db.scalar(select(PwSession).where(PwSession.token_hash == hash_token(x_vault_session)))
    current = now()
    if (
        row is None
        or row.user_id != identity.user.id
        or row.revoked_at is not None
        or row.expires_at <= current
        or row.hard_expires_at <= current
        or row.token_version != identity.user.token_version
        # A session issued to a device stays with that device.
        or (row.device_id is not None and (identity.device is None or identity.device.id != row.device_id))
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "vault_locked")
    if row.expires_at - current < SESSION_IDLE - timedelta(minutes=1):
        row.expires_at = min(current + SESSION_IDLE, row.hard_expires_at)
        await db.commit()
    return VaultSession(user=identity.user, device=identity.device, session=row)


async def policy(db: AsyncSession) -> PwSettings:
    row = await db.get(PwSettings, 1)
    if row is None:
        row = PwSettings(id=1, enabled=True, preview_badge=True, min_kdf_m=65536, min_kdf_t=3, max_attachment_mb=500, breach_check=True)
        db.add(row)
        await db.commit()
    return row


async def require_enabled(db: AsyncSession = Depends(get_db)) -> None:
    if not (await policy(db)).enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Passwords is turned off on this server.")


def parse_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from None
