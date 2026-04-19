"""Email-delivered one-time passcodes for MFA.

Two purposes share this module:

* ``OTP_PURPOSE_LOGIN``      — second factor during login for users
                                whose enrolled method is "email".
* ``OTP_PURPOSE_ENROLLMENT`` — proves the user can read mail at the
                                address they're trying to enroll.

Codes are 6 digits, sha256-hashed at rest, and capped at
``EmailOtpChallenge.MAX_ATTEMPTS`` wrong guesses each. We also enforce
two anti-abuse limits at issue time:

* A minimum gap between successive sends to the same user
  (``MFA_EMAIL_OTP_MIN_INTERVAL_SECONDS``) — defends against an
  attacker email-bombing an inbox using our SMTP credentials.
* A rolling-hour cap (``MFA_EMAIL_OTP_MAX_PER_HOUR``) — defence in
  depth on the same threat.
"""
from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import request_meta
from app.auth.utils import constant_time_eq, sha256_token
from app.config import get_settings
from app.mfa.models import (
    OTP_PURPOSE_ENROLLMENT,
    OTP_PURPOSE_LOGIN,
    EmailOtpChallenge,
)
from app.mfa.smtp import SmtpNotConfiguredError, render_otp_email, send_message

_settings = get_settings()


class EmailOtpRateLimited(RuntimeError):
    """Raised when ``issue_and_send`` would exceed an anti-abuse cap."""

    def __init__(self, retry_after_seconds: int, reason: str) -> None:
        super().__init__(reason)
        self.retry_after_seconds = retry_after_seconds
        self.reason = reason


@dataclass(slots=True)
class IssueResult:
    """Outcome of a successful ``issue_and_send`` call."""

    challenge_id: uuid.UUID
    expires_at: datetime


def _generate_code() -> str:
    """Six-digit numeric, zero-padded. ``secrets.randbelow`` is the
    correct primitive — ``random.randint`` is not cryptographically
    safe."""
    return f"{secrets.randbelow(1_000_000):06d}"


def _ttl() -> timedelta:
    return timedelta(minutes=_settings.MFA_EMAIL_OTP_TTL_MINUTES)


async def _enforce_rate_limits(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    purpose: str,
) -> None:
    """Raise ``EmailOtpRateLimited`` if the user can't be sent another code yet.

    Two checks:

    1. Cooldown: at most one send per
       ``MFA_EMAIL_OTP_MIN_INTERVAL_SECONDS`` for the same purpose.
    2. Hourly cap: at most ``MFA_EMAIL_OTP_MAX_PER_HOUR`` sends in the
       trailing hour for the same purpose.
    """
    now = datetime.now(timezone.utc)
    one_hour_ago = now - timedelta(hours=1)

    rows = await db.execute(
        select(EmailOtpChallenge)
        .where(
            EmailOtpChallenge.user_id == user_id,
            EmailOtpChallenge.purpose == purpose,
            EmailOtpChallenge.created_at > one_hour_ago,
        )
        .order_by(EmailOtpChallenge.created_at.desc())
    )
    recent = list(rows.scalars().all())

    if recent:
        latest = recent[0]
        gap = (now - latest.created_at).total_seconds()
        cooldown = _settings.MFA_EMAIL_OTP_MIN_INTERVAL_SECONDS
        if gap < cooldown:
            raise EmailOtpRateLimited(
                retry_after_seconds=int(cooldown - gap) + 1,
                reason="cooldown",
            )

    if len(recent) >= _settings.MFA_EMAIL_OTP_MAX_PER_HOUR:
        # Tell the client when the *oldest* counted send falls out of
        # the rolling window — that's when they next get a slot.
        oldest = recent[-1]
        retry = int((oldest.created_at + timedelta(hours=1) - now).total_seconds()) + 1
        raise EmailOtpRateLimited(
            retry_after_seconds=max(retry, 60),
            reason="hourly_cap",
        )


async def issue_and_send(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    to_address: str,
    purpose: str,
    request,
) -> IssueResult:
    """Generate a code, persist its hash, and email it.

    Caller commits.

    Raises
    ------
    EmailOtpRateLimited
        Cooldown or hourly cap hit. ``retry_after_seconds`` is set.
    SmtpNotConfiguredError
        Admin hasn't filled in SMTP yet (re-raised from the smtp module).
    SmtpSendError
        Send failed on the wire.
    """
    if purpose not in (OTP_PURPOSE_LOGIN, OTP_PURPOSE_ENROLLMENT):
        raise ValueError(f"Unknown OTP purpose: {purpose!r}")

    await _enforce_rate_limits(db, user_id=user_id, purpose=purpose)

    code = _generate_code()
    now = datetime.now(timezone.utc)
    expires_at = now + _ttl()
    ip, _ua = request_meta(request)

    challenge = EmailOtpChallenge(
        user_id=user_id,
        code_hash=sha256_token(code),
        purpose=purpose,
        attempts=0,
        expires_at=expires_at,
        ip=ip[:64],
    )
    db.add(challenge)
    # Flush so we have an id before the SMTP round-trip — failure to
    # commit later means the row gets rolled back, but if the SMTP
    # send succeeded the user would still see the email; better to
    # have the row exist and be rolled back together with the send
    # decision than the inverse.
    await db.flush()

    subject, text_body, html_body = render_otp_email(
        code=code,
        purpose=purpose,
        ttl_minutes=_settings.MFA_EMAIL_OTP_TTL_MINUTES,
    )

    # If SMTP isn't configured, ``send_message`` raises
    # ``SmtpNotConfiguredError`` *before* opening any sockets — let it
    # propagate so the admin sees a clean configuration error rather
    # than a silent "code never arrived".
    await send_message(
        db,
        to=to_address,
        subject=subject,
        text_body=text_body,
        html_body=html_body,
    )

    return IssueResult(challenge_id=challenge.id, expires_at=expires_at)


async def verify(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    purpose: str,
    submitted_code: str,
) -> bool:
    """Verify a submitted code against the latest active challenge.

    Caller commits. Returns True on success (and marks the challenge
    consumed). On any failure (no challenge / expired / wrong code /
    too many attempts) returns False. The ``attempts`` counter on the
    matched challenge is bumped on a wrong code so brute force is
    capped.
    """
    submitted = (submitted_code or "").strip()
    if not submitted.isdigit() or len(submitted) != 6:
        return False

    now = datetime.now(timezone.utc)
    challenge = await db.scalar(
        select(EmailOtpChallenge)
        .where(
            EmailOtpChallenge.user_id == user_id,
            EmailOtpChallenge.purpose == purpose,
            EmailOtpChallenge.consumed_at.is_(None),
            EmailOtpChallenge.expires_at > now,
        )
        .order_by(EmailOtpChallenge.created_at.desc())
        .limit(1)
    )
    if challenge is None:
        return False
    if challenge.attempts >= EmailOtpChallenge.MAX_ATTEMPTS:
        return False

    if not constant_time_eq(challenge.code_hash, sha256_token(submitted)):
        challenge.attempts += 1
        return False

    challenge.consumed_at = now
    return True
