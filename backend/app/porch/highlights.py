"""Highlights and the story archive (WP-P2.4).

Your archive is every story you've posted (``GET /stories/archive``,
:mod:`app.porch.stories`), private to you. A **highlight** keeps some of
them on your profile under a name and a cover, after their day is up.

Who sees what stays the stories' own rule: each story in a highlight shows
only to people in the groups it went to (``access.visible_story`` with
``live=False`` — not deleted, no block either way, a current member of one
of its live groups). So ``GET /users/{id}/highlights`` gives each viewer
only the highlights with at least one story they may see, each holding only
those stories; Mum sees the family ones, your mates theirs. Watching a
highlight marks nothing seen.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db

from . import access, core
from .deps import require_porch
from .models import PorchHighlight, PorchHighlightItem, PorchStory

router = APIRouter()

MAX_HIGHLIGHTS = 50
MAX_ITEMS = 100


class HighlightIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    story_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_ITEMS)
    cover_story_id: uuid.UUID | None = None


class HighlightPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    # The whole list, in order (add, take out, reorder).
    story_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=MAX_ITEMS)
    cover_story_id: uuid.UUID | None = None


class AddIn(BaseModel):
    story_id: uuid.UUID


# ------------------------------------------------------------------ reading


async def _out(db: AsyncSession, viewer: User, highlights: list[PorchHighlight], *, own: bool) -> list[dict[str, Any]]:
    """Highlights as ``viewer`` sees them: only stories they may see, and
    only highlights left with at least one (yours: all of yours)."""
    from .stories import stories_out

    if not highlights:
        return []
    ids = [h.id for h in highlights]
    q = (
        select(PorchHighlightItem.highlight_id, PorchStory)
        .join(PorchStory, PorchStory.id == PorchHighlightItem.story_id)
        .where(PorchHighlightItem.highlight_id.in_(ids), access.visible_story(viewer.id, live=False))
        .order_by(PorchHighlightItem.highlight_id, PorchHighlightItem.position, PorchStory.created_at)
    )
    rows = (await db.execute(q)).all()
    stories = list({s.id: s for _h, s in rows}.values())
    shown = {d["id"]: d for d in await stories_out(db, viewer, stories, views=False)}
    by: dict[uuid.UUID, list[dict[str, Any]]] = {h: [] for h in ids}
    for hid, s in rows:
        by[hid].append(shown[str(s.id)])
    out = []
    for h in highlights:
        items = by[h.id]
        if not items:
            continue
        cover = next((s for s in items if h.cover_story_id and s["id"] == str(h.cover_story_id)), items[0])
        m = cover.get("media") or {}
        out.append(
            {
                "id": str(h.id),
                "name": h.name,
                "cover": {"story_id": cover["id"], "image": m.get("thumb") or m.get("poster"), "background": cover.get("background"), "kind": cover["kind"]},
                "count": len(items),
                "stories": items,
                "mine": own,
            }
        )
    return out


async def _mine(db: AsyncSession, user: User) -> list[PorchHighlight]:
    q = select(PorchHighlight).where(PorchHighlight.owner_id == user.id).order_by(PorchHighlight.position, PorchHighlight.created_at)
    return list((await db.execute(q)).scalars())


@router.get("/me/highlights")
async def my_highlights(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    return await _out(db, user, await _mine(db, user), own=True)


@router.get("/users/{user_id}/highlights")
async def user_highlights(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Someone's highlights, each with only the stories you may see (none of
    them: it isn't there for you)."""
    from .posts import _person

    other = await _person(db, user, user_id)
    rows = await _mine(db, other)
    return await _out(db, user, rows, own=other.id == user.id)


# ------------------------------------------------------------------ writing


