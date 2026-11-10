"""Where links Promptly sends point to, without trusting request headers.

A password-reset email used to build its link from ``X-Forwarded-Host`` /
``Host``. Anyone could ask for a reset for someone else with a forged host,
and the real email would carry a link to the attacker's site with a live
reset token in it (host-header poisoning). The OIDC ``redirect_uri`` and the
feedback email had the same habit.

The rule now: a link's origin is always one the admin configured —
``app_settings.public_origins`` (the setup wizard / Admin → General) or the
``ALLOWED_ORIGINS`` env var. The address the browser used is honoured only
when it is exactly one of those (someone on the LAN address gets a LAN
link), and only the plain localhost addresses are accepted unconfigured, so
a fresh local install still works. A forged header can at most pick another
configured origin; it can never introduce a new one. With nothing
configured at all there is no safe origin and the caller refuses.
"""
from __future__ import annotations

import logging
from urllib.parse import urlsplit

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.public_origin")

# Accepted when the browser is on one of them, even with nothing configured:
# a brand-new local install, reached on the machine itself.
_LOCAL_ORIGINS = frozenset(
    {
        "http://localhost",
        "http://localhost:8087",
        "http://localhost:8488",
        "http://127.0.0.1",
        "http://127.0.0.1:8087",
        "http://127.0.0.1:8488",
    }
)

NOT_CONFIGURED_HINT = (
    "No public address is set for this server, so Promptly can't build a "
    "safe link. Set it in Admin -> General (Public address) or ALLOWED_ORIGINS in .env."
)


def _clean(origin: str) -> str | None:
    if not isinstance(origin, str):
        return None
    o = origin.strip().rstrip("/")
    parts = urlsplit(o)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path or parts.query:
        return None
    return f"{parts.scheme}://{parts.netloc.lower()}"


async def configured_origins(db: AsyncSession) -> list[str]:
    """The admin's public origins, then ALLOWED_ORIGINS, in order, deduped."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.config import get_settings

    out: list[str] = []
    try:
        row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    except Exception:  # noqa: BLE001 - fall back to the env list
        logger.exception("couldn't read public_origins")
        row = None
    for raw in list(getattr(row, "public_origins", None) or []) + get_settings().allowed_origins_list:
        o = _clean(raw)
        if o and o not in out:
            out.append(o)
    return out


def request_origin(request: Request | None) -> str | None:
    """The origin the browser used, as the proxy reports it. Only ever
    compared against configured origins, never used on its own."""
    if request is None:
        return None
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip()
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
        or ""
    ).split(",")[0].strip()
    if not proto or not host:
        return None
    return _clean(f"{proto}://{host}")


async def link_origin(db: AsyncSession, request: Request | None = None) -> str | None:
    """The origin for a link Promptly sends or registers, or ``None`` when
    no safe one exists (the caller refuses and logs :data:`NOT_CONFIGURED_HINT`)."""
    configured = await configured_origins(db)
    non_local = [o for o in configured if o not in _LOCAL_ORIGINS]
    used = request_origin(request)
    if used and (used in non_local or (not non_local and used in _LOCAL_ORIGINS)):
        return used
    # Configured but not the one in use (or a forged one): the first the
    # admin set, which is the public address.
    if non_local:
        return non_local[0]
    if configured:
        return configured[0]
    return None
