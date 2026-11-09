"""Sections other apps add to the person page (``GET /api/people/u/{id}``).

An app registers one function per section:

    from app.people import sections

    @sections.register("porch", "On Porch", order=40)
    async def porch_section(db, viewer, target) -> dict | None: ...

``people/router._page`` calls each registered function for a Promptly
account (never for yourself), in ``order``, each in its own savepoint and
with a short time limit, so one slow or failing app never breaks the page.
A function returns None for nothing to show, else::

    {"kind": "grid" | "list", "items": [...], "more_url": "/porch/u/…" | None,
     "more_label": "See all on Porch", "note": "Groups you're both in: Family"}

``grid`` items are ``{id, image, title, href}`` (a picture, or words for a
text post); ``list`` items are ``{id, title, subtitle, href}``. Everything is
the viewer's own view: each app reads through its own access rule. Notes
("Notes shared with Sam") and later apps register here too.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.people.sections")

#: How long one section may take before the page goes without it.
TIMEOUT_SECONDS = 2.5

Fn = Callable[[AsyncSession, User, User], Awaitable[dict[str, Any] | None]]


@dataclass(frozen=True)
class Section:
    key: str
    title: str
    fn: Fn
    order: int


_REGISTRY: dict[str, Section] = {}


def register(key: str, title: str, fn: Fn | None = None, order: int = 100):  # noqa: ANN201 — a decorator, or None
    """Add a section (``register(key, title, fn, order)``, or as a decorator)."""

    def add(f: Fn) -> Fn:
        _REGISTRY[key] = Section(key=key, title=title, fn=f, order=order)
        return f

    if fn is not None:
        add(fn)
        return None
    return add


def registered() -> list[Section]:
    _load()
    return sorted(_REGISTRY.values(), key=lambda s: (s.order, s.key))


_loaded = False


def _load() -> None:
    """Import the apps that register sections (once; they register on import)."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    # Porch (WP-P3.3): "On Porch".
    import app.porch.person  # noqa: F401


async def _run(s: Section, viewer: User, target: User) -> dict[str, Any] | None:
    """One section in a session of its own, so a time-out or an error can't
    leave the page's own database session half-way through a query."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        return await s.fn(db, viewer, target)


async def collect(db: AsyncSession, viewer: User, target: User) -> list[dict[str, Any]]:  # noqa: ARG001 — the page's session, unused on purpose
    """Every section with something to show, each on its own: a failure or
    a slow one is left out (and logged), never the whole page."""
    out: list[dict[str, Any]] = []
    for s in registered():
        try:
            got = await asyncio.wait_for(_run(s, viewer, target), timeout=TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 — one app's section never breaks the page
            logger.warning("person page section %s failed", s.key, exc_info=True)
            continue
        if not got or not (got.get("items") or got.get("note")):
            continue
        out.append(
            {
                "key": s.key,
                "title": s.title,
                "kind": got.get("kind", "list"),
                "items": got.get("items") or [],
                "more_url": got.get("more_url"),
                "more_label": got.get("more_label"),
                "note": got.get("note"),
            }
        )
    return out


__all__ = ["Section", "TIMEOUT_SECONDS", "collect", "register", "registered"]
