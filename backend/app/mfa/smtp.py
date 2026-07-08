"""Async SMTP wrapper that reads its config from ``app_settings``.

Why config-from-DB rather than env vars
---------------------------------------
The admin can rotate SMTP credentials from the UI without restarting
the container. Loading on every send keeps that simple — SMTP isn't
on a hot path (only fires when a user requests an OTP) and the
``app_settings`` row is one ``db.get`` by primary key.

TLS modes
---------
Chosen per-port at send time so autoconfig-discovered providers work:

* port 465          → implicit TLS (Gmail's ISPDB entry, Yahoo, many others).
* ``smtp_use_tls``  → STARTTLS upgrade (port 587, the modern default for
  SES, SendGrid, Postmark, Mailgun, Brevo, …).
* otherwise         → plain SMTP (port 25/2525, for self-hosted relays
  inside trusted networks).
"""
from __future__ import annotations

import logging
from email.message import EmailMessage

import aiosmtplib
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.utils import decrypt_secret
from app.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()


class SmtpNotConfiguredError(RuntimeError):
    """Raised when the admin hasn't filled in enough SMTP fields to send."""


class SmtpSendError(RuntimeError):
    """Wraps any exception thrown during an SMTP transaction.

    The original ``__cause__`` is preserved for the application logs;
    callers should *not* propagate the message to end users (it can
    contain server addresses, TLS errors, etc. — info-leak risk).
    """


async def _load_settings(db: AsyncSession) -> AppSettings:
    """Fetch the singleton settings row. Caller checks ``smtp_configured``."""
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        raise SmtpNotConfiguredError("app_settings row missing")
    return row


async def send_message(
    db: AsyncSession,
    *,
    to: str,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    reply_to: str | None = None,
) -> None:
    """Send a single email.

    ``reply_to`` sets the Reply-To header — used by the feedback mailer so a
    reply lands with the person who submitted it, not the instance's SMTP
    account.

    Raises
    ------
    SmtpNotConfiguredError
        Admin hasn't filled in host / port / from-address.
    SmtpSendError
        Anything went wrong on the wire. Original cause attached.
    """
    cfg = await _load_settings(db)
    if not cfg.smtp_configured:
        raise SmtpNotConfiguredError(
            "SMTP is not configured. An administrator must set the SMTP "
            "host, port, and from-address before email can be sent."
        )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["To"] = to
    msg["From"] = (
        f"{cfg.smtp_from_name} <{cfg.smtp_from_address}>"
        if cfg.smtp_from_name
        else cfg.smtp_from_address  # type: ignore[assignment]
    )
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    password: str | None = None
    if cfg.smtp_password_encrypted:
        try:
            password = decrypt_secret(cfg.smtp_password_encrypted)
        except ValueError as e:
            # SECRET_KEY rotated without re-entering the password —
            # surface a clean error rather than 500ing on the wire.
            raise SmtpSendError(
                "SMTP password could not be decrypted. The admin needs "
                "to re-save it after a SECRET_KEY rotation."
            ) from e

    # Connection security, decided per-port so autoconfig-discovered
    # providers "just work":
    #   * port 465          → implicit TLS (``use_tls``). Gmail's ISPDB entry
    #     and many providers list 465/SSL; the old code forced STARTTLS on it
    #     and failed. Keying off the port fixes that without a schema change.
    #   * ``smtp_use_tls``  → STARTTLS upgrade (port 587, the modern default).
    #   * otherwise         → plain SMTP (port 25/2525, trusted relays).
    if cfg.smtp_port == 465:
        tls_kwargs = {"use_tls": True}
    elif cfg.smtp_use_tls:
        tls_kwargs = {"start_tls": True}
    else:
        tls_kwargs = {"start_tls": False}

    try:
        await aiosmtplib.send(
            msg,
            hostname=cfg.smtp_host,
            port=cfg.smtp_port,
            username=cfg.smtp_username or None,
            password=password,
            timeout=15,
            **tls_kwargs,
        )
    except Exception as e:  # noqa: BLE001 — must wrap; never bubble raw SMTP error
        logger.exception("SMTP send failed (host=%s port=%s)", cfg.smtp_host, cfg.smtp_port)
        raise SmtpSendError("Failed to send email") from e


# ---------------------------------------------------------------------
# Convenience builders for known transactional templates
# ---------------------------------------------------------------------
def render_otp_email(
    *,
    code: str,
    purpose: str,
    ttl_minutes: int,
) -> tuple[str, str, str]:
    """Return ``(subject, text_body, html_body)`` for an OTP email.

    Plain-text first because half the world (and every Outlook on the
    Fortune 500) renders HTML mail badly. The HTML version is bonus.
    """
    if purpose == "login":
        intro = "Your sign-in verification code is below."
    else:
        intro = "Your Promptly verification code is below."

    subject = f"Your Promptly verification code: {code}"
    text_body = (
        f"{intro}\n\n"
        f"  {code}\n\n"
        f"This code expires in {ttl_minutes} minutes. If you did not "
        f"request it, you can ignore this email — your account remains "
        f"safe.\n\n"
        f"— Promptly\n"
    )
    html_body = (
        "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;"
        "background:#fafaf7;margin:0;padding:32px;color:#1c1917\">"
        f"<p style=\"font-size:15px;line-height:1.5\">{intro}</p>"
        f"<p style=\"font-size:32px;font-weight:600;letter-spacing:6px;"
        f"text-align:center;background:#fff;border-radius:12px;padding:24px;"
        f"margin:24px 0;border:1px solid #e7e5e4\">{code}</p>"
        f"<p style=\"font-size:13px;color:#78716c;line-height:1.5\">"
        f"This code expires in {ttl_minutes} minutes. If you did not "
        f"request it, you can ignore this email — your account remains "
        f"safe.</p>"
        "<p style=\"font-size:13px;color:#78716c;margin-top:24px\">— Promptly</p>"
        "</body></html>"
    )
    return subject, text_body, html_body
