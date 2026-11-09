"""Stories (WP-P2.1; plan "Phases 2–3", decisions S1–S4).

A photo, video or text story is posted to groups exactly as a post is ("All
my groups", or one or a few of yours, fixed when it's posted) and seen by
the same people, **for 24 hours** (``porch_stories.expires_at``). Expiry is
read-time (``access.visible_story``): there is no job, and the row stays for
your own archive and highlights (WP-P2.4).

* **The row** (``GET /stories``): the people with live stories in the groups
  you've ticked, unseen first, then newest; your own circle separately. A
  person whose live stories you see through one group only gets that
  group's emoji on their ring.
* **Watching** (``GET /stories/u/{id}``): someone's live stories you can see,
  oldest first; ``POST /stories/{id}/view`` marks one seen. Only the poster
  sees who viewed (``GET /stories/{id}/viewers``), less anyone with a block
  either way.
* **Posting** (``POST /stories``): your own library photo or video (taken or
  uploaded through Files' ``route=camera``, so it lands in Photos), with a
  9:16 crop for this story only (``edit``), or words on a colour. Videos up
  to a minute (S4). Stickers: text, @mention and place only (S1);
  @mentions only for people in the chosen groups.
* **Media**: signed ``/m/`` links with their own claim kinds
  (``porch_story_*``, the id is the story), served only while the viewer can
  see the story — so a link stops at expiry for everyone but the poster
  (and anyone a highlight still shows it to).
* **Push**: only "Sam mentioned you in a story" (S3). Stories are never
  searched and never reach chat or memory.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import exists, func, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.files import media_urls
from app.files.models import FileMedia, UserFile
from app.people import blocks

from . import access, core, deps, media, push
from .deps import require_porch
from .models import PorchStory, PorchStoryGroup, PorchStoryView

router = APIRouter()

LIFETIME = timedelta(hours=24)
#: Decision S4: story videos up to a minute.
VIDEO_MAX_SECONDS = 60
VIDEO_TOO_LONG = "Stories can be up to a minute. Post it instead?"
#: The six backgrounds of a text story (the app draws each one).
BACKGROUNDS = ("sunset", "ocean", "forest", "berry", "night", "sand")
TEXT_STYLES = ("classic", "bold", "box")
MAX_OVERLAYS = 12
#: Live stories one person can have at once (24 h).
MAX_LIVE = 30
ARCHIVE_PAGE = 60


# ------------------------------------------------------------------ input


class PlaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


class OverlayIn(BaseModel):
    """One sticker: where it sits (shares of the 9:16 frame, its middle),
    its size and turn, and what it is."""

    type: Literal["text", "mention", "place"]
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    scale: float = Field(default=1.0, ge=0.3, le=4.0)
    rotate: float = Field(default=0.0, ge=-180, le=180)
    style: Literal["classic", "bold", "box"] = "classic"
    text: str = Field(default="", max_length=200)
    user_id: uuid.UUID | None = None
    place: PlaceIn | None = None


class StoryIn(BaseModel):
    kind: Literal["photo", "video", "text"]
    groups: Literal["all"] | list[uuid.UUID]
    file_id: uuid.UUID | None = None
    edit: dict[str, Any] | None = None
    text: str = Field(default="", max_length=500)
    background: str | None = Field(default=None, max_length=16)
    overlays: list[OverlayIn] = Field(default_factory=list, max_length=MAX_OVERLAYS)
    alt_text: str = Field(default="", max_length=1000)

    @field_validator("background")
    @classmethod
    def _bg(cls, v: str | None) -> str | None:
        if v is not None and v not in BACKGROUNDS:
            raise ValueError("That background isn't one of the six")
        return v


def _overlay(o: OverlayIn) -> dict[str, Any] | None:
    base = {"type": o.type, "x": round(o.x, 4), "y": round(o.y, 4), "scale": round(o.scale, 3), "rotate": round(o.rotate, 1), "style": o.style}
    if o.type == "text":
        words = o.text.strip()
        return {**base, "text": words} if words else None
    if o.type == "mention":
        return {**base, "user_id": str(o.user_id)} if o.user_id else None
    if o.place is None:
        return None
    return {**base, "place": {"name": o.place.name.strip(), "lat": o.place.lat, "lon": o.place.lon}}


# ------------------------------------------------------------------ JSON


def _story_files(story_id: uuid.UUID) -> tuple[str, str]:
    """This story's own (tile, preview) under ``derived/<file_id>/``."""
    return f"porch-story-{story_id}.thumb.webp", f"porch-story-{story_id}.preview.webp"