async def _own_stories(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Your stories, in the order given (each once), or 404."""
    want = list(dict.fromkeys(ids))
    q = select(PorchStory.id).where(PorchStory.id.in_(want), PorchStory.author_id == user.id, PorchStory.deleted_at.is_(None))
    found = set((await db.execute(q)).scalars())
    if found != set(want):
        raise core.not_found("Story")
    return want


async def _load(db: AsyncSession, user: User, highlight_id: uuid.UUID) -> PorchHighlight:
    h = await db.get(PorchHighlight, highlight_id)
    if h is None or h.owner_id != user.id:
        raise core.not_found("Highlight")
    return h


async def _set_items(db: AsyncSession, h: PorchHighlight, story_ids: list[uuid.UUID]) -> None:
    await db.execute(delete(PorchHighlightItem).where(PorchHighlightItem.highlight_id == h.id))
    for i, sid in enumerate(story_ids):
        db.add(PorchHighlightItem(highlight_id=h.id, story_id=sid, position=i))


async def _one(db: AsyncSession, user: User, h: PorchHighlight) -> dict[str, Any]:
    got = await _out(db, user, [h], own=True)
    return got[0] if got else {"id": str(h.id), "name": h.name, "cover": None, "count": 0, "stories": [], "mine": True}


@router.post("/me/highlights", status_code=201)
async def create_highlight(body: HighlightIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    ids = await _own_stories(db, user, body.story_ids)
    n = await db.scalar(select(func.count()).select_from(PorchHighlight).where(PorchHighlight.owner_id == user.id))
    if (n or 0) >= MAX_HIGHLIGHTS:
        raise core.bad(f"You can have up to {MAX_HIGHLIGHTS} highlights")
    cover = body.cover_story_id if body.cover_story_id in ids else ids[0]
    top = await db.scalar(select(func.max(PorchHighlight.position)).where(PorchHighlight.owner_id == user.id))
    h = PorchHighlight(owner_id=user.id, name=body.name.strip(), cover_story_id=cover, position=(top or 0) + 1)
    db.add(h)
    await db.flush()
    await _set_items(db, h, ids)
    await db.commit()
    return await _one(db, user, h)


@router.patch("/me/highlights/{highlight_id}")
async def update_highlight(highlight_id: uuid.UUID, body: HighlightPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    h = await _load(db, user, highlight_id)
    if body.name is not None:
        h.name = body.name.strip()
    if body.story_ids is not None:
        await _set_items(db, h, await _own_stories(db, user, body.story_ids))
    if "cover_story_id" in body.model_fields_set and body.cover_story_id is not None:
        inside = await db.get(PorchHighlightItem, (h.id, body.cover_story_id))
        if inside is None and body.story_ids is None:
            raise core.bad("Pick a cover from the stories in this highlight")
        if body.story_ids is not None and body.cover_story_id not in body.story_ids:
            raise core.bad("Pick a cover from the stories in this highlight")
        h.cover_story_id = body.cover_story_id
    await db.commit()
    return await _one(db, user, h)


@router.delete("/me/highlights/{highlight_id}", status_code=204)
async def delete_highlight(highlight_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """The highlight goes; its stories stay in your archive."""
    h = await _load(db, user, highlight_id)
    await db.delete(h)
    await db.commit()


@router.post("/me/highlights/{highlight_id}/stories")
async def add_story(highlight_id: uuid.UUID, body: AddIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Add one of your stories at the end (once)."""
    h = await _load(db, user, highlight_id)
    await _own_stories(db, user, [body.story_id])
    if await db.get(PorchHighlightItem, (h.id, body.story_id)) is None:
        n = await db.scalar(select(func.count()).select_from(PorchHighlightItem).where(PorchHighlightItem.highlight_id == h.id))
        if (n or 0) >= MAX_ITEMS:
            raise core.bad(f"A highlight can hold up to {MAX_ITEMS} stories")
        top = await db.scalar(select(func.max(PorchHighlightItem.position)).where(PorchHighlightItem.highlight_id == h.id))
        db.add(PorchHighlightItem(highlight_id=h.id, story_id=body.story_id, position=(top if top is not None else -1) + 1))
    await db.commit()
    return await _one(db, user, h)


@router.delete("/me/highlights/{highlight_id}/stories/{story_id}")
async def remove_story(highlight_id: uuid.UUID, story_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Take a story out (it stays in your archive). A highlight left empty goes."""
    h = await _load(db, user, highlight_id)
    await db.execute(delete(PorchHighlightItem).where(PorchHighlightItem.highlight_id == h.id, PorchHighlightItem.story_id == story_id))
    left = await db.scalar(select(func.count()).select_from(PorchHighlightItem).where(PorchHighlightItem.highlight_id == h.id))
    if not left:
        await db.delete(h)
        await db.commit()
        return {"deleted": True}
    if h.cover_story_id == story_id:
        h.cover_story_id = None
    await db.commit()
    return {"deleted": False, "highlight": await _one(db, user, h)}


# ------------------------------------------------------------------ for other modules


async def story_gone(db: AsyncSession, story_id: uuid.UUID) -> None:
    """A story was deleted: out of every highlight, and a highlight left
    empty goes too. The caller commits."""
    hids = list((await db.execute(select(PorchHighlightItem.highlight_id).where(PorchHighlightItem.story_id == story_id))).scalars())
    if not hids:
        return
    await db.execute(delete(PorchHighlightItem).where(PorchHighlightItem.story_id == story_id))
    await db.flush()
    still = exists().where(PorchHighlightItem.highlight_id == PorchHighlight.id)
    await db.execute(delete(PorchHighlight).where(PorchHighlight.id.in_(hids), ~still))


async def shows_story(db: AsyncSession, user: User, story: PorchStory) -> bool:
    """An old story ``user`` may still see because it's in a highlight (and
    they're in one of its groups)."""
    if not await access.can_see_story(db, user, story.id, live=False):
        return False
    q = select(exists().where(PorchHighlightItem.story_id == story.id))
    return bool((await db.execute(q)).scalar())


__all__ = ["router", "shows_story", "story_gone"]
