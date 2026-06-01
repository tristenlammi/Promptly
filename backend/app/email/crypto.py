"""OAuth token encryption/decryption helpers for the email module.

Reuses the same Fernet key and helpers as the rest of the app
(app.auth.utils.encrypt_secret / decrypt_secret) so OAuth tokens
are protected by the same key-rotation story as SMTP passwords and
model-provider API keys.

Tokens are stored as a JSON blob with three fields:
  {access_token: str, refresh_token: str | None, expiry_iso: str | None}
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TypedDict

from app.auth.utils import decrypt_secret, encrypt_secret


class OAuthTokens(TypedDict):
    access_token: str
    refresh_token: str | None
    expiry_iso: str | None


def encrypt_tokens(tokens: OAuthTokens) -> str:
    """Serialise + encrypt an OAuth token dict for storage."""
    return encrypt_secret(json.dumps(tokens))


def decrypt_tokens(ciphertext: str) -> OAuthTokens:
    """Decrypt + deserialise an OAuth token dict from storage."""
    return json.loads(decrypt_secret(ciphertext))


def tokens_expired(tokens: OAuthTokens) -> bool:
    """Return True when the access token has expired (with a 60s buffer)."""
    iso = tokens.get("expiry_iso")
    if not iso:
        return False
    try:
        expiry = datetime.fromisoformat(iso)
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return (expiry - now).total_seconds() < 60
    except ValueError:
        return True
