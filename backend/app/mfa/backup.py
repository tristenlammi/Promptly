"""One-shot backup-code generation, hashing, and verification.

Format: ``XXXX-XXXX`` where each ``X`` is uppercase alphanumeric drawn
from a set that excludes the visually ambiguous characters ``0/O`` and
``1/I/L``. 8 random chars × log2(32) ≈ 40 bits of entropy per code,
with bcrypt at rest — comfortably out of reach of any practical
brute-force.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import ahash_password, averify_password
from app.config import get_settings
from app.mfa.models import MfaBackupCode

_settings = get_settings()

# Excludes 0/O and 1/I/L — copying codes off a screen is one of the
# usability bottlenecks of MFA and unambiguous glyphs noticeably help.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _gen_one() -> str:
    """One ``XXXX-XXXX`` code."""
    return (
        "".join(secrets.choice(_ALPHABET) for _ in range(4))
        + "-"
        + "".join(secrets.choice(_ALPHABET) for _ in range(4))
    )


def generate_codes(count: int | None = None) -> list[str]:
    """Mint ``count`` (default ``MFA_BACKUP_CODE_COUNT``) plaintext codes.

    The caller is responsible for hashing them before persistence and
    for showing the plaintext to the user *exactly once*.
    """
    n = count or _settings.MFA_BACKUP_CODE_COUNT
    return [_gen_one() for _ in range(n)]


def normalise(code: str) -> str:
    """Strip whitespace + dashes + uppercase, then re-insert the dash.

    Lets users paste ``abcd efgh``, ``abcdefgh``, ``ABCD-EFGH`` etc.
    interchangeably — important on mobile where the dash is two taps
    away on most keyboards.
    """
    cleaned = "".join(ch for ch in code.upper() if ch.isalnum())
    if len(cleaned) != 8:
        return cleaned  # let verify reject malformed input cleanly
    return f"{cleaned[:4]}-{cleaned[4:]}"


async def replace_codes_for_user(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    plaintext_codes: list[str],
) -> None:
    """Atomically swap the user's backup code set.

    Caller commits. Used both at initial enrollment and when the user
    regenerates from settings.
    """
    existing = await db.execute(
        select(MfaBackupCode).where(MfaBackupCode.user_id == user_id)
    )
    for row in existing.scalars().all():
        await db.delete(row)
    for plain in plaintext_codes:
        db.add(
            MfaBackupCode(
                user_id=user_id,
                code_hash=await ahash_password(plain),
                lookup=_lookup(normalise(plain)),
            )
        )


def _lookup(code: str) -> str:
    """Keyed fingerprint of a normalised code. Keyed so a database dump
    alone can't be used to test guesses quickly."""
    import hashlib
    import hmac

    from app.config import get_settings

    key = get_settings().SECRET_KEY.encode()
    return hmac.new(key, f"mfa-backup:{code}".encode(), hashlib.sha256).hexdigest()


async def verify_and_consume(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    submitted: str,
) -> bool:
    """Try ``submitted`` against the user's *unused* codes.

    On success the matching row is marked consumed (``used_at = now()``)
    and the function returns True. Caller commits.

    Performance note: bcrypt verify is intentionally slow, so we stop
    at the first match. Worst case is ``MFA_BACKUP_CODE_COUNT`` (10)
    bcrypt rounds, which is still well under 100ms on a normal CPU.
    """
    candidate = normalise(submitted)
    if len(candidate) != 9 or candidate[4] != "-":
        return False

    # The row this code would be (bcrypt still confirms it), plus any old
    # codes issued before lookups existed, which can only be found by
    # trying each.
    rows = await db.execute(
        select(MfaBackupCode).where(
            MfaBackupCode.user_id == user_id,
            MfaBackupCode.used_at.is_(None),
            (MfaBackupCode.lookup == _lookup(candidate)) | MfaBackupCode.lookup.is_(None),
        )
    )
    for row in rows.scalars():
        if await averify_password(candidate, row.code_hash):
            row.used_at = datetime.now(timezone.utc)
            return True
    return False


async def remaining_count(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
) -> int:
    """How many unused codes the user still has.

    Surfaced in the user's MFA settings page so they can regenerate
    before they run out (otherwise they'd be locked out the next time
    they lost their phone).
    """
    rows = await db.execute(
        select(MfaBackupCode).where(
            MfaBackupCode.user_id == user_id,
            MfaBackupCode.used_at.is_(None),
        )
    )
    return len(rows.scalars().all())
