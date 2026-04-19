"""Auth primitives: password hashing, JWT tokens, Fernet key-at-rest helpers."""
from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from cryptography.fernet import Fernet, InvalidToken
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings

settings = get_settings()

# --------------------------------------------------------------------
# Password hashing
# --------------------------------------------------------------------
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd_context.verify(plain, hashed)
    except ValueError:
        # Malformed hash — treat as a failure rather than 500.
        return False


# A precomputed bcrypt hash of an unguessable string. Used by the login
# path when the supplied identifier doesn't match any user, so the
# request still pays the cost of one bcrypt verify and timing can't be
# used to enumerate which usernames exist. The cleartext is irrelevant
# because nothing ever hashes against it for real.
DUMMY_PASSWORD_HASH: str = _pwd_context.hash(
    "promptly:enumeration-defense:" + uuid.uuid4().hex
)


def waste_a_verify() -> None:
    """Run one bcrypt verify against the dummy hash.

    Call this on the "user not found" branch of login so the response
    timing matches the "user found, wrong password" branch. Cheap (one
    bcrypt round) but closes a real side channel.
    """
    try:
        _pwd_context.verify("does-not-matter", DUMMY_PASSWORD_HASH)
    except ValueError:
        pass


# --------------------------------------------------------------------
# JWT tokens
# --------------------------------------------------------------------
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7

# "mfa_challenge" — issued after a successful password check when the
# user has MFA enrolled but hasn't yet presented the second factor.
# Carries no privileges of its own; the only endpoint that accepts it
# is /auth/mfa/verify, which trades it for a real access+refresh pair.
#
# "mfa_enrollment" — issued after a successful password check when the
# user has *no* MFA enrolled but ``app_settings.mfa_required`` is True.
# Accepted only by the /auth/mfa/setup/* endpoints; trades for real
# tokens once enrollment + first verify succeed.
TokenType = Literal["access", "refresh", "mfa_challenge", "mfa_enrollment"]


class TokenError(Exception):
    """Raised when a token is invalid, expired, or the wrong type."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _create_token(
    *,
    subject: str,
    token_type: TokenType,
    expires_delta: timedelta,
    token_version: int,
) -> str:
    expire = _now() + expires_delta
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "iat": int(_now().timestamp()),
        "exp": int(expire.timestamp()),
        "jti": uuid.uuid4().hex,
        # "tv" = token_version. Mirrored from the User row at issue
        # time. ``get_current_user`` rejects the request if the value
        # in the token doesn't match the value on the user, which is
        # how lockout / disable / "log out everywhere" instantly
        # invalidates outstanding sessions.
        "tv": int(token_version),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGORITHM)


def create_access_token(subject: str | uuid.UUID, *, token_version: int = 0) -> str:
    return _create_token(
        subject=str(subject),
        token_type="access",
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        token_version=token_version,
    )


def create_refresh_token(subject: str | uuid.UUID, *, token_version: int = 0) -> str:
    return _create_token(
        subject=str(subject),
        token_type="refresh",
        expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        token_version=token_version,
    )


def create_mfa_challenge_token(
    subject: str | uuid.UUID,
    *,
    token_version: int,
    expires_delta: timedelta,
) -> str:
    """Mint the short-lived JWT that the frontend trades at /auth/mfa/verify."""
    return _create_token(
        subject=str(subject),
        token_type="mfa_challenge",
        expires_delta=expires_delta,
        token_version=token_version,
    )


def create_mfa_enrollment_token(
    subject: str | uuid.UUID,
    *,
    token_version: int,
    expires_delta: timedelta,
) -> str:
    """Mint the short-lived JWT used during forced MFA enrollment."""
    return _create_token(
        subject=str(subject),
        token_type="mfa_enrollment",
        expires_delta=expires_delta,
        token_version=token_version,
    )


def decode_token(token: str, *, expected_type: TokenType) -> dict[str, Any]:
    """Validate signature + expiry + token type. Returns the decoded payload."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError as e:
        raise TokenError(f"Invalid token: {e}") from e

    if payload.get("type") != expected_type:
        raise TokenError(
            f"Wrong token type: expected {expected_type}, got {payload.get('type')!r}"
        )
    if "sub" not in payload:
        raise TokenError("Token missing subject")
    return payload


# --------------------------------------------------------------------
# Fernet encryption (at-rest for provider API keys etc.)
# --------------------------------------------------------------------
def _derive_fernet_key(secret: str) -> bytes:
    """Derive a 32-byte URL-safe base64 key from the app SECRET_KEY.

    Fernet requires a key in a specific format — we SHA-256 the app secret and
    base64-encode it so operators can configure a single SECRET_KEY for both
    JWT and at-rest encryption.
    """
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


_fernet = Fernet(_derive_fernet_key(settings.SECRET_KEY))


def encrypt_secret(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as e:
        raise ValueError("Ciphertext is invalid or SECRET_KEY has changed") from e


# --------------------------------------------------------------------
# Fast hashing for "looks like a token" values
# --------------------------------------------------------------------
# Used for:
#   * email OTP codes (6-digit, attempt-capped, so brute-force is moot
#     and bcrypt's slowness would just hurt our login latency)
#   * trusted-device cookie tokens (256 bits of pre-existing entropy —
#     a fast hash is all we need to make a DB dump unreplayable)
#
# Backup codes get bcrypt instead, because they're shorter (8 chars
# alphanumeric) and not attempt-capped per-row, so a fast hash there
# would let an attacker with a DB dump brute-force a working code.


def sha256_token(token: str) -> str:
    """Hex-encoded SHA-256 of a token. Stable, length 64."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    """Timing-safe string compare. Wraps ``hmac.compare_digest``."""
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