def _media_out(viewer: User, s: PorchStory, row: UserFile | None, fm: FileMedia | None) -> dict[str, Any] | None:
    """The story's picture or video, with links signed for ``viewer``."""
    from app.photos import edits

    if s.kind == "text" or row is None:
        return None

    def sign(code: str, ver: int) -> str:
        return media_urls.sign(s.id, viewer.id, viewer.token_version, code, ver)

    video = media.is_video(row, fm)
    r = (fm.renditions or {}) if fm is not None else {}
    ready = fm is not None and fm.derivative_state == "ready"
    size = media._upright(fm)
    width, height = size if size else (None, None)
    thumbhash = fm.thumbhash if fm is not None else None
    original_tag = media_urls.version_tag(row.storage_path, row.size_bytes)
    out: dict[str, Any] = {
        "kind": "video" if video else "image",
        "thumb": None, "preview": None, "poster": None, "video": None,
        "state": fm.derivative_state if fm is not None else "pending",
        "duration_ms": fm.duration_ms if fm is not None else None,
    }
    if video:
        if ready and r.get("poster.webp"):
            out["poster"] = sign("porch_story_poster", media_urls.rendition_tag("poster.webp", r["poster.webp"]))
        if ready and r.get("video.mp4"):
            out["video"] = sign("porch_story_video", media_urls.rendition_tag("video.mp4", r["video.mp4"]))
        elif (row.mime_type or "").lower() in media.PLAYABLE:
            out["video"] = sign("porch_story_video", original_tag)
    elif s.edit:
        tag = media_urls.version_tag(original_tag, media.edit_tag(s.edit))
        out["thumb"] = sign("porch_story_thumb", tag)
        out["preview"] = sign("porch_story_preview", tag)
        if size:
            width, height = edits.edited_size(size[0], size[1], s.edit)
    else:
        for code, rendition in (("porch_story_thumb", "thumb"), ("porch_story_preview", "preview")):
            got = media_urls.shown(r, rendition) if ready else None
            if got is not None:
                out[rendition] = sign(code, media_urls.rendition_tag(got[1], got[2]))
        photos_edit = r.get("edit") if isinstance(r.get("edit"), dict) else None
        if photos_edit:
            width, height = photos_edit.get("width") or width, photos_edit.get("height") or height
            thumbhash = photos_edit.get("thumbhash") or thumbhash
    out["width"], out["height"], out["thumbhash"] = width, height, thumbhash
    return out


