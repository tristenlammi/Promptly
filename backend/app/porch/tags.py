"""Tagging people on photos (build §3.3, §3.8).

* Only the post's author tags, and only people who can see the post
  (``access.audience_ids``: in its groups, Porch on for them, no block
  either way with the author). Anyone else is left out, as with @mentions.
* A tag starts **pending** and shows only after the tagged person says yes
  (from Activity: **Show it** / **Not me**). Until then only the author and
  the tagged person know about it. "Not me" (or removing a tag later) marks
  it declined, so the same person isn't asked about that photo again.
* **Face suggestions**: a face in the poster's own photo whose Photos person
  (the poster's own Photos people and Contacts, ``people.directory``) is a
  Promptly account who can see the post — only when both people turned on
  "Suggest tags from my faces" (``porch_profiles.face_suggestions``).
  Nothing is read from anyone else's Photos people.

A tag's point (``box`` ``{x, y}``) is a share of the photo as posted.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, activity, core
from .deps import require_porch
from .models import PorchPost, PorchPostMedia, PorchProfile, PorchTag

router = APIRouter()


class TagIn(BaseModel):
    user_id: uuid.UUID
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


async def sync(db: AsyncSession, post: PorchPost, media_row: PorchPostMedia, wanted: list[TagIn] | None, audience: set[uuid.UUID]) -> list[uuid.UUID]:
    """Make one photo's tags what the author asked for: new people are asked
    (pending), people taken off are untagged, the rest keep their answer
    (with the point moved). Someone who said no stays declined. Returns who
    was newly asked. Flushed, not committed."""
    if wanted is None:
        return []
    want: dict[uuid.UUID, TagIn] = {}
    for t in wanted:
        if t.user_id in audience and t.user_id != post.author_id:
            want[t.user_id] = t
    existing = {t.tagged_user_id: t for t in (await db.execute(select(PorchTag).where(PorchTag.media_id == media_row.id))).scalars()}
    asked: list[uuid.UUID] = []
    for uid, row in existing.items():
        if uid not in want and row.status != "declined":
            await db.delete(row)
    for uid, t in want.items():
        box = {"x": round(t.x, 4), "y": round(t.y, 4)}
        row = existing.get(uid)
        if row is not None:
            if row.status != "declined":
                row.box = box
            continue
        db.add(PorchTag(post_id=post.id, media_id=media_row.id, tagged_user_id=uid, tagged_by=post.author_id, box=box, status="pending", created_at=core.now()))
        asked.append(uid)
    await db.flush()
    return asked


async def decorate(db: AsyncSession, viewer: User, posts: list[PorchPost], out: list[dict[str, Any]]) -> None:
    """Each photo's tags as ``viewer`` sees them: approved ones; the author
    also sees who hasn't answered yet, and the tagged person their own
    request. Nobody with a block either way with the viewer."""
    media_ids = [uuid.UUID(m["id"]) for d in out for m in d.get("media", [])]
    for d in out:
        for m in d.get("media", []):
            m["tags"] = []
    if not media_ids:
        return
    authors = {p.id: p.author_id for p in posts}
    rows = list(
        (
            await db.execute(
                select(PorchTag).where(PorchTag.media_id.in_(media_ids), PorchTag.status != "declined").order_by(PorchTag.created_at)
            )
        ).scalars()
    )
    hidden = await blocks.hidden_ids(db, viewer.id)
    shown = [
        t for t in rows
        if t.tagged_user_id not in hidden
        and (t.status == "approved" or authors.get(t.post_id) == viewer.id or t.tagged_user_id == viewer.id)
    ]
    if not shown:
        return
    people = await core.users_map(db, {t.tagged_user_id for t in shown})
    by_media: dict[str, list[dict[str, Any]]] = {}
    for t in shown:
        u = people.get(str(t.tagged_user_id))
        if u is None:
            continue
        box = t.box or {}
        by_media.setdefault(str(t.media_id), []).append(
            {"id": str(t.id), "user": u, "x": box.get("x", 0.5), "y": box.get("y", 0.5), "status": t.status}
        )
    for d in out:
        for m in d.get("media", []):
            m["tags"] = by_media.get(m["id"], [])


# ------------------------------------------------------------------ answering


async def _mine(db: AsyncSession, user: User, tag_id: uuid.UUID) -> tuple[PorchTag, PorchPost]:
    """A tag of you, on a post you can still see."""
    t = await db.get(PorchTag, tag_id)
    if t is None or t.tagged_user_id != user.id:
        raise core.not_found("Tag")
    post = await access.load_post(db, user, t.post_id)
    return t, post


async def _changed(db: AsyncSession, post: PorchPost) -> None:
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})


@router.post("/tags/{tag_id}/approve")
async def approve(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """"Show it": the tag shows on the photo for everyone who sees the post."""
    t, post = await _mine(db, user, tag_id)
    if t.status == "declined":
        raise core.not_found("Tag")
    if t.status != "approved":
        t.status, t.decided_at = "approved", core.now()
        await db.commit()
        await _changed(db, post)
        await activity.tell(db, [user.id])
    return {"id": str(t.id), "status": t.status}


@router.post("/tags/{tag_id}/decline")
async def decline(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """"Not me" (or take an approved tag off): it never shows, and you
    aren't asked about this photo again."""
    t, post = await _mine(db, user, tag_id)
    was = t.status
    if was != "declined":
        t.status, t.decided_at = "declined", core.now()
        await db.commit()
        if was == "approved":
            await _changed(db, post)
        await activity.tell(db, [user.id])
    return {"id": str(t.id), "status": t.status}


