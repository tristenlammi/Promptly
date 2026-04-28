"""Dynamic CORS allow-list: env defaults + DB-stored public origins.

The stock ``starlette.middleware.cors.CORSMiddleware`` reads its
``allow_origins`` parameter exactly once when the app boots. That made
sense when the operator hand-edited ``.env`` before every restart, but
the first-run wizard now lets the admin pick the public URL through
the UI — a value the backend has to start honouring without a restart
or it'll serve a permanent CORS error to every request from the new
domain.

Implementation strategy:

* Wrap (not replace) the stock CORSMiddleware. Starlette's
  implementation is well-tested and we don't want to re-invent
  preflight handling.
* Each instance still has a fixed-at-construction ``allow_origins``
  set, but we keep a fresh wrapper instance per request so the set is
  always computed against the current DB state.
* A short TTL cache (default 15 s) keeps the DB query cost negligible
  even on a busy stream. The ``invalidate_cache`` function lets the
  wizard / admin settings endpoint flush instantly after a write so
  the operator never sees stale CORS rejections after toggling
  origins.
* Localhost variants are always allowed unconditionally so a brand-
  new install is reachable without any wizard step. This matches the
  intent of the old ``ALLOWED_ORIGINS=http://localhost`` default.

The dynamic wrapper is the only middleware mounted on the app; the
fall-through to the stock middleware happens internally per request.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Iterable

from sqlalchemy import select
from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.config import get_settings
from app.database import SessionLocal

logger = logging.getLogger("promptly.cors")

# Always-allowed origins so a fresh install is reachable on the
# default ports without any wizard step. Covers the most common dev
# / first-boot URLs the operator might hit before configuring a
# public domain.
_ALWAYS_ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://localhost",
    "http://localhost:8087",
    "http://localhost:8488",
    "http://127.0.0.1",
    "http://127.0.0.1:8087",
    "http://127.0.0.1:8488",
)


# Cache the resolved origin set briefly so a hot endpoint doesn't
# re-query the DB on every preflight. 15 s is short enough that an
# admin toggling settings sees the change land within a beat (and the
# explicit ``invalidate_cache`` hook below makes the typical edit-
# then-test flow feel instantaneous).
_CACHE_TTL_SECONDS = 15.0
_cache: dict[str, object] = {"expires_at": 0.0, "origins": frozenset()}
_cache_lock = asyncio.Lock()


async def _load_origins_from_db() -> frozenset[str]:
    """Pull ``public_origins`` from the singleton app_settings row.

    Returns an empty set if the row is missing (shouldn't happen on a
    healthy install — the bootstrap creates it). Any DB error is
    logged and treated as "no DB origins" so a transient outage falls
    back to the always-allowed defaults rather than rejecting all
    cross-origin traffic outright.
    """
    try:
        async with SessionLocal() as db:
            row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
            if row is None:
                return frozenset()
            raw = row.public_origins or []
            return frozenset(
                origin.strip()
                for origin in raw
                if isinstance(origin, str) and origin.strip()
            )
    except Exception:  # noqa: BLE001 — defensive
        logger.exception("Failed to load public_origins from DB; falling back")
        return frozenset()


async def _resolve_allowed_origins() -> frozenset[str]:
    """Return the effective CORS allow-set for the current moment.

    Combines:
    1. Always-allowed localhost defaults.
    2. Static ``ALLOWED_ORIGINS`` env var (compatibility seed).
    3. DB-stored ``public_origins`` (the wizard / admin UI).

    Cached for ``_CACHE_TTL_SECONDS`` to keep preflight cheap.
    """
    now = time.monotonic()
    if now < float(_cache["expires_at"]):
        return _cache["origins"]  # type: ignore[return-value]
    async with _cache_lock:
        # Re-check inside the lock so we don't stampede the DB when
        # the cache expires under concurrent traffic.
        now = time.monotonic()
        if now < float(_cache["expires_at"]):
            return _cache["origins"]  # type: ignore[return-value]
        env_origins = frozenset(get_settings().allowed_origins_list)
        db_origins = await _load_origins_from_db()
        origins = frozenset(_ALWAYS_ALLOWED_ORIGINS) | env_origins | db_origins
        _cache["origins"] = origins
        _cache["expires_at"] = now + _CACHE_TTL_SECONDS
        return origins


def invalidate_cache() -> None:
    """Force the next CORS resolution to re-read from the DB.

    Called by the wizard endpoint and admin-settings PATCH so a
    just-saved origin starts working on the very next request rather
    than after the cache TTL expires. Cheap — just zeroes the
    expiry timestamp.
    """
    _cache["expires_at"] = 0.0


class DynamicCORSMiddleware:
    """ASGI middleware that delegates to a freshly-built ``CORSMiddleware``
    on every request.

    Performance note: building a ``CORSMiddleware`` is essentially
    free — it just stashes a few sets and string lists; it doesn't
    open connections or do any I/O. The DB lookup is what could be
    expensive, hence the TTL cache above.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        allow_credentials: bool = True,
        allow_methods: Iterable[str] = (
            "GET",
            "POST",
            "PATCH",
            "PUT",
            "DELETE",
            "OPTIONS",
        ),
        allow_headers: Iterable[str] = (
            "Authorization",
            "Content-Type",
            "Accept",
            "X-Requested-With",
        ),
        expose_headers: Iterable[str] = ("Content-Disposition",),
    ) -> None:
        self.app = app
        self._allow_credentials = allow_credentials
        self._allow_methods = list(allow_methods)
        self._allow_headers = list(allow_headers)
        self._expose_headers = list(expose_headers)

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        # Non-HTTP traffic (websockets, lifespan) doesn't go through
        # CORS — pass straight through.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        origins = await _resolve_allowed_origins()
        # Build a per-request CORS middleware around the downstream
        # app with the freshly-resolved origin set. The ``app`` arg
        # passed to ``CORSMiddleware`` is what it'll call after the
        # CORS headers are applied, so we hand it the rest of the
        # ASGI chain (``self.app``).
        cors = CORSMiddleware(
            self.app,
            allow_origins=list(origins),
            allow_credentials=self._allow_credentials,
            allow_methods=self._allow_methods,
            allow_headers=self._allow_headers,
            expose_headers=self._expose_headers,
        )
        await cors(scope, receive, send)