async def stories_out(db: AsyncSession, viewer: User, stories: list[PorchStory], *, views: bool = True) -> list[dict[str, Any]]:
    """Stories as ``viewer`` sees them. Callers pass only stories ``viewer``
    can see. ``views=False``: a highlight (no "seen" marks)."""
    if not stories:
        return []
    ids = [s.id for s in stories]
    labels = await access.story_labels(db, viewer, ids)
    file_ids = [s.file_id for s in stories if s.file_id]
    files: dict[uuid.UUID, tuple[UserFile, FileMedia | None]] = {}
    if file_ids:
        q = select(UserFile, FileMedia).outerjoin(FileMedia, FileMedia.file_id == UserFile.id).where(UserFile.id.in_(file_ids))
        files = {row.id: (row, fm) for row, fm in (await db.execute(q)).all()}
    mentioned = {uuid.UUID(m) for s in stories for m in (s.mentions or [])}
    people = await core.users_map(db, {s.author_id for s in stories} | mentioned)
    hidden = await blocks.hidden_ids(db, viewer.id) if mentioned else set()
    seen: set[uuid.UUID] = set()
    if views:
        q = select(PorchStoryView.story_id).where(PorchStoryView.story_id.in_(ids), PorchStoryView.viewer_id == viewer.id)
        seen = set((await db.execute(q)).scalars())
    counts: dict[uuid.UUID, int] = {}
    own = [s.id for s in stories if s.author_id == viewer.id]
    if own:
        counts = await _view_counts(db, viewer, own)
    now = core.now()
    out = []
    for s in stories:
        mine = s.author_id == viewer.id
        row, fm = files.get(s.file_id, (None, None)) if s.file_id else (None, None)
        overlays = []
        for o in s.overlays or []:
            if o.get("type") == "mention":
                uid = o.get("user_id")
                who = people.get(str(uid)) if uid else None
                if who is None or uuid.UUID(str(uid)) in hidden:
                    continue
                overlays.append({k: v for k, v in o.items() if k != "user_id"} | {"user": who})
            else:
                overlays.append(o)
        item: dict[str, Any] = {
            "id": str(s.id),
            "author": people.get(str(s.author_id)),
            "kind": s.kind,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "expires_at": s.expires_at.isoformat(),
            "expired": s.expires_at <= now,
            "groups": labels.get(s.id, []),
            "media": _media_out(viewer, s, row, fm),
            "text": s.text,
            "background": s.background,
            "overlays": overlays,
            "alt_text": s.alt_text,
            "mine": mine,
            "seen": mine or s.id in seen,
        }
        if mine:
            item["view_count"] = counts.get(s.id, 0)
            item["file_id"] = str(s.file_id) if s.file_id else None
        out.append(item)
    return out


