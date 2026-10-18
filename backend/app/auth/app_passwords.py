"""App passwords — how a device signs in to sync (WP-8.3, Part C §5.7).

WebDAV clients (Finder, rclone, PhotoSync, FolderSync) and scripts can't do
Promptly's sign-in — no browser, no MFA prompt, and someone who signs in
with SSO has no password at all. Each device gets its own app password
instead: made in Settings → Devices, shown once, revocable on its own.

Format (the GitHub token style): ``pmt_`` + 30 random base62 characters +
a 6-character base62 CRC32 of them. The prefix makes a leaked one easy to
find (secret scanners, logs); the checksum lets a typo or a scanner's guess
be refused without touching the database. Only the SHA-256 is stored.

Basic auth (``Authorization: Basic base64(username:app-password)``) accepts
*only* app passwords — never the account password (Nextcloud's rule). Each
password has scopes: ``dav:read`` / ``dav:write`` for WebDAV, ``upload`` for
resumable uploads, and ``dav:delete`` — without it a device's deletes leave
the file in Promptly (a phone clearing space keeps its backup). A revoked password, a disabled account, or a deleted
one stops working on the next request. Signing out everywhere doesn't
touch devices — that's what revoking them is for.
"""
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import secrets
import string
import uuid
import zlib

from sqlalchemy import DateTime, ForeignKey, String, func, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

PREFIX = "pmt_"
SCOPES = ("dav:read", "dav:write", "dav:delete", "upload")
MAX_PER_USER = 50
_ALPHABET = string.digits + string.ascii_letters  # base62
_BODY = 30
_CHECK = 6
# Writing last_used on every request would be a write per WebDAV call.
_TOUCH_EVERY = _dt.timedelta(minutes=5)


class AppPassword(Base):
    __tablename__ = "app_passwords"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # "pmt_Ab3x…" — enough to recognise it, nothing to sign in with.
    hint: Mapped[str] = mapped_column(String(16), nullable=False)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(String(16)), nullable=False)
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_used_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    revoked_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# ------------------------------------------------------------------ format


def _b62(n: int, width: int) -> str:
    out = []
    for _ in range(width):
        n, r = divmod(n, 62)
        out.append(_ALPHABET[r])
    return "".join(reversed(out))


def _checksum(body: str) -> str:
    return _b62(zlib.crc32(body.encode("ascii")) & 0xFFFFFFFF, _CHECK)


def new_token() -> str:
    body = "".join(secrets.choice(_ALPHABET) for _ in range(_BODY))
    return f"{PREFIX}{body}{_checksum(body)}"


def well_formed(token: str) -> bool:
    """The prefix, the length, the alphabet and the checksum — before any
    database lookup."""
    if not token.startswith(PREFIX) or len(token) != len(PREFIX) + _BODY + _CHECK:
        return False
    rest = token[len(PREFIX):]
    if any(c not in _ALPHABET for c in rest):
        return False
    return _checksum(rest[:_BODY]) == rest[_BODY:]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def hint(token: str) -> str:
    return f"{token[: len(PREFIX) + 4]}…"


# ------------------------------------------------------------------ Basic auth


class AppPasswordRejected(Exception):
    """Wrong, revoked or out-of-scope — callers answer 401 (or 403 for a
    missing scope)."""

    def __init__(self, message: str, *, forbidden: bool = False) -> None:
        super().__init__(message)
        self.forbidden = forbidden


def parse_basic(authorization: str | None) -> tuple[str, str] | None:
    """``(username, password)`` from an ``Authorization: Basic`` header."""
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "basic" or not value:
        return None
    try:
        decoded = base64.b64decode(value.strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    username, sep, password = decoded.partition(":")
    return (username, password) if sep else None


async def authenticate(
    db: AsyncSession, username: str, password: str, *, scope: str, ip: str | None = None
):
    """The user an app password belongs to, if it's live, theirs and allowed
    ``scope``. Raises :class:`AppPasswordRejected`."""
    from app.auth.models import User

    if not well_formed(password):
        # Never the account password — whatever it was, it isn't this.
        raise AppPasswordRejected("Use an app password from Settings → Devices.")
    row = (
        await db.execute(select(AppPassword).where(AppPassword.token_hash == token_hash(password)).execution_options(populate_existing=True))
    ).scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        raise AppPasswordRejected("That app password isn't valid.")
    user = await db.get(User, row.user_id, populate_existing=True)
    if user is None or user.disabled:
        raise AppPasswordRejected("That app password isn't valid.")
    name = (username or "").strip().lower()
    if name not in {(user.username or "").lower(), (user.email or "").lower()}:
        raise AppPasswordRejected("That app password belongs to someone else.")
    if scope not in (row.scopes or []):
        raise AppPasswordRejected("This app password isn't allowed to do that.", forbidden=True)
    now = _dt.datetime.now(_dt.timezone.utc)
    if row.last_used_at is None or now - row.last_used_at > _TOUCH_EVERY or row.last_used_ip != ip:
        row.last_used_at = now
        row.last_used_ip = (ip or "")[:64] or None
        await db.commit()
    return user, row


__all__ = [
    "MAX_PER_USER",
    "PREFIX",
    "SCOPES",
    "AppPassword",
    "AppPasswordRejected",
    "authenticate",
    "hint",
    "new_token",
    "parse_basic",
    "token_hash",
    "well_formed",
]
