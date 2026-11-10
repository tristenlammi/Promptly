"""Pinned posts (WP-P3.1; decision P1): a group's admins pin up to three
posts at the top of the group's page. Never in the feed, which stays newest
first.

A pin is ``porch_post_groups.pinned_at`` (no migration), so it lives and
dies with that post-group row: a post deleted or taken out of the group, or
the group deleted, and the pin is gone with it. Pinned posts are read
through ``access.visible_post`` like any other, so a blocked author's pin is
hidden from the person who blocked them. Everyone's admins are the server
admins.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db

from . import access, core
from .deps import require_porch
from .models import PorchGroup, PorchPost, PorchPostGroup

router = APIRouter()

MAX_PINS = 3


async def _run(db: AsyncSession, user: User, group_id: uuid.UUID) -> PorchGroup:
    g, m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Posts show once you join")
    if not access.is_admin(user, g, m):
        raise core.forbidden("Only the group's admins can pin posts")
    return g


def _pinned(group_id: uuid.UUID):  # noqa: ANN202 — SQL
    return select(PorchPostGroup.post_id).where(PorchPostGroup.group_id == group_id, PorchPostGroup.pinned_at.is_not(None))


async def pinned_count(db: AsyncSession, group_id: uuid.UUID) -> int:
    """Live posts pinned in a group (a deleted post's pin doesn't count)."""
    q = (
        select(func.count())
        .select_from(PorchPostGroup)
        .join(PorchPost, PorchPost.id == PorchPostGroup.post_id)
        .where(PorchPostGroup.group_id == group_id, PorchPostGroup.pinned_at.is_not(None), PorchPost.deleted_at.is_(None))
    )
    return int((await db.execute(q)).scalar() or 0)


@router.get("/groups/{group_id}/pins")
async def pins(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """The group's pinned posts you can see, the latest pinned first
    (members only, like the group's posts)."""
    from .posts import posts_out

    g, _m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Posts show once you join")
    q = (
        select(PorchPost)
        .join(PorchPostGroup, PorchPostGroup.post_id == PorchPost.id)
        .where(PorchPostGroup.group_id == g.id, PorchPostGroup.pinned_at.is_not(None), access.visible_post(user.id))
        .order_by(PorchPostGroup.pinned_at.desc())
        .limit(MAX_PINS)
    )
    return await posts_out(db, user, list((await db.execute(q)).scalars()))


async def _row(db: AsyncSession, user: User, g: PorchGroup, post_id: uuid.UUID) -> PorchPostGroup:
    await access.load_post(db, user, post_id)
    row = await db.get(PorchPostGroup, (post_id, g.id))
    if row is None:
        raise core.bad(f"That post isn't in {g.name}")
    return row


async def _tell(db: AsyncSession, g: PorchGroup, post_id: uuid.UUID) -> None:
    """Everyone in the group: refresh its page (ids only)."""
    await core.publish(await access.group_member_ids(db, g), {"type": "group", "group_id": str(g.id)})
    await core.publish(await access.group_member_ids(db, g), {"type": "post_change", "post_id": str(post_id)})


@router.put("/groups/{group_id}/pins/{post_id}")
async def pin(group_id: uuid.UUID, post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    g = await _run(db, user, group_id)
    row = await _row(db, user, g, post_id)
    if row.pinned_at is None:
        if await pinned_count(db, g.id) >= MAX_PINS:
            raise core.bad(f"{g.name} has {MAX_PINS} pinned posts already. Unpin one first.")
        row.pinned_at = core.now()
        await db.commit()
        await _tell(db, g, post_id)
    return {"pinned": True, "group_id": str(g.id), "post_id": str(post_id)}


@router.delete("/groups/{group_id}/pins/{post_id}")
async def unpin(group_id: uuid.UUID, post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    g = await _run(db, user, group_id)
    row = await db.get(PorchPostGroup, (post_id, g.id))
    if row is not None and row.pinned_at is not None:
        row.pinned_at = None
        await db.commit()
        await _tell(db, g, post_id)
    return {"pinned": False, "group_id": str(g.id), "post_id": str(post_id)}


async def pin_groups(db: AsyncSession, viewer: User, posts: list[PorchPost]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """For each post, the groups it's in that ``viewer`` runs, and whether
    it's pinned there: the "…" menu's Pin to Family / Unpin entries."""
    run = {m.group.id: m.group for m in await access.my_groups(db, viewer) if m.is_admin}
    out: dict[uuid.UUID, list[dict[str, Any]]] = {p.id: [] for p in posts}
    if not run or not posts:
        return out
    q = select(PorchPostGroup).where(PorchPostGroup.post_id.in_([p.id for p in posts]), PorchPostGroup.group_id.in_(list(run)))
    for row in (await db.execute(q)).scalars():
        g = run[row.group_id]
        out[row.post_id].append({**access.group_label(g), "pinned": row.pinned_at is not None})
    for pid in out:
        out[pid].sort(key=lambda d: (d["kind"] == "everyone", d["name"].lower()))
    return out


__all__ = ["MAX_PINS", "pin_groups", "pinned_count", "router"]
