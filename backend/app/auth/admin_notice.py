"""Telling someone when an admin changed their account (admin privacy, AP5).

An admin can reset a person's password, set one from the edit form, change
their email or role, or turn off their two-step verification. Each of those
can hand the admin the account, so none of them may be silent (audit
U1-U3). :func:`tell` does three things, each best-effort:

* emails the person (for an email change: the old address too, so the
  real owner hears about it even if the new address is the admin's);
* an in-app notification (``system_alert``: can't be muted per category);
* sets the one-time banner (``users.admin_notice_*``) that shows the next
  time they open Promptly, on any device, until they close it.

The first SSO link is told the same way but without a banner: the person
just signed in themselves, and the email is what reaches the real owner.

Every one of these is also an ``auth_events`` row, which the person sees
under Account → Security → Recent activity.

Nothing here logs what changed beyond the kind, and the message never
includes a password.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import urlparse

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.auth.admin_notice")

PASSWORD_RESET = "password_reset"
EMAIL_CHANGED = "email_changed"
ROLE_CHANGED = "role_changed"
MFA_RESET = "mfa_reset"
SSO_LINKED = "sso_linked"

KINDS = (PASSWORD_RESET, EMAIL_CHANGED, ROLE_CHANGED, MFA_RESET, SSO_LINKED)

_SECURITY_URL = "/account/security"


def _when(user: User, at: datetime) -> str:
    from app.notifications.quiet import zone_of

    local = at.astimezone(zone_of(user.settings))
    return f"{local.day} {local:%B %Y} at {local:%H:%M} ({local.tzname()})"


def _message(user: User, kind: str, *, at: datetime, old_email: str | None, issuer: str | None) -> tuple[str, str, str]:
    """(title, one-line body for the notification, email body paragraph)."""
    when = _when(user, at)
    if kind == PASSWORD_RESET:
        title = "Your administrator reset your password"
        line = "You'll choose a new password when you next sign in."
        para = (
            f"An administrator of your Promptly server reset your password on {when}. "
            "Every device you were signed in on was signed out, and you'll be asked "
            "to choose a new password when you next sign in."
        )
    elif kind == EMAIL_CHANGED:
        title = "Your administrator changed your email address"
        line = f"Your account's email is now {user.email}."
        para = (
            f"An administrator of your Promptly server changed your account's email "
            f"address on {when}"
            + (f", from {old_email}" if old_email else "")
            + f" to {user.email}. Sign-in codes and password reset links now go there."
        )
    elif kind == ROLE_CHANGED:
        now_admin = user.role == "admin"
        title = "Your administrator changed your role"
        line = "You're now an administrator of this server." if now_admin else "You're no longer an administrator of this server."
        para = (
            f"An administrator of your Promptly server changed your role on {when}. "
            + ("You're now an administrator: you can manage accounts, storage and the server."
               if now_admin else "You're now a member, no longer an administrator.")
        )
    elif kind == MFA_RESET:
        title = "Your administrator turned off two-step verification"
        line = "Set it up again under Account → Security."
        para = (
            f"An administrator of your Promptly server turned off two-step verification "
            f"on your account on {when}, and signed you out everywhere. Sign in and set "
            "it up again under Account → Security."
        )
    elif kind == SSO_LINKED:
        host = urlparse(issuer or "").hostname or "a single sign-on provider"
        title = "Single sign-on was linked to your account"
        line = f"Signing in with {host} now opens your account."
        para = (
            f"On {when}, your Promptly account was linked to a sign-in at {host}. "
            f"From now on, signing in with {host} opens your account."
        )
    else:  # pragma: no cover — callers pass a known kind
        raise ValueError(kind)
    return title, line, para


async def _email(db: AsyncSession, to: str, user: User, subject: str, para: str) -> bool:
    from app.mfa.smtp import send_message

    body = (
        f"Hi {user.username},\n\n{para}\n\n"
        "You can see every change to your account under Account → Security → "
        "Recent activity. If you didn't expect this, talk to your administrator."
    )
    try:
        await send_message(db, to=to, subject=f"Promptly: {subject[0].lower()}{subject[1:]}", text_body=body)
        return True
    except Exception:  # noqa: BLE001 — SMTP is optional; the banner and notification still go
        logger.info("account-change email not sent")
        return False


async def tell(
    db: AsyncSession,
    user: User,
    kind: str,
    *,
    old_email: str | None = None,
    issuer: str | None = None,
    banner: bool = True,
) -> None:
    """Tell ``user`` that their account was changed (``kind``).

    Commits the banner columns. Call it after the change itself is
    committed. Never raises: a missing SMTP server or a push failure
    mustn't undo or fail the admin's action."""
    at = datetime.now(timezone.utc)
    title, line, para = _message(user, kind, at=at, old_email=old_email, issuer=issuer)
    if banner:
        user.admin_notice_at = at
        user.admin_notice_kind = kind
        try:
            await db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("admin notice: banner not saved (kind=%s)", kind)
            await db.rollback()
    targets = [user.email]
    if old_email and old_email.lower() != (user.email or "").lower():
        targets.append(old_email)
    for to in targets:
        await _email(db, to, user, title, para)
    try:
        from app.notifications import dispatch

        await dispatch.notify_user(
            user_id=user.id,
            category="system_alert",
            title=title,
            body=line,
            url=_SECURITY_URL,
            tag=f"promptly-account-{kind}",
        )
    except Exception:  # noqa: BLE001
        logger.exception("admin notice: notification not sent (kind=%s)", kind)
