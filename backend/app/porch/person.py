"""Porch on the People person page (WP-P3.3): an **On Porch** section.

Up to six of their recent posts that *you* can see (``access.visible_post``:
a photo's tile, or a line of a text post), the groups you're both in (only
ever your own groups), and "See all on Porch". Nothing at all when Porch is
off for either of you or there's a block either way. Registered with
:mod:`app.people.sections`.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import blocks, sections

from . import access, deps, handoffs
from .models import PorchGroup, PorchGroupMember, PorchPost

MAX_POSTS = 6
MAX_GROUPS = 5


@sections.register("porch", "On Porch", order=40)
async def porch_section(db: AsyncSession, viewer: User, target: User) -> dict[str, Any] | None:
    if viewer.id == target.id:
        return None
    if not await deps.allowed(db, viewer) or not await deps.allowed(db, target):
        return None
    if await blocks.either(db, viewer.id, target.id):
        return None
    q = (
        select(PorchPost)
        .where(PorchPost.author_id == target.id, access.visible_post(viewer.id))
        .order_by(PorchPost.created_at.desc(), PorchPost.id.desc())
        .limit(MAX_POSTS)
    )
    posts = list((await db.execute(q)).scalars())
    cards = await handoffs.summaries(db, viewer, posts)
    items = [
        {"id": str(p.id), "image": cards[p.id]["thumb"], "title": cards[p.id]["title"], "href": cards[p.id]["href"], "at": cards[p.id]["created_at"]}
        for p in posts
    ]
    theirs = select(PorchGroupMember.group_id).where(PorchGroupMember.user_id == target.id, PorchGroupMember.status == "member")
    shared = (
        await db.execute(
            select(PorchGroup.name, PorchGroup.emoji)
            .join(PorchGroupMember, PorchGroupMember.group_id == PorchGroup.id)
            .where(
                PorchGroupMember.user_id == viewer.id, PorchGroupMember.status == "member", PorchGroup.kind == "custom",
                PorchGroup.deleted_at.is_(None), PorchGroup.id.in_(theirs),
            )
            .order_by(PorchGroup.name)
        )
    ).all()
    names = [f"{e} {n}".strip() for n, e in shared]
    if len(names) > MAX_GROUPS:
        names = names[:MAX_GROUPS] + [f"{len(shared) - MAX_GROUPS} more"]
    note = ("Groups you're both in: " + ", ".join(names)) if names else None
    if not items and not note:
        return None
    return {"kind": "grid", "items": items, "more_url": f"/porch/u/{target.id}", "more_label": "See all on Porch", "note": note}


__all__ = ["porch_section"]
