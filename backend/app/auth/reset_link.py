"""Single-use password reset links (R-191), shared by "Forgot password"
and an admin's "Email a reset link" (admin privacy AP5, U1).

The link holds a random token; Redis maps its hash to ``user_id:token_version``
for 30 minutes. ``POST /api/auth/reset-password`` spends it. Sent from the
admin side, the admin never learns a working password: only the person
who reads the email can choose one.
"""
from __future__ import annotations

import hashlib
import secrets

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

RESET_TTL_S = 30 * 60


def reset_key(token: str) -> str:
    return "promptly:pw-reset:" + hashlib.sha256(token.encode()).hexdigest()


async def send_reset_link(db: AsyncSession, request: Request, user: User, *, by_admin: bool = False) -> None:
    """Make a link for ``user`` and email it to their current address.

    Raises ``SmtpNotConfiguredError`` / ``SmtpSendError`` (app.mfa.smtp);
    the token is only stored once the email went."""
    from app.mfa.smtp import send_message
    from app.redis_client import redis

    token = secrets.token_urlsafe(32)
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    link = f"{proto}://{host}/reset-password?token={token}"
    if by_admin:
        intro = (
            "An administrator of your Promptly server sent you this link to choose a new "
            "password. Your current password keeps working until you use it."
        )
    else:
        intro = "Someone asked to reset the password for this account."
    await send_message(
        db,
        to=user.email,
        subject="Promptly: reset your password",
        text_body=(
            f"Hi {user.username},\n\n{intro} To choose a new one, open this link within "
            f"30 minutes:\n\n{link}\n\nIf you didn't expect this, you can ignore this email."
        ),
    )
    await redis.set(reset_key(token), f"{user.id}:{user.token_version}", ex=RESET_TTL_S)
