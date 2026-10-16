"""Can this server still read what it encrypted? (R-138)

Provider API keys, MFA secrets, connector tokens and the SMTP/SSO secrets
are encrypted with a key derived from SECRET_KEY. Change SECRET_KEY and
they all stop decrypting — MFA users are locked out, providers stop
working — with nothing saying why. At boot this counts what can't be read
and says so in the log, and moves values still under SECRET_KEY_PREVIOUS
onto the current key.
"""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.auth.utils import decrypt_secret, reencrypt_secret
from app.config import get_settings

logger = logging.getLogger("promptly.keys")


def _columns():
    from app.app_settings.models import AppSettings
    from app.mcp.models import McpConnector
    from app.mfa.models import UserMfaSecret
    from app.models_config.models import ModelProvider

    return [
        (UserMfaSecret, "totp_secret_encrypted"),
        (UserMfaSecret, "pending_totp_secret_encrypted"),
        (ModelProvider, "api_key"),
        (McpConnector, "auth_value_encrypted"),
        (AppSettings, "smtp_password_encrypted"),
        (AppSettings, "oidc_client_secret_encrypted"),
    ]


async def check_stored_secrets() -> dict[str, int]:
    from app.database import SessionLocal

    rotate = bool(get_settings().SECRET_KEY_PREVIOUS)
    counts = {"unreadable": 0, "rotated": 0}
    async with SessionLocal() as db:
        for model, column in _columns():
            col = getattr(model, column, None)
            if col is None:
                continue
            rows = (await db.execute(select(model).where(col.isnot(None)))).scalars().all()
            for row in rows:
                value = getattr(row, column)
                if not isinstance(value, str) or not value:
                    continue
                try:
                    decrypt_secret(value)
                except ValueError:
                    counts["unreadable"] += 1
                    continue
                if rotate:
                    fresh = reencrypt_secret(value)
                    if fresh != value:
                        setattr(row, column, fresh)
                        counts["rotated"] += 1
        await db.commit()
    if counts["unreadable"]:
        logger.error(
            "%d stored secret(s) can't be decrypted with SECRET_KEY. If you changed "
            "it, set SECRET_KEY_PREVIOUS to the old value and restart; MFA users "
            "can otherwise be reset with `python -m app.cli reset-mfa <user>`.",
            counts["unreadable"],
        )
    if counts["rotated"]:
        logger.info("Re-encrypted %d stored secret(s) under the current SECRET_KEY.", counts["rotated"])
    return counts
