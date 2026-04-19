"""FastAPI dependencies for auth.

`get_current_user` is the single dependency every protected route should use.
It also handles `SINGLE_USER_MODE`: when enabled, we skip JWT validation and
always return the auto-provisioned singleton user.
"""
from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import TokenError, decode_token
from app.config import get_settings
from app.database import get_db
from app.logging_setup import bind_user

settings = get_settings()

# Uses example.com (IANA-reserved for documentation/testing) so EmailStr
# validation passes without any network lookup tricks.
SINGLE_USER_EMAIL = "local@example.com"
SINGLE_USER_USERNAME = "local"

# auto_error=False so we can raise our own 401s with consistent shape,
# and so SINGLE_USER_MODE can bypass the header requirement entirely.
_bearer = HTTPBearer(auto_error=False)


async def _get_singleton_user(db: AsyncSession) -> User:
    """Fetch (or 500) the provisioned single-user account."""
    result = await db.execute(select(User).where(User.username == SINGLE_USER_USERNAME))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "SINGLE_USER_MODE is on but the singleton user has not been "
                "provisioned. The app should create it on startup."
            ),
        )
    return user


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if settings.SINGLE_USER_MODE:
        single = await _get_singleton_user(db)
        bind_user(single.id)
        return single

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_token(credentials.credentials, expected_type="access")
    except TokenError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        ) from e

    try:
        user_id = uuid.UUID(payload["sub"])
    except (ValueError, KeyError) as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
        ) from e

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists",
        )

    # ----------------------------------------------------------------
    # Token revocation enforcement (added in Phase 1).
    #
    # Three conditions invalidate an otherwise-valid JWT *immediately*,
    # without waiting for the access token to expire:
    #
    #   1. The user has been hard-disabled by an admin.
    #   2. The user has been locked out (failed-login threshold or
    #      explicit admin lock).
    #   3. The token's ``tv`` claim no longer matches the user's
    #      ``token_version`` — happens after a password change, MFA
    #      reset, or "log me out everywhere".
    #
    # All three return the same generic 401 so the response gives no
    # signal about *why* the session was killed.
    # ----------------------------------------------------------------
    if user.disabled or user.is_locked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is no longer valid",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token_tv = payload.get("tv", 0)
    if int(token_tv) != int(user.token_version):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is no longer valid",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Attach to request.state for cheap reuse by other dependencies/middleware.
    request.state.user = user
    # Bind user id to the contextvars used by the JSON logger so any
    # log line emitted further down the stack carries it.
    bind_user(user.id)
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """Dependency that rejects non-admin callers with 403.

    Intended for admin-only routes (user management, provider CRUD).
    """
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return user
