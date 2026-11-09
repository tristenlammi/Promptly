"""Porch and the rest of Promptly (build §7, WP-P1.6): a post's card for
Rooms and links, "Reply privately", "Make this an event", and the photo
"uses" count behind Photos' trash warning.

Every one of these goes through :mod:`app.porch.access`:

* **Card** (``card``): what a Rooms "Send to…" card or a ``porch_post``
  link shows — None for anyone who can't see the post (Rooms then draws
  "This post isn't shared with you"). Sharing a post never shares it.
* **Reply privately**: the 1:1 Rooms conversation with the post's author
  (``rooms.service.open_dm``), refused by a block either way (decision D7);
  the app then opens it with the post attached (``?share=porch_post:<id>``).
* **Make this an event**: the Calendar's own editor, filled in from the
  post; its guests can only be people who can see the post
  (:func:`check_event`, called by ``calendars/router.create_event`` for an
  event whose ``source`` is ``{"kind": "porch_post"}``).
* **Uses**: how many live Porch posts one of *your* photos is in, for
  "This photo is in 2 Porch posts" before it goes to the trash.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db

from . import access, core, deps, media
from .deps import require_porch
from .models import PorchPost, PorchPostMedia

router = APIRouter()

KIND = "porch_post"


def _first_line(text: str, n: int = 80) -> str:
    line = next((x.strip() for x in (text or "").splitlines() if x.strip()), "")
    line = re.sub(r"\s+", " ", line)
    return line if len(line) <= n else line[: n - 1].rstrip() + "…"


def _day(at: datetime | None, zone: Any = None) -> str:
    """"3 Nov" (with the year when it isn't this one), in the viewer's own
    time zone when they've set one."""
    if at is None:
        return ""
    now = core.now()
    if zone is not None:
        at, now = at.astimezone(zone), now.astimezone(zone)
    d = at.date()
    return f"{d.day} {d.strftime('%b')}" + ("" if d.year == now.year else f" {d.year}")


def what(post: PorchPost, author_name: str, n_media: int) -> str:
    """A post in a few words, for when it has none of its own."""
    if post.kind == "life_event" and post.life_event:
        return str(post.life_event.get("title") or "") or f"{author_name}'s news"
    if post.kind == "video":
        return f"{author_name}'s video" if n_media <= 1 else f"{author_name}'s {n_media} videos"
    if post.kind == "photo":
        return f"{author_name}'s photo" if n_media <= 1 else f"{author_name}'s {n_media} photos"
    if post.kind == "poll":
        return f"{author_name}'s poll"
    if post.link:
        return str(post.link.get("title") or post.link.get("url") or "") or f"{author_name}'s post"
    return f"{author_name}'s post"


async def summaries(db: AsyncSession, viewer: User, posts: list[PorchPost]) -> dict[uuid.UUID, dict[str, Any]]:
    """Each post (that ``viewer`` can see — callers check) as a small card:
    ``{id, title, subtitle, author, thumb, href, created_at}``."""
    if not posts:
        return {}
    ids = [p.id for p in posts]
    medias = await media.live_media(db, ids)
    people = await core.users_map(db, {p.author_id for p in posts})
    labels = await access.labels(db, viewer, ids)
    from app.photos.library import user_zone

    zone = user_zone(viewer)
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for p in posts:
        author = people.get(str(p.author_id))
        name = author["name"] if author else "Someone"
        items = medias.get(p.id, [])
        thumb = None
        if items:
            pm, row, fm = items[0]
            m = media.media_out(viewer, pm, row, fm, author=False)
            thumb = m.get("thumb") or m.get("poster")
        title = _first_line(p.body) or what(p, name, len(items))
        where = " · ".join(g["name"] for g in labels.get(p.id, [])[:2])
        bits = [name if p.author_id != viewer.id else "You"]
        if where:
            bits.append(f"in {where}")
        bits.append(_day(p.created_at, zone))
        out[p.id] = {
            "id": str(p.id),
            "title": title,
            "subtitle": " · ".join(b for b in bits if b),
            "author": author,
            "thumb": thumb,
            "href": f"/porch/p/{p.id}",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
    return out


async def card(db: AsyncSession, viewer: User, post_id: uuid.UUID | str | None) -> dict[str, Any] | None:
    """The post's card as ``viewer`` sees it, or None when they can't see it
    (or it's gone, or Porch isn't on for them) — never why."""
    try:
        pid = uuid.UUID(str(post_id))
    except (TypeError, ValueError):
        return None
    if not await deps.allowed(db, viewer):
        return None
    post = (await db.execute(select(PorchPost).where(PorchPost.id == pid, access.visible_post(viewer.id)))).scalar_one_or_none()
    if post is None:
        return None
    s = (await summaries(db, viewer, [post]))[post.id]
    return {
        "title": s["title"],
        "subtitle": "Porch · " + s["subtitle"],
        "thumb": s["thumb"],
        "href": s["href"],
    }


@router.get("/posts/{post_id}/card")
async def post_card(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    got = await card(db, user, post_id)
    if got is None:
        raise core.not_found()
    return got


# ------------------------------------------------------------------ reply privately


@router.post("/posts/{post_id}/reply")
async def reply_privately(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Your 1:1 conversation with the post's author, made if new. The app
    opens it with the post attached; nothing is sent until you send it.
    A block either way refuses it (decision D7) — and hides the post too."""
    from app.people.blocks import dm_refusal
    from app.rooms import service as rooms_service

    post = await access.load_post(db, user, post_id)
    if post.author_id == user.id:
        raise core.bad("That's your own post")
    why = await dm_refusal(db, user.id, post.author_id)
    if why:
        raise core.forbidden(why)
    room = await rooms_service.open_dm(db, user, [post.author_id])
    return {"room_id": str(room.id), "share": f"{KIND}:{post.id}", "url": f"/rooms/r/{room.id}?share={KIND}:{post.id}"}


# ------------------------------------------------------------------ make an event


async def check_event(db: AsyncSession, user: User, post_id: uuid.UUID, guest_ids: list[uuid.UUID]) -> None:
    """An event made from a post: you must see the post, and so must every
    guest you invite (else 400, naming nobody's access)."""
    if not await deps.allowed(db, user):
        raise core.not_found()
    post = await access.load_post(db, user, post_id)
    if not guest_ids:
        return
    audience = await access.audience_ids(db, post)
    if any(g not in audience for g in guest_ids):
        raise core.bad("Only people who can see the post can be invited from it")


async def check_new_guests(db: AsyncSession, event: Any, guest_ids: list[uuid.UUID]) -> None:
    """Editing an event made from a post: anyone newly invited must be able
    to see the post too (while it's there). People already on it stay."""
    src = event.source or {}
    if src.get("kind") != KIND:
        return
    from app.calendars.models import CalAttendee

    have = set((await db.execute(select(CalAttendee.user_id).where(CalAttendee.event_id == event.id))).scalars())
    new = [g for g in guest_ids if g not in have and g != event.created_by]
    if not new:
        return
    try:
        post = await db.get(PorchPost, uuid.UUID(str(src.get("post_id"))))
    except (TypeError, ValueError):
        return
    if post is None or post.deleted_at is not None:
        return
    audience = await access.audience_ids(db, post)
    if any(g not in audience for g in new):
        raise core.bad("Only people who can see the post can be invited from it")


@router.get("/posts/{post_id}/event")
async def event_prefill(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """What "Make this an event" starts with: the post's words and place,
    and the people who can see it (the only ones it can invite)."""
    post = await access.load_post(db, user, post_id)
    audience = await access.audience_ids(db, post)
    audience.discard(user.id)
    people = (await db.execute(select(User).where(User.id.in_(audience), User.disabled.is_(False)).order_by(User.username))).scalars().all() if audience else []
    author = await db.get(User, post.author_id)
    body = (post.body or "").strip()
    title = _first_line(body, 120)
    if not title and post.kind == "life_event" and post.life_event:
        title = str(post.life_event.get("title") or "")
    return {
        "title": title,
        "body": body,
        "location": (post.place or {}).get("name") or "",
        "author": core.user_out(author) if author else None,
        "url": f"/porch/p/{post.id}",
        "guests": [core.user_out(u) for u in people],
    }


# ------------------------------------------------------------------ uses (Photos' trash warning)


async def uses(db: AsyncSession, user: User, file_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """For each of *your* files, how many live Porch posts it's in. Other
    people's files count as 0 (nothing is said about them)."""
    from app.files.models import UserFile

    if not file_ids:
        return {}
    q = (
        select(PorchPostMedia.file_id, func.count(func.distinct(PorchPostMedia.post_id)))
        .join(PorchPost, PorchPost.id == PorchPostMedia.post_id)
        .join(UserFile, UserFile.id == PorchPostMedia.file_id)
        .where(PorchPostMedia.file_id.in_(file_ids), PorchPost.deleted_at.is_(None), UserFile.user_id == user.id)
        .group_by(PorchPostMedia.file_id)
    )
    got = {fid: int(n) for fid, n in (await db.execute(q)).all()}
    return {fid: got.get(fid, 0) for fid in file_ids}


async def _posts_with(db: AsyncSession, user: User, file_ids: list[uuid.UUID]) -> int:
    from app.files.models import UserFile

    if not file_ids:
        return 0
    q = (
        select(func.count(func.distinct(PorchPostMedia.post_id)))
        .join(PorchPost, PorchPost.id == PorchPostMedia.post_id)
        .join(UserFile, UserFile.id == PorchPostMedia.file_id)
        .where(PorchPostMedia.file_id.in_(file_ids), PorchPost.deleted_at.is_(None), UserFile.user_id == user.id)
    )
    return int((await db.execute(q)).scalar() or 0)


@router.get("/files/{file_id}/uses")
async def file_uses(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """How many Porch posts one of your photos is in."""
    n = (await uses(db, user, [file_id])).get(file_id, 0)
    return {"file_id": str(file_id), "posts": n}


class UsesIn(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)


@router.post("/files/uses")
async def files_uses(body: UsesIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """The same for a selection: the number of posts any of them is in, and
    how many of the photos are in one."""
    ids = list(dict.fromkeys(body.file_ids))
    each = await uses(db, user, ids)
    return {"posts": await _posts_with(db, user, ids), "photos": sum(1 for n in each.values() if n)}


__all__ = ["KIND", "card", "check_event", "check_new_guests", "router", "summaries", "uses", "what"]
