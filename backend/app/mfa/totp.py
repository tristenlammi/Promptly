"""TOTP (RFC 6238) helpers — secret generation, QR rendering, verify.

Wraps :mod:`pyotp` so the rest of the app never has to think about
window sizes, padding, or otpauth URI escaping. Verification accepts a
±1 step skew (≈30s on either side of the current window) which is the
defacto industry default and covers normal clock drift between phone
and server.
"""
from __future__ import annotations

import base64
import io
from urllib.parse import quote

import pyotp
import qrcode

from app.config import get_settings

_settings = get_settings()


def generate_secret() -> str:
    """Return a fresh base32 TOTP shared secret (160 bits)."""
    return pyotp.random_base32()


def provisioning_uri(secret: str, *, account_name: str) -> str:
    """Build the ``otpauth://`` URI consumed by authenticator apps.

    ``account_name`` is what the user sees in the app's account list
    (typically their email or username). Issuer is taken from
    ``MFA_ISSUER`` so all of an org's accounts cluster together in
    Authy / 1Password / Google Authenticator.
    """
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_name,
        issuer_name=_settings.MFA_ISSUER,
    )


def qr_data_uri(uri: str) -> str:
    """Render an ``otpauth://`` URI as a PNG ``data:`` URI.

    Embedded inline in the enrollment response so the frontend doesn't
    need a second round-trip (or a public asset endpoint that would
    leak in-progress secrets to anyone who knew the URL).

    We use error-correction level M (15%) — a balance between QR size
    and tolerance for mid-screen reflections / bad camera focus.
    """
    img = qrcode.make(uri, error_correction=qrcode.constants.ERROR_CORRECT_M)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def verify_code(secret: str, code: str) -> bool:
    """Validate a 6-digit TOTP code against ``secret``.

    ``valid_window=1`` allows the previous and next 30s window in
    addition to the current one, absorbing typical clock skew between
    the user's phone and the server.

    Always returns False (never raises) on malformed inputs so caller
    error handling stays simple.
    """
    if not code or not code.strip().isdigit():
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)
    except Exception:  # noqa: BLE001 — pyotp raises on weird base32
        return False


# A TOTP code stays valid for its ±1-step window (~90s). Without a
# consumed-code record, the SAME code can be replayed multiple times inside
# that window. We record accepted codes per user in Redis for the window and
# reject reuse — the OTP analogue of what the email-OTP path already does.
_TOTP_REUSE_TTL_SECONDS = 90


async def consume_totp(user_id, code: str) -> bool:
    """Mark a just-verified TOTP code as used; return False if it was already
    used within the reuse window (a replay). Call ONLY after ``verify_code``
    has returned True. Fail-open on a Redis error so a cache blip can't lock
    a legitimate user out of MFA."""
    from app.redis_client import redis

    code = (code or "").strip()
    if not code:
        return False
    key = f"promptly:mfa:totp-used:{user_id}:{code}"
    try:
        was_set = await redis.set(key, "1", ex=_TOTP_REUSE_TTL_SECONDS, nx=True)
    except Exception:  # noqa: BLE001 — never break MFA on a cache hiccup
        return True
    return bool(was_set)


def safe_account_label(*, username: str, issuer: str | None = None) -> str:
    """URL-safe label for the otpauth URI.

    Authenticator apps render this verbatim, and a stray ``:`` would
    break the URI. We collapse whitespace and percent-encode anything
    suspicious.
    """
    issuer = issuer or _settings.MFA_ISSUER
    return f"{quote(issuer)}:{quote(username)}"
