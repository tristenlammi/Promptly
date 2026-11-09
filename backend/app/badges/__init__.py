"""Count badges on the sidebar's app rows (``GET /api/badges``).

A small registry. Each **part** is one number an app adds to one sidebar
row; a row's badge is the sum of its parts:

    rooms  = unread messages and mentions (5) + missed calls not seen (1)  ->  6

Rows are keyed by the sidebar's app ids: a built-in app's id (``mail``,
``rooms``, ``porch``) or an Item Store kind (``tasks``). The parts live in
:mod:`app.badges.providers`; adding one is a ``@badge(app, key)`` block
there. A part's ``count(db, user)`` returns the caller's own number, or
``None`` when that part isn't for them (Porch off for them, calls off):
a row whose parts are all ``None`` is left out of the answer. Counts must
be cheap (indexed counts, one small document read, no per-row queries):
every open page asks every 60 s, on focus and after the app's own actions.

A part that fails counts 0 and is logged; it never fails the request or
the other parts (each runs in its own savepoint).
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.badges")

CountFn = Callable[[AsyncSession, User], Awaitable[int | None]]


@dataclass(frozen=True)
class BadgePart:
    app: str
    key: str
    count: CountFn


_PARTS: list[BadgePart] = []


def badge(app: str, key: str) -> Callable[[CountFn], CountFn]:
    """Register ``fn(db, user) -> int | None`` as part ``key`` of row
    ``app``'s badge. Several parts may share an ``app``: they add up."""

    def wrap(fn: CountFn) -> CountFn:
        if any(p.app == app and p.key == key for p in _PARTS):
            raise ValueError(f"badge part {app}/{key} registered twice")
        _PARTS.append(BadgePart(app, key, fn))
        return fn

    return wrap


def apps() -> list[str]:
    """Rows that can have a badge, in registration order."""
    _load()
    return list(dict.fromkeys(p.app for p in _PARTS))


def parts() -> list[BadgePart]:
    _load()
    return list(_PARTS)


async def collect(db: AsyncSession, user: User, only: Iterable[str] | None = None) -> dict[str, int]:
    """``{app: count}`` for each row this person can use (or just the
    ``only`` ones)."""
    _load()
    wanted = set(only) if only is not None else None
    out: dict[str, int] = {}
    for p in _PARTS:
        if wanted is not None and p.app not in wanted:
            continue
        try:
            # A savepoint: one part's SQL error mustn't abort the others'.
            async with db.begin_nested():
                n = await p.count(db, user)
        except Exception:  # noqa: BLE001 — a badge never breaks the page
            logger.exception("badge %s/%s failed for user %s", p.app, p.key, user.id)
            n = 0
        if n is None:
            continue
        out[p.app] = out.get(p.app, 0) + max(0, int(n))
    return out


def _load() -> None:
    from . import providers  # noqa: F401  (registers the parts on import)
