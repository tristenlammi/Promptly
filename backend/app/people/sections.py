"""Sections other apps add to the person page (``/api/people/u/{id}``).

Notes ("Notes you share with Sam", phase 2 N2.5) and Porch ("On Porch", WP-P3.3)
each add a section to Sam's page without the people router knowing about
them. An app registers once, at import:

    sections.register("notes", "Notes", notes_section, order=50)

``fn(db, viewer, target)`` returns the section's items (``[]`` hides it), or a
dict ``{"items": [...], "more_url": "..."}``. It only ever looks at what the
viewer can already open. Each runs in its own try with a short time limit: a
failing or slow section is left off and the page still shows.

What the page gets: ``sections: [{key, title, kind: "grid" | "list", items,
more_url}]``, in ``order``. An item is ``{id, title, subtitle?, href, color?,
thumb?}`` (``color`` is a Notes palette key).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.people.sections")

TIME_LIMIT_S = 3.0

SectionFn = Callable[[AsyncSession, User, User], Awaitable[list[dict] | dict[str, Any]]]


@dataclass(frozen=True)
class Section:
    key: str
    title: str
    fn: SectionFn
    order: int = 100
    kind: str = "grid"


_REGISTRY: dict[str, Section] = {}


def register(key: str, title: str, fn: SectionFn, order: int = 100, kind: str = "grid") -> None:
    """Add (or replace) a section. ``kind``: "grid" (cards) or "list" (rows)."""
    if kind not in ("grid", "list"):
        raise ValueError("kind is grid or list")
    _REGISTRY[key] = Section(key=key, title=title, fn=fn, order=order, kind=kind)


def registered() -> list[Section]:
    _load_builtins()
    return sorted(_REGISTRY.values(), key=lambda s: (s.order, s.key))


_loaded = False


def _load_builtins() -> None:
    """Apps that add a section, imported on first use (no import cycles at
    start-up). Append a line per app."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    # Notes phase 2 (N2.5).
    import app.notes.people  # noqa: F401


async def for_page(db: AsyncSession, viewer: User, target: User) -> list[dict[str, Any]]:
    """Every section with something in it, for ``viewer`` looking at ``target``."""
    out: list[dict[str, Any]] = []
    for s in registered():
        try:
            # A savepoint each: a failing query is undone without touching
            # the rest of the page (or expiring what it already loaded).
            async with db.begin_nested(), asyncio.timeout(TIME_LIMIT_S):
                got = await s.fn(db, viewer, target)
        except Exception as e:  # noqa: BLE001 — one app failing leaves its section off, not the page
            logger.warning("Person page section %s failed: %s", s.key, type(e).__name__)
            continue
        items, more = (got.get("items") or [], got.get("more_url")) if isinstance(got, dict) else (got or [], None)
        if items:
            out.append({"key": s.key, "title": s.title, "kind": s.kind, "items": items, "more_url": more})
    return out


__all__ = ["Section", "for_page", "register", "registered"]