async def _view_counts(db: AsyncSession, viewer: User, story_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """How many people saw each (the poster's own), less blocks either way."""
    hidden = await blocks.hidden_ids(db, viewer.id)
    q = select(PorchStoryView.story_id, func.count()).where(PorchStoryView.story_id.in_(story_ids), PorchStoryView.viewer_id != viewer.id)
    if hidden:
        q = q.where(PorchStoryView.viewer_id.not_in(hidden))
    return {sid: int(n) for sid, n in (await db.execute(q.group_by(PorchStoryView.story_id))).all()}


# ------------------------------------------------------------------ the row


def _in_groups(group_ids: list[uuid.UUID]):  # noqa: ANN202 — SQL
    return exists().where(PorchStoryGroup.story_id == PorchStory.id, PorchStoryGroup.group_id.in_(group_ids))


def _live():  # noqa: ANN202 — SQL
    return PorchStory.expires_at > func.now()


def _ring(stories: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The group whose emoji goes on someone's ring: when every story of
    theirs you see is in exactly the same one of your groups."""
    keys = {tuple(g["id"] for g in s["groups"]) for s in stories}
    if len(keys) != 1:
        return None
    only = next(iter(keys))
    if len(only) != 1:
        return None
    return stories[0]["groups"][0]


@router.get("/stories")
async def row(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """The stories row: you first (your live stories), then the people with
    live stories in the groups you've ticked — unseen first, then newest."""
    ticked = await access.ticked_group_ids(db, user)
    mine_q = select(PorchStory).where(PorchStory.author_id == user.id, _live(), access.visible_story(user.id)).order_by(PorchStory.created_at)
    mine = list((await db.execute(mine_q)).scalars())
    theirs: list[PorchStory] = []
    if ticked:
        q = (
            select(PorchStory)
            .where(PorchStory.author_id != user.id, access.visible_story(user.id), _in_groups(ticked))
            .order_by(PorchStory.created_at)
        )
        theirs = list((await db.execute(q)).scalars())
    out_mine = await stories_out(db, user, mine)
    out_theirs = await stories_out(db, user, theirs)
    by: dict[str, list[dict[str, Any]]] = {}
    for s in out_theirs:
        by.setdefault(s["author"]["id"] if s["author"] else "", []).append(s)
    people = []
    for uid, items in by.items():
        if not uid:
            continue
        unseen = [s for s in items if not s["seen"]]
        people.append(
            {
                "user": items[0]["author"],
                "count": len(items),
                "unseen": len(unseen),
                "latest_at": items[-1]["created_at"],
                "ring_group": _ring(items),
                "thumb": _thumb(items[-1]),
            }
        )
    people.sort(key=lambda p: (p["unseen"] == 0, _neg(p["latest_at"])))
    me = None
    if out_mine:
        me = {
            "user": core.user_out(user), "count": len(out_mine), "unseen": 0, "latest_at": out_mine[-1]["created_at"],
            "ring_group": _ring(out_mine), "thumb": _thumb(out_mine[-1]), "views": sum(s.get("view_count", 0) for s in out_mine),
        }
    return {"me": me, "people": people}


def _neg(iso: str | None) -> float:
    return -datetime.fromisoformat(iso).timestamp() if iso else 0.0


def _thumb(s: dict[str, Any]) -> dict[str, Any]:
    """What the ring shows inside: a picture's tile, or a text story's colour."""
    m = s.get("media") or {}
    return {"image": m.get("thumb") or m.get("poster"), "background": s.get("background"), "kind": s["kind"]}


@router.get("/stories/u/{user_id}")
async def user_stories(
    user_id: uuid.UUID, feed: bool = False, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch),
) -> dict:
    """Someone's live stories you can see, oldest first (``feed``: only the
    ones in groups you've ticked, as the row shows them)."""
    from .posts import _person

    other = await _person(db, user, user_id)
    q = select(PorchStory).where(PorchStory.author_id == other.id, _live(), access.visible_story(user.id))
    if feed and other.id != user.id:
        q = q.where(_in_groups(await access.ticked_group_ids(db, user)))
    rows = list((await db.execute(q.order_by(PorchStory.created_at, PorchStory.id))).scalars())
    return {"user": core.user_out(other), "stories": await stories_out(db, user, rows)}


@router.get("/stories/archive")
async def archive(before: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Every story you've posted (live and gone), newest first: private to you."""
    q = select(PorchStory).where(PorchStory.author_id == user.id, access.visible_story(user.id, live=False))
    if before:
        try:
            at, sid = before.rsplit("_", 1)
            cur = (datetime.fromisoformat(at), uuid.UUID(sid))
        except ValueError:
            raise core.bad("That page link isn't valid") from None
        q = q.where(tuple_(PorchStory.created_at, PorchStory.id) < tuple_(cur[0], cur[1]))
    rows = list((await db.execute(q.order_by(PorchStory.created_at.desc(), PorchStory.id.desc()).limit(ARCHIVE_PAGE + 1))).scalars())
    more = len(rows) > ARCHIVE_PAGE
    rows = rows[:ARCHIVE_PAGE]
    nxt = f"{rows[-1].created_at.isoformat()}_{rows[-1].id}" if more and rows else None
    return {"stories": await stories_out(db, user, rows, views=False), "next": nxt}


@router.get("/stories/{story_id}")
async def get_story(story_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    s = await access.load_story(db, user, story_id)
    return (await stories_out(db, user, [s]))[0]


# ------------------------------------------------------------------ posting


@router.post("/stories", status_code=201)
async def create_story(body: StoryIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    from .posts import _audience

    text_ = body.text.strip()
    row: UserFile | None = None
    fm: FileMedia | None = None
    kind = body.kind
    edit = None
    if kind in ("photo", "video"):
        if body.file_id is None:
            raise core.bad("Pick a photo or video first")
        row, fm = (await media.check_files(db, user, [body.file_id]))[body.file_id]
        video = media.is_video(row, fm)
        kind = "video" if video else "photo"
        if video and fm is not None and fm.duration_ms is not None and fm.duration_ms > VIDEO_MAX_SECONDS * 1000:
            raise core.bad(VIDEO_TOO_LONG)
        edit = media.clean_edit(body.edit, video)
    else:
        if not text_:
            raise core.bad("Write something first")
    group_ids = await _audience(db, user, body.groups)
    live = await db.scalar(select(func.count()).select_from(PorchStory).where(PorchStory.author_id == user.id, PorchStory.deleted_at.is_(None), _live()))
    if (live or 0) >= MAX_LIVE:
        raise core.bad(f"You have {MAX_LIVE} stories up already. Delete one, or wait for one to end.")
    now = core.now()
    story = PorchStory(
        author_id=user.id, kind=kind, file_id=row.id if row is not None else None, edit=edit,
        text=text_ if kind == "text" else "", background=(body.background or BACKGROUNDS[0]) if kind == "text" else None,
        alt_text=body.alt_text.strip() if kind != "text" else "", created_at=now, expires_at=now + LIFETIME,
    )
    db.add(story)
    await db.flush()
    for gid in group_ids:
        db.add(PorchStoryGroup(story_id=story.id, group_id=gid))
    await db.flush()
    audience = await access.story_audience_ids(db, story)
    overlays: list[dict[str, Any]] = []
    mentions: list[str] = []
    for o in body.overlays:
        d = _overlay(o)
        if d is None:
            continue
        if d["type"] == "mention":
            # Only people who'd see the story (never you).
            uid = uuid.UUID(d["user_id"])
            if uid not in audience or uid == user.id:
                continue
            if d["user_id"] not in mentions:
                mentions.append(d["user_id"])
        overlays.append(d)
    story.overlays = overlays
    story.mentions = mentions
    prof = await core.profile(db, user.id)
    prof.last_story_groups = "all" if body.groups == "all" else [str(g) for g in group_ids]
    await db.commit()
    await db.refresh(story)
    await core.publish(audience, {"type": "story", "user_id": str(user.id)})
    await push.story_mentioned(db, story, mentions)
    return (await stories_out(db, user, [story]))[0]


async def _own(db: AsyncSession, user: User, story_id: uuid.UUID) -> PorchStory:
    s = await db.get(PorchStory, story_id)
    if s is None or s.deleted_at is not None or s.author_id != user.id:
        raise core.not_found("Story")
    return s


@router.delete("/stories/{story_id}", status_code=204)
async def delete_story(story_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """Delete your story (from the row, your archive and any highlight).
    The photo stays in your Photos library."""
    s = await _own(db, user, story_id)
    audience = await access.story_audience_ids(db, s)
    s.deleted_at = core.now()
    await db.commit()
    if s.file_id:
        forget_renders(s.file_id, s.id)
    await core.publish(audience, {"type": "story", "user_id": str(user.id)})


@router.post("/stories/{story_id}/view")
async def view_story(story_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """You've seen it (your own never counts)."""
    s = await access.load_story(db, user, story_id)
    if s.author_id != user.id:
        res = await db.execute(insert(PorchStoryView).values(story_id=s.id, viewer_id=user.id).on_conflict_do_nothing())
        await db.commit()
        if res.rowcount:
            await core.publish([s.author_id], {"type": "story_view", "story_id": str(s.id)})
    return {"seen": True}


@router.get("/stories/{story_id}/viewers")
async def viewers(story_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Who saw your story, latest first. Only ever the poster's to see;
    nobody with a block either way."""
    s = await db.get(PorchStory, story_id)
    if s is None or s.deleted_at is not None or not await access.can_see_story(db, user, s.id, live=False):
        raise core.not_found("Story")
    if s.author_id != user.id:
        raise core.forbidden("Only the person who posted it sees who viewed it")
    hidden = await blocks.hidden_ids(db, user.id)
    q = (
        select(User, PorchStoryView.seen_at)
        .join(PorchStoryView, PorchStoryView.viewer_id == User.id)
        .where(PorchStoryView.story_id == s.id, User.id != user.id)
        .order_by(PorchStoryView.seen_at.desc())
    )
    if hidden:
        q = q.where(User.id.not_in(hidden))
    rows = (await db.execute(q)).all()
    return {"count": len(rows), "viewers": [{"user": core.user_out(u), "seen_at": at.isoformat()} for u, at in rows]}


# ------------------------------------------------------------------ replies (WP-P2.3)

#: A story's card in Rooms (``crossapp/shares.py``).
CARD_KIND = "porch_story"


async def card(db: AsyncSession, viewer: User, story_id: Any) -> dict[str, Any] | None:
    """The story's card in a Rooms message, as ``viewer`` sees it: only
    while it's live and theirs to see — the poster too — else None, which
    Rooms draws as "This story has ended". Never why."""
    try:
        sid = uuid.UUID(str(story_id))
    except (TypeError, ValueError):
        return None
    if not await deps.allowed(db, viewer):
        return None
    s = (await db.execute(select(PorchStory).where(PorchStory.id == sid, _live(), access.visible_story(viewer.id)))).scalar_one_or_none()
    if s is None:
        return None
    shown = (await stories_out(db, viewer, [s], views=False))[0]
    who = "Your" if s.author_id == viewer.id else f"{shown['author']['name']}'s" if shown["author"] else "A"
    first = next((x.strip() for x in (s.text or "").splitlines() if x.strip()), "")
    words = first if len(first) <= 60 else first[:59].rstrip() + "…"
    where = " · ".join(g["name"] for g in shown["groups"][:2])
    m = shown["media"] or {}
    return {
        "title": words or f"{who} story",
        "subtitle": "Porch story" + (f" · in {where}" if where else "") + " · " + _ends(s),
        "thumb": m.get("thumb") or m.get("poster"),
        "href": f"/porch/stories/{s.author_id}",
    }


def _ends(s: PorchStory) -> str:
    left = (s.expires_at - core.now()).total_seconds()
    if left < 3600:
        return f"ends in {max(1, int(left // 60))}m"
    return f"ends in {int(left // 3600)}h"


class ReplyIn(BaseModel):
    text: str = Field(default="", max_length=2000)
    emoji: str | None = Field(default=None, max_length=16)


@router.post("/stories/{story_id}/reply", status_code=201)
async def reply(story_id: uuid.UUID, body: ReplyIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Reply to a story, or react to it: a message in your 1:1 Rooms
    conversation with its poster, with the story's card. A block either
    way refuses it, as a DM would be."""
    from app.background import spawn
    from app.people.blocks import dm_refusal
    from app.rooms import core as rooms_core
    from app.rooms import service as rooms_service
    from app.rooms.push import fan_out

    from .talk import REACTIONS

    s = await access.load_story(db, user, story_id)
    if s.author_id == user.id:
        raise core.bad("That's your own story")
    if body.emoji is not None and body.emoji not in REACTIONS:
        raise core.bad("Pick one of the six reactions")
    words = body.emoji or body.text.strip()
    if not words:
        raise core.bad("Write something first")
    why = await dm_refusal(db, user.id, s.author_id)
    if why:
        raise core.forbidden(why)
    author_id = s.author_id
    room = await rooms_service.open_dm(db, user, [author_id])
    room, _sm = await rooms_core.load_room(db, room.id, user, lock=True)
    members = await rooms_core.member_ids(db, room)
    msg = await rooms_service.post_message(db, room, user, words)
    # The card names only the story; each person sees it as they may.
    msg.meta = {**(msg.meta or {}), "share": {"kind": CARD_KIND, "id": str(story_id), "label": "a Porch story", "has_note": True}}
    await db.commit()
    await db.refresh(msg)
    out = await rooms_core.message_out(db, msg)
    await rooms_core.publish(members, {"type": "message", "message": out})
    for uid in members:
        if uid != user.id:
            u = await db.get(User, uid)
            if u is not None:
                await rooms_core.publish([uid], {"type": "room", "room": await rooms_core.room_out(db, room, u)})
    spawn(fan_out(msg.id), name=f"rooms-push-{msg.id}")
    return {"room_id": str(room.id), "url": f"/rooms/r/{room.id}", "message_id": str(msg.id)}


# ------------------------------------------------------------------ bytes


def forget_renders(file_id: uuid.UUID, story_id: uuid.UUID) -> None:
    from app.files.derivatives import derived_dir

    for name in _story_files(story_id):
        (derived_dir(file_id) / name).unlink(missing_ok=True)


_locks: dict[uuid.UUID, asyncio.Lock] = {}


async def _ensure_render(s: PorchStory, row: UserFile, fm: FileMedia | None, which: str):  # noqa: ANN202 — Path | None
    """This story's cropped tile or preview, made if missing."""
    from app.files.derivatives import derived_dir
    from app.files.storage import absolute_path
    from app.photos import edits

    thumb, preview = _story_files(s.id)
    path = derived_dir(row.id) / (thumb if which == "thumb" else preview)
    if path.is_file():
        return path
    lock = _locks.setdefault(s.id, asyncio.Lock())
    async with lock:
        if path.is_file():
            return path
        kind = fm.kind if fm is not None and fm.kind in ("image", "raw") else "image"
        try:
            await asyncio.to_thread(edits.render, absolute_path(row.storage_path), row.id, kind, s.edit or {}, media._upright(fm), (thumb, preview))
        except Exception:  # noqa: BLE001 — a picture that won't open: no tile, not a 500
            media.logger.warning("porch story render failed for %s", s.id, exc_info=True)
            return None
        finally:
            _locks.pop(s.id, None)
    return path if path.is_file() else None


async def reachable(db: AsyncSession, user: User, story: PorchStory) -> bool:
    """May ``user`` load this story's bytes now: it's live for them."""
    return await access.can_see_story(db, user, story.id)


async def serve(db: AsyncSession, claim: media_urls.MediaClaim, user: User, request: Request) -> Response:
    """The bytes behind a ``porch_story_*`` link, if ``user`` may see them now."""
    from app.files.derivatives import rendition_path
    from app.files.storage import absolute_path

    s = await db.get(PorchStory, claim.file_id)
    if s is None or s.file_id is None or not await reachable(db, user, s):
        raise media._not_found()
    row = await db.get(UserFile, s.file_id)
    if row is None or row.trashed_at is not None or not row.storage_path:
        raise media._not_found()
    fm = await db.get(FileMedia, row.id)
    headers = media._headers(claim)
    video = media.is_video(row, fm)
    r = (fm.renditions or {}) if fm is not None else {}
    if claim.rendition == "porch_story_video":
        if not video:
            raise media._not_found()
        if r.get("video.mp4"):
            path = rendition_path(row.id, "video.mp4")
            if path.is_file():
                return media._send(path, "video/mp4", headers, request)
        mime = (row.mime_type or "").lower()
        if mime in media.PLAYABLE:
            path = absolute_path(row.storage_path)
            if path.is_file():
                return media._send(path, mime, headers, request, blob=True)
        raise media._not_found()
    if claim.rendition == "porch_story_poster":
        path = rendition_path(row.id, "poster.webp")
        if not video or not path.is_file():
            raise media._not_found()
        return media._send(path, "image/webp", headers, request)
    which = "thumb" if claim.rendition == "porch_story_thumb" else "preview"
    if video:
        raise media._not_found()
    if s.edit:
        path = await _ensure_render(s, row, fm, which)
    else:
        got = media_urls.shown(r, which) if fm is not None and fm.derivative_state == "ready" else None
        path = rendition_path(row.id, got[1]) if got else None
    if path is None or not path.is_file():
        raise media._not_found()
    return media._send(path, "image/webp", headers, request)


__all__ = ["BACKGROUNDS", "CARD_KIND", "LIFETIME", "VIDEO_MAX_SECONDS", "card", "forget_renders", "reachable", "router", "serve", "stories_out"]
