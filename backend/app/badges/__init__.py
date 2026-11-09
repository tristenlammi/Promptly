"""Count badges on the sidebar's app rows (``GET /api/apps/badges``).

A small registry: each **part** is one number an app contributes to one
sidebar row, with its own words for the screen-reader label. A row's badge
is the sum of its parts, and its label joins the parts that aren't zero:

    rooms  = unread (5) + missed calls (1)  ->  6, "5 unread, 1 missed call"

Rows are keyed by the sidebar's app ids: a built-in app's id (``mail``,
``rooms``) or an Item Store kind (``tasks``). The parts live in
:mod:`app.badges.providers`; adding one is a ``@badge(...)`` block there
(see its docstring). Every count is the caller's own and must be cheap
(an indexed count, one small file read): the sidebar asks every 60 s and
on focus.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.badges")

CountFn = Callable[[AsyncSession, User], Awaitable[int]]


@dataclass(frozen=True)
class BadgePart:
    app: str
    key: str
    count: CountFn
    label: Callable[[int], str]


_PARTS: list[BadgePart] = []


def badge(app: str, key: str, *, label: Callable[[int], str]) -> Callable[[CountFn], CountFn]:
    """Register ``fn(db, user) -> int`` as part ``key`` of row ``app``'s
    badge. ``label(n)`` is that part's words for ``n`` > 0, e.g.
    ``"3 unread"``. Several parts may share an ``app``: their counts add up
    in registration order."""

    def wrap(fn: CountFn) -> CountFn:
        if any(p.app == app and p.key == key for p in _PARTS):
            raise ValueError(f"badge part {app}/{key} registered twice")
        _PARTS.append(BadgePart(app, key, fn, label))
        return fn

    return wrap


def apps() -> list[str]:
    """Rows with a badge, in registration order."""
    _load()
    return list(dict.fromkeys(p.app for p in _PARTS))


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


async def collect(db: AsyncSession, user: User, only: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """``{app: {"count", "label", "parts": [{"key", "count", "label"}]}}``
    for each row (or just the ``only`` ones). A part that fails is left out
    (and logged) rather than failing the rest."""
    _load()
    wanted = set(only) if only is not None else None
    out: dict[str, dict[str, Any]] = {}
    for p in _PARTS:
        if wanted is not None and p.app not in wanted:
            continue
        row = out.setdefault(p.app, {"count": 0, "label": "", "parts": []})
        try:
            # A savepoint: one part's SQL error mustn't abort the others'.
            async with db.begin_nested():
                n = max(0, int(await p.count(db, user) or 0))
        except Exception:  # noqa: BLE001
            logger.exception("badge %s/%s failed", p.app, p.key)
            continue
        row["parts"].append({"key": p.key, "count": n, "label": p.label(n) if n else ""})
        row["count"] += n
    for row in out.values():
        row["label"] = ", ".join(x["label"] for x in row["parts"] if x["count"])
    return out


def _load() -> None:
    from . import providers  # noqa: F401  (registers the parts on import)
