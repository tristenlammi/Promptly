"""Searching Porch (build §3.10): posts you can see, by their words.

* **Words**: the post's text and place (``porch_posts.body_tsv``, simple and
  English, the word being typed included), a life event's title, a link's
  title, and the photos' descriptions (alt text). Comments aren't searched.
* **People**: a word that is someone's name ("beach Sam") narrows the
  search to what they posted. Only people with Porch you have no block
  with count.
* **Not by what's in a photo.** Porch posts are never matched by a model
  (it used to run Photos' image search over the photos of posts you could
  see; removed 2026-11-15, owner rule: Porch and Rooms are never read or
  indexed by AI). Your own Photos library still has its own search, in
  Photos and in the composer's picker.

Every query is limited by :func:`access.visible_post_sql`, so nothing you
can't see is ever matched, counted or named — whoever's photos they are.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, deps, handoffs
from .deps import require_porch
from .models import PorchPost

logger = logging.getLogger("promptly.porch.search")

router = APIRouter()

_WORD = re.compile(r"[\w'’.-]+", re.UNICODE)


def _esc(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _like(term: str) -> str:
    return "%" + _esc(term) + "%"


async def _names(db: AsyncSession, user: User, q: str) -> tuple[list[uuid.UUID], str]:
    """People named in the query (a whole word that is their username or a
    word of their name), and the query without them."""
    words = _WORD.findall(q)
    if not words:
        return [], q
    low = {w.lower().strip(".'’").removesuffix("'s").removesuffix("’s") for w in words if len(w) >= 2}
    if not low:
        return [], q
    s = await deps.settings(db)
    conds = [User.username.ilike(_esc(w), escape="\\") for w in low] + [User.settings["display_name"].astext.ilike(_like(w), escape="\\") for w in low]
    rows = (await db.execute(select(User).where(deps.allowed_clause(s, User.id), or_(*conds)).limit(50))).scalars().all()
    hidden = await blocks.hidden_ids(db, user.id)
    found: list[uuid.UUID] = []
    used: set[str] = set()
    for u in rows:
        if u.id in hidden:
            continue
        names = {u.username.lower(), *(x.lower() for x in core.display_name(u).split())}
        hit = low & names
        if hit:
            found.append(u.id)
            used |= hit
    if not found:
        return [], q
    rest = " ".join(w for w in words if w.lower().strip(".'’").removesuffix("'s").removesuffix("’s") not in used)
    return found, rest.strip()


async def _word_hits(db: AsyncSession, user: User, term: str, authors: list[uuid.UUID], limit: int) -> list[uuid.UUID]:
    from app.chat.router import partial_word_query

    params: dict[str, Any] = {"me": user.id, "n": limit}
    where = [access.visible_post_sql("p")]
    if authors:
        where.append("p.author_id = ANY(:authors)")
        params["authors"] = authors
    if term:
        partial = partial_word_query(term)
        tsq = "(websearch_to_tsquery('simple', :q) || websearch_to_tsquery('english', :q)"
        tsq += " || to_tsquery('simple', :partial))" if partial else ")"
        params.update(q=term, like=_like(term))
        if partial:
            params["partial"] = partial
        where.append(
            f"""(p.body_tsv @@ {tsq}
                OR coalesce(p.life_event->>'title', '') ILIKE :like ESCAPE '\\'
                OR coalesce(p.link->>'title', '') ILIKE :like ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM porch_post_media pm JOIN files f ON f.id = pm.file_id AND f.trashed_at IS NULL
                           WHERE pm.post_id = p.id AND pm.alt_text ILIKE :like ESCAPE '\\'))"""
        )
    sql = f"SELECT p.id FROM porch_posts p WHERE {' AND '.join(where)} ORDER BY p.created_at DESC, p.id DESC LIMIT :n"
    return list((await db.execute(text(sql), params)).scalars())


async def find(db: AsyncSession, user: User, q: str, limit: int = 30) -> list[PorchPost]:
    """Posts you can see that answer ``q``, newest first. Words only."""
    q = (q or "").strip()[:200]
    if len(q) < 2 or not await deps.allowed(db, user):
        return []
    authors, rest = await _names(db, user, q)
    order = (await _word_hits(db, user, rest, authors, limit) if (rest or authors) else [])[:limit]
    if not order:
        return []
    rows = {p.id: p for p in (await db.execute(select(PorchPost).where(PorchPost.id.in_(order), access.visible_post(user.id)))).scalars()}
    return [rows[i] for i in order if i in rows]


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(30, ge=1, le=60),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_porch),
) -> dict:
    """Porch's search sheet: posts you can see, as small cards (a grid with
    the poster's name)."""
    posts = await find(db, user, q, limit)
    cards = await handoffs.summaries(db, user, posts)
    return {"results": [{**cards[p.id], "kind": p.kind} for p in posts]}


async def quick(db: AsyncSession, user: User, q: str, limit: int = 5) -> list[dict[str, Any]]:
    """Ctrl+K's "Porch" rows (empty when Porch isn't on for you)."""
    posts = await find(db, user, q, limit)
    cards = await handoffs.summaries(db, user, posts)
    return [{k: cards[p.id][k] for k in ("id", "title", "subtitle", "thumb")} | {"url": cards[p.id]["href"]} for p in posts]


__all__ = ["find", "quick", "router"]