@router.delete("/tags/{tag_id}", status_code=204)
async def remove(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """The post's author takes a tag off; the tagged person declines it."""
    t = await db.get(PorchTag, tag_id)
    if t is None:
        raise core.not_found("Tag")
    post = await access.load_post(db, user, t.post_id)
    if t.tagged_user_id == user.id:
        t.status, t.decided_at = "declined", core.now()
    elif post.author_id == user.id:
        await db.delete(t)
    else:
        raise core.not_found("Tag")
    await db.commit()
    await _changed(db, post)


# ------------------------------------------------------------------ face suggestions


class SuggestIn(BaseModel):
    file_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    groups: Literal["all"] | list[uuid.UUID] | None = None
    post_id: uuid.UUID | None = None


async def _people_accounts(db: AsyncSession, user: User) -> dict[uuid.UUID, uuid.UUID]:
    """Your own Photos people → the Promptly account each one is (through
    your Contacts, or linked directly). Only your own data."""
    out: dict[uuid.UUID, uuid.UUID] = {}
    try:
        from app.people.directory import directory

        for p in await directory(db, user):
            if p.person_id is not None and p.user is not None and p.user.id != user.id:
                out[p.person_id] = p.user.id
    except Exception:  # noqa: BLE001 — a nicety; never fail the composer
        core.logger.warning("porch tag suggestions: directory failed", exc_info=True)
    rows = await db.execute(
        text("SELECT id, linked_user_id FROM photo_people WHERE user_id = :u AND kind = 'person' AND linked_user_id IS NOT NULL AND linked_user_id <> :u"),
        {"u": user.id},
    )
    for pid, uid in rows.all():
        out.setdefault(pid, uid)
    return out


@router.post("/compose/tag-suggestions")
async def suggestions(body: SuggestIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Faces in your photos that are people who'd see the post, for the
    composer to offer as tags. Only when you and they both turned on
    "Suggest tags from my faces"."""
    me = await db.get(PorchProfile, user.id)
    if me is None or not me.face_suggestions:
        return {"enabled": False, "suggestions": []}
    if not body.file_ids:
        return {"enabled": True, "suggestions": []}
    if body.post_id is not None:
        post = await access.load_post(db, user, body.post_id)
        if post.author_id != user.id:
            raise core.not_found("Post")
        audience = await access.audience_ids(db, post)
    else:
        from .posts import _audience

        gids = await _audience(db, user, body.groups if body.groups is not None else "all")
        mine = {m.group.id: m.group for m in await access.my_groups(db, user)}
        audience = await access.groups_audience(db, [mine[g] for g in gids if g in mine], author_id=user.id)
    audience.discard(user.id)
    audience -= await blocks.hidden_ids(db, user.id)
    if not audience:
        return {"enabled": True, "suggestions": []}
    faces = (
        await db.execute(
            text(
                "SELECT f.file_id, f.person_id, f.box_x, f.box_y, f.box_w, f.box_h FROM photo_faces f "
                "JOIN photo_people p ON p.id = f.person_id AND p.user_id = :u "
                "WHERE f.user_id = :u AND f.file_id = ANY(:files) AND f.person_id IS NOT NULL "
                "ORDER BY f.size_px DESC"
            ),
            {"u": user.id, "files": list(dict.fromkeys(body.file_ids))},
        )
    ).all()
    if not faces:
        return {"enabled": True, "suggestions": []}
    accounts = await _people_accounts(db, user)
    candidates = {accounts[f.person_id] for f in faces if f.person_id in accounts} & audience
    if not candidates:
        return {"enabled": True, "suggestions": []}
    opted = set(
        (await db.execute(select(PorchProfile.user_id).where(PorchProfile.user_id.in_(candidates), PorchProfile.face_suggestions.is_(True)))).scalars()
    )
    people = await core.users_map(db, opted)
    out: list[dict[str, Any]] = []
    seen: set[tuple[uuid.UUID, uuid.UUID]] = set()
    for f in faces:
        uid = accounts.get(f.person_id)
        if uid not in opted or (f.file_id, uid) in seen or str(uid) not in people:
            continue
        seen.add((f.file_id, uid))
        out.append(
            {
                "file_id": str(f.file_id),
                "user": people[str(uid)],
                # The middle of the face, as shares of the upright photo.
                "x": round(min(1.0, max(0.0, f.box_x + f.box_w / 2)), 4),
                "y": round(min(1.0, max(0.0, f.box_y + f.box_h / 2)), 4),
            }
        )
    return {"enabled": True, "suggestions": out}


__all__ = ["TagIn", "decorate", "router", "sync"]
