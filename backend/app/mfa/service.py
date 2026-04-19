"""High-level MFA helpers used by the auth router and the MFA router.

This module is the glue between the per-strategy modules
(``totp``, ``email_otp``, ``backup``, ``trusted``) and the rest of the
app. It owns:

* The single source of truth for "should this login require a second
  factor right now?" (:func:`mfa_decision_for`).
* The atomic "mark MFA enrolled" transition that flips both
  ``users.mfa_enrolled_method`` and ``user_mfa_secrets.enrolled_at``.
* The atomic "disable MFA" transition that wipes secrets + backup
  codes + trusted devices and bumps ``token_version`` to invalidate
  every outstanding session.
"""
from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.mfa import trusted as trusted_devices
from app.mfa.models import (
    METHOD_EMAIL,
    METHOD_TOTP,
    EmailOtpChallenge,
    MfaBackupCode,
    UserMfaSecret,
)


class MfaOutcome(str, enum.Enum):
    """What should happen *after* a successful password check."""

    ALLOW = "allow"
    """Issue real tokens immediately. No second factor required."""

    CHALLENGE = "challenge"
    """User has MFA enrolled. Issue an mfa_challenge token."""

    ENROLLMENT_REQUIRED = "enrollment_required"
    """``app_settings.mfa_required`` is on but the user has no method.
    Issue an mfa_enrollment token and gate the wizard on it."""


@dataclass(slots=True)
class MfaDecision:
    outcome: MfaOutcome
    # Populated only when ``outcome == CHALLENGE`` so the frontend
    # knows which input to show (totp digits vs "check your email").
    challenge_method: str | None = None
    # Populated only when ``outcome == CHALLENGE`` and the user's
    # method is "email" — the address the OTP was/will-be sent to.
    # Trimmed for display ("a***@example.com") at the API edge.
    challenge_email_to: str | None = None


# ---------------------------------------------------------------------
# "Should this login require a second factor?"
# ---------------------------------------------------------------------
async def mfa_decision_for(
    db: AsyncSession,
    *,
    user: User,
    trusted_token: str | None,
) -> MfaDecision:
    """Decide what happens after a successful password check.

    Resolution order:

    1. If the user has MFA enrolled and a valid trusted-device cookie
       matches an active row → ALLOW (skip the second factor).
    2. If the user has MFA enrolled → CHALLENGE.
    3. If ``app_settings.mfa_required`` is True → ENROLLMENT_REQUIRED.
    4. Otherwise → ALLOW.
    """
    if user.has_mfa:
        if trusted_token:
            device = await trusted_devices.lookup_active(
                db, user_id=user.id, plaintext_token=trusted_token
            )
            if device is not None:
                # Touch will be flushed by the caller's commit on the
                # success path. Don't touch here on the rejection path
                # to avoid leaking timing about "is this token valid".
                await trusted_devices.touch(db, device)
                return MfaDecision(outcome=MfaOutcome.ALLOW)

        method = user.mfa_enrolled_method or METHOD_TOTP
        challenge_email = None
        if method == METHOD_EMAIL:
            secret = await get_secret(db, user_id=user.id)
            challenge_email = (secret.email_address if secret else None) or user.email
        return MfaDecision(
            outcome=MfaOutcome.CHALLENGE,
            challenge_method=method,
            challenge_email_to=challenge_email,
        )

    cfg = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if cfg is not None and cfg.mfa_required:
        return MfaDecision(outcome=MfaOutcome.ENROLLMENT_REQUIRED)

    return MfaDecision(outcome=MfaOutcome.ALLOW)


# ---------------------------------------------------------------------
# Secret row CRUD
# ---------------------------------------------------------------------
async def get_secret(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
) -> UserMfaSecret | None:
    return await db.scalar(
        select(UserMfaSecret).where(UserMfaSecret.user_id == user_id)
    )


async def upsert_pending(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    method: str,
    totp_secret_encrypted: str | None = None,
    email_address: str | None = None,
) -> UserMfaSecret:
    """Create or replace the in-progress (unverified) secret row.

    Wipes any prior secret + backup codes for the user — restarting
    enrollment from scratch must never leave an old secret silently
    valid in the DB.
    """
    existing = await get_secret(db, user_id=user_id)
    if existing is not None:
        await db.delete(existing)
        await db.flush()

    # Also flush any prior backup codes so the next enrollment doesn't
    # leave stale unused codes lying around.
    rows = await db.execute(
        select(MfaBackupCode).where(MfaBackupCode.user_id == user_id)
    )
    for row in rows.scalars():
        await db.delete(row)

    row = UserMfaSecret(
        user_id=user_id,
        method=method,
        totp_secret_encrypted=totp_secret_encrypted,
        email_address=email_address,
    )
    db.add(row)
    await db.flush()
    return row


async def mark_enrolled(
    db: AsyncSession,
    *,
    user: User,
    secret: UserMfaSecret,
) -> None:
    """Flip the enrolled bits atomically. Caller commits."""
    now = datetime.now(timezone.utc)
    secret.enrolled_at = now
    secret.last_used_at = now
    user.mfa_enrolled_method = secret.method
    user.mfa_enrolled_at = now


async def disable_for_user(
    db: AsyncSession,
    *,
    user: User,
) -> None:
    """Tear down everything MFA-related for the user.

    Called from POST /auth/mfa/disable. Deletes the secret, every
    backup code, every trusted device, and every pending OTP
    challenge. Bumps ``token_version`` so existing access tokens are
    invalidated immediately — the user will be forced to log in again
    after disabling MFA, which is the safest assumption (someone with
    an active session might not be the legitimate user).

    Caller commits.
    """
    secret = await get_secret(db, user_id=user.id)
    if secret is not None:
        await db.delete(secret)

    rows = await db.execute(
        select(MfaBackupCode).where(MfaBackupCode.user_id == user.id)
    )
    for row in rows.scalars():
        await db.delete(row)

    challenges = await db.execute(
        select(EmailOtpChallenge).where(EmailOtpChallenge.user_id == user.id)
    )
    for row in challenges.scalars():
        await db.delete(row)

    await trusted_devices.revoke_all(db, user_id=user.id)

    user.mfa_enrolled_method = None
    user.mfa_enrolled_at = None
    user.token_version = (user.token_version or 0) + 1


# ---------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------
def mask_email(addr: str) -> str:
    """Mask a mailbox for display (``a*****@example.com``).

    Used when we need to *confirm* an OTP destination to a user who
    isn't yet authenticated — e.g. the login challenge response. We
    leak the first character + the domain so the user can tell which
    inbox to check, but never the full address.
    """
    if "@" not in addr:
        return "***"
    local, domain = addr.split("@", 1)
    if not local:
        return f"***@{domain}"
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}{'*' * max(len(local) - 1, 3)}@{domain}"
