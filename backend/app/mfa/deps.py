"""FastAPI dependencies for the MFA router.

Two non-standard auth modes live here:

* :func:`get_user_from_challenge_token` — accepts the short-lived
  ``mfa_challenge`` JWT issued by /auth/login when the user has MFA
  enrolled. Used by /auth/mfa/verify and /auth/mfa/email/send.
* :func:`get_user_from_enrollment_token` — accepts the short-lived
  ``mfa_enrollment`` JWT issued by /auth/login when the user lacks MFA
  but ``app_settings.mfa_required`` is on. Used by /auth/mfa/setup/*.

Both reject disabled / locked users and verify the ``tv`` (token
version) claim, just like ``get_current_user``.
"""
from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import TokenError, decode_token
from app.database import get_db

_bearer = HTTPBearer(auto_error=False)


async def _user_from_typed_token(
    *,
    expected_type: str,
    credentials: HTTPAuthorizationCredentials | None,
    db: AsyncSession,
) -> User:
    """Shared body for both challenge / enrollment dependencies.

    Returns 401 with the same generic detail for every failure mode so
    a caller can't tell *why* the token was rejected.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_token(credentials.credentials, expected_type=expected_type)  # type: ignore[arg-type]
    except TokenError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from e

    try:
        user_id = uuid.UUID(payload["sub"])
    except (ValueError, KeyError) as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from e

    user = await db.get(User, user_id)
    if user is None or user.disabled or user.is_locked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    if int(payload.get("tv", 0)) != int(user.token_version):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    return user


async def get_user_from_challenge_token(
    request: Request,  # noqa: ARG001 — kept for parity with get_current_user
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    return await _user_from_typed_token(
        expected_type="mfa_challenge",
        credentials=credentials,
        db=db,
    )


async def get_user_from_enrollment_token(
    request: Request,  # noqa: ARG001
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    return await _user_from_typed_token(
        expected_type="mfa_enrollment",
        credentials=credentials,
        db=db,
    )
