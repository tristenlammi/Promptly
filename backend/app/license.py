"""Self-host licensing (custom-auth path only).

Self-host is **free and unlimited by default** (``LICENSE_ENFORCED=false``) —
add as many accounts as you like, no license. Seat-limited licensing is an
**opt-in** capability for a commercial self-host offering: flip
``LICENSE_ENFORCED`` on and the instance enforces a free-tier/license seat cap.

When enforced, self-host is free for a single seat and a paid, **seat-tied**
license unlocks more accounts. Licenses are **offline-signed** (Ed25519): the
issuer (you) signs a tiny JSON payload with a private key; every instance
verifies it with the baked-in public key — no phone-home, works air-gapped.

License token format (compact, self-contained)::

    <base64url(payload_json)>.<base64url(ed25519_signature_over_the_payload_b64)>

Payload::

    {"v": 1, "customer": "Acme", "seats": 20, "tier": "self-host",
     "iat": <unix>, "exp": <unix>}   # omit/large exp for a perpetual license

Enforcement is deliberately gentle (honor-system-with-friction — this is your
source, in Python): the license gates *adding* accounts, never disables people.
An expired license keeps its seats during a grace window, then the instance
drops back to the free tier **for growth only** — existing users keep working.

Only meaningful when ``AUTH_PROVIDER=custom``. In Clerk (hosted) mode seats are
billed by Clerk, so :func:`effective_seat_limit` returns ``None`` (no cap here).
"""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


@dataclass(frozen=True)
class LicenseState:
    """Decoded, verified license status for the admin surface + enforcement."""

    present: bool = False          # a token was configured at all
    valid: bool = False            # signature ok AND not past grace
    signature_ok: bool = False     # signature verified against the public key
    expired: bool = False          # past ``exp``
    in_grace: bool = False         # expired but within the grace window
    seats: int = 0                 # seats the license grants
    customer: str | None = None
    tier: str | None = None
    issued_at: datetime | None = None
    expires_at: datetime | None = None
    error: str | None = None       # human-readable reason when not valid


def _load_public_key():
    raw = (get_settings().LICENSE_PUBLIC_KEY or "").strip()
    if not raw:
        return None
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        return Ed25519PublicKey.from_public_bytes(base64.b64decode(raw))
    except (ValueError, binascii.Error):
        return None


def _dt(ts) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def verify_token(token: str) -> LicenseState:
    """Verify a license token and compute its state. Never raises."""
    token = (token or "").strip()
    if not token:
        return LicenseState(present=False, error="No license configured.")

    from cryptography.exceptions import InvalidSignature

    pub = _load_public_key()
    if pub is None:
        return LicenseState(
            present=True, error="No/invalid license public key on this instance."
        )
    try:
        msg_b64, sig_b64 = token.split(".", 1)
        pub.verify(_b64url_decode(sig_b64), msg_b64.encode())
        payload = json.loads(_b64url_decode(msg_b64))
    except (ValueError, InvalidSignature, json.JSONDecodeError):
        return LicenseState(present=True, signature_ok=False, error="Invalid license signature.")

    grace_days = max(int(get_settings().LICENSE_GRACE_DAYS or 0), 0)
    now = datetime.now(timezone.utc)
    exp = _dt(payload.get("exp"))
    iat = _dt(payload.get("iat"))
    seats = int(payload.get("seats") or 0)
    expired = exp is not None and now > exp
    in_grace = bool(expired and exp is not None and now <= exp + timedelta(days=grace_days))

    if expired and not in_grace:
        return LicenseState(
            present=True, signature_ok=True, expired=True, in_grace=False,
            seats=seats, customer=payload.get("customer"), tier=payload.get("tier"),
            issued_at=iat, expires_at=exp,
            error="License expired (past grace).",
        )
    return LicenseState(
        present=True, signature_ok=True, valid=True, expired=expired, in_grace=in_grace,
        seats=seats, customer=payload.get("customer"), tier=payload.get("tier"),
        issued_at=iat, expires_at=exp,
    )


def current_license() -> LicenseState:
    """The instance's current license state (from the configured token)."""
    return verify_token(get_settings().LICENSE_KEY or "")


def effective_seat_limit() -> int | None:
    """Max active accounts allowed right now.

    ``None`` = no cap. That's the case for hosted/Clerk mode (seats billed by
    Clerk) AND for free self-host (``LICENSE_ENFORCED`` off, the default) — so
    a self-hoster adds users freely. When enforcement is on, it's the free tier
    (default 1), raised to the license's seats while valid or in grace; an
    expired-past-grace license falls back to the free tier for *adding*
    accounts (existing users are untouched)."""
    s = get_settings()
    if (s.AUTH_PROVIDER or "custom").lower() != "custom":
        return None  # hosted/Clerk: seat billing is Clerk's job
    if not s.LICENSE_ENFORCED:
        return None  # free, unlimited self-host (the default)
    free = max(int(s.LICENSE_FREE_SEATS or 1), 1)
    lic = current_license()
    if lic.valid and lic.seats > 0:
        return max(lic.seats, free)
    return free


async def count_active_users(db: AsyncSession) -> int:
    """Active accounts = a seat each. Disabled / soft-deleted users don't count."""
    return int(
        (
            await db.execute(
                select(func.count(User.id)).where(
                    User.disabled.is_(False), User.deleted_at.is_(None)
                )
            )
        ).scalar_one()
    )


class SeatLimitReached(Exception):
    """Raised by :func:`assert_seat_available` when adding would exceed the cap."""

    def __init__(self, limit: int):
        self.limit = limit
        super().__init__(f"Seat limit reached ({limit}).")


async def assert_seat_available(db: AsyncSession, *, adding: int = 1) -> None:
    """Guard an account-adding action against the effective seat cap. No-op when
    uncapped (Clerk mode). Raises :class:`SeatLimitReached` otherwise."""
    cap = effective_seat_limit()
    if cap is None:
        return
    if await count_active_users(db) + adding > cap:
        raise SeatLimitReached(cap)


__all__ = [
    "LicenseState",
    "SeatLimitReached",
    "assert_seat_available",
    "count_active_users",
    "current_license",
    "effective_seat_limit",
    "verify_token",
    "b64url_encode",
]
