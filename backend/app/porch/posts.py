"""Posts and the lists they appear in: the feed, a group's page, a person's
profile, and one post.

* Every post goes to one or more of your groups. "All my groups" is stored
  as the groups you're in when you press Post — a group you join later
  doesn't get your old posts. You can't change a post's groups afterwards.
* The feed is the posts you can see (``access.visible_post``) that are in a
  group you've ticked, newest first; a post in two ticked groups shows once.
  A group's page ignores your ticks.
* Each post says which of *your* groups it's in, never anyone else's.
* Edit your own post's words, photos and place ("edited"); delete it if
  it's yours or you're an admin of every group it's in. Deleting a post
  never deletes a photo from anyone's library.
"""
from __future__ import annotations

import uuid
from datetime import date as Date, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import exists, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, deps, media
from .deps import require_porch
from .models import PorchGroup, PorchPost, PorchPostGroup, PorchPostMedia, PorchProfile

router = APIRouter()

PAGE = 30
LIFE_EVENTS = ("new_baby", "new_job", "moved_house", "engaged", "graduated", "other")
PHOTO_KINDS = ("photo", "video")


# ------------------------------------------------------------------ JSON


async def posts_out(db: AsyncSession, viewer: User, posts: list[PorchPost]) -> list[dict[str, Any]]:
    """Posts as ``viewer`` sees them: their groups (yours only), photos with
    links signed for them, and whether they may change or delete it.
    Callers pass only posts ``viewer`` can see."""
    if not posts:
        return []
    ids = [p.id for p in posts]
    labels = await access.labels(db, viewer, ids)
    medias = await media.live_media(db, ids)
    people = await core.users_map(db, {p.author_id for p in posts})
    # "Admin of every group it's in" → may delete it.
    admin_of = {x.group.id for x in await access.my_groups(db, viewer) if x.is_admin}
    groups_of: dict[uuid.UUID, set[uuid.UUID]] = {pid: set() for pid in ids}
    q = (
        select(PorchPostGroup.post_id, PorchPostGroup.group_id)
        .join(PorchGroup, PorchGroup.id == PorchPostGroup.group_id)
        .where(PorchPostGroup.post_id.in_(ids), PorchGroup.deleted_at.is_(None))
    )
    for pid, gid in (await db.execute(q)).all():
        groups_of[pid].add(gid)
    out = []
    for p in posts:
        mine = p.author_id == viewer.id
        items = [media.media_out(viewer, pm, row, fm, author=mine) for pm, row, fm in medias.get(p.id, [])]
        gs = groups_of.get(p.id) or set()
        out.append(
            {
                "id": str(p.id),
                "author": people.get(str(p.author_id)),
                "kind": p.kind,
                "body": p.body,
                "place": p.place,
                "life_event": p.life_event,
                "link": p.link,
                "mentions": p.mentions or [],
                "groups": labels.get(p.id, []),
                "media": items,
                # Every photo trashed in Photos since: "Photo removed".
                "photo_removed": p.kind in PHOTO_KINDS and not items,
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "edited_at": p.edited_at.isoformat() if p.edited_at else None,
                "mine": mine,
                "can_edit": mine,
                "can_delete": mine or (bool(gs) and gs <= admin_of),
            }
        )
    return out


async def post_out(db: AsyncSession, viewer: User, post: PorchPost) -> dict[str, Any]:
    return (await posts_out(db, viewer, [post]))[0]


def _cursor(p: PorchPost) -> str:
    return f"{p.created_at.isoformat()}_{p.id}"


def _parse_cursor(before: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not before:
        return None
    try:
        at, pid = before.rsplit("_", 1)
        return datetime.fromisoformat(at), uuid.UUID(pid)
    except ValueError:
        raise core.bad("That page link isn't valid") from None


async def _page(db: AsyncSession, viewer: User, q: Any, before: str | None, limit: int = PAGE) -> dict[str, Any]:
    cur = _parse_cursor(before)
    if cur is not None:
        q = q.where(tuple_(PorchPost.created_at, PorchPost.id) < tuple_(cur[0], cur[1]))
    rows = list((await db.execute(q.order_by(PorchPost.created_at.desc(), PorchPost.id.desc()).limit(limit + 1))).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    return {"posts": await posts_out(db, viewer, rows), "next": _cursor(rows[-1]) if more and rows else None}


def _in_groups(group_ids: list[uuid.UUID]):  # noqa: ANN202 — SQL
    return exists().where(PorchPostGroup.post_id == PorchPost.id, PorchPostGroup.group_id.in_(group_ids))


# ------------------------------------------------------------------ lists


@router.get("/feed")
async def feed(
    before: str | None = None,
    photos: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_porch),
) -> dict:
    """Posts from the groups you've ticked, newest first (30 a page;
    ``next`` is the next page's ``before``)."""
    ticked = await access.ticked_group_ids(db, user)
    prof = await db.get(PorchProfile, user.id)
    seen = prof.feed_seen_at.isoformat() if prof is not None and prof.feed_seen_at else None
    if not ticked:
        return {"posts": [], "next": None, "ticked": [], "feed_seen_at": seen}
    q = select(PorchPost).where(access.visible_post(user.id), _in_groups(ticked))
    if photos:
        q = q.where(PorchPost.kind.in_(PHOTO_KINDS))
    out = await _page(db, user, q, before)
    out["ticked"] = [str(g) for g in ticked]
    out["feed_seen_at"] = seen
    return out


@router.get("/groups/{group_id}/posts")
async def group_posts(
    group_id: uuid.UUID,
    before: str | None = None,
    photos: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_porch),
) -> dict:
    """A group's posts (members only; your feed ticks don't apply)."""
    g, _, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Posts show once you join")
    q = select(PorchPost).where(access.visible_post(user.id), _in_groups([g.id]))
    if photos:
        q = q.where(PorchPost.kind.in_(PHOTO_KINDS))
    return await _page(db, user, q, before)


@router.get("/users/{user_id}/posts")
async def user_posts(
    user_id: uuid.UUID,
    before: str | None = None,
    tab: Literal["all", "photos", "posts", "life_events"] = "all",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_porch),
) -> dict:
    """Someone's posts that you can see (a profile's tabs)."""
    await _person(db, user, user_id)
    q = select(PorchPost).where(PorchPost.author_id == user_id, access.visible_post(user.id))
    if tab == "photos":
        q = q.where(PorchPost.kind.in_(PHOTO_KINDS))
    elif tab == "posts":
        q = q.where(PorchPost.kind.in_(("text", "poll")))
    elif tab == "life_events":
        q = q.where(PorchPost.kind == "life_event")
    return await _page(db, user, q, before)


async def _person(db: AsyncSession, viewer: User, user_id: uuid.UUID) -> User:
    """Someone on Porch you can see: 404 when they don't exist, Porch isn't
    on for them, or there's a block either way."""
    other = await db.get(User, user_id)
    if other is None or (other.id != viewer.id and (not await deps.allowed(db, other) or await blocks.either(db, viewer.id, other.id))):
        raise core.not_found("Person")
    return other


@router.get("/posts/{post_id}")
async def get_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    return await post_out(db, user, await access.load_post(db, user, post_id))


# ------------------------------------------------------------------ write


class MediaIn(BaseModel):
    id: uuid.UUID | None = None  # an existing photo of this post (edits)
    file_id: uuid.UUID | None = None
    alt_text: str = Field(default="", max_length=1000)
    edit: dict[str, Any] | None = None


class PlaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


class LinkIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=300)
    description: str = Field(default="", max_length=1000)
    site_name: str = Field(default="", max_length=200)

    @field_validator("url")
    @classmethod
    def _http(cls, v: str) -> str:
        v = v.strip()
        if not (v.lower().startswith("http://") or v.lower().startswith("https://")):
            raise ValueError("A link has to start with http:// or https://")
        return v


class LifeEventIn(BaseModel):
    type: Literal["new_baby", "new_job", "moved_house", "engaged", "graduated", "other"]
    title: str = Field(default="", max_length=120)
    date: Date


class PostIn(BaseModel):
    kind: Literal["photo", "video", "text", "life_event"]
    body: str = Field(default="", max_length=5000)
    groups: Literal["all"] | list[uuid.UUID]
    media: list[MediaIn] = Field(default_factory=list, max_length=media.MAX_MEDIA)
    place: PlaceIn | None = None
    link: LinkIn | None = None
    life_event: LifeEventIn | None = None
    from_memory_id: uuid.UUID | None = None


class PostPatch(BaseModel):
    body: str | None = Field(default=None, max_length=5000)
    media: list[MediaIn] | None = Field(default=None, max_length=media.MAX_MEDIA)
    place: PlaceIn | None = None
    link: LinkIn | None = None
    life_event: LifeEventIn | None = None


def _life(ev: LifeEventIn | None) -> dict[str, Any] | None:
    return None if ev is None else {"type": ev.type, "title": ev.title.strip(), "date": ev.date.isoformat()}


def _link(link: LinkIn | None) -> dict[str, Any] | None:
    return None if link is None else {k: (v.strip() if isinstance(v, str) else v) for k, v in link.model_dump().items()}


def _place(place: PlaceIn | None) -> dict[str, Any] | None:
    return None if place is None else {"name": place.name.strip(), "lat": place.lat, "lon": place.lon}


async def _audience(db: AsyncSession, user: User, groups: Literal["all"] | list[uuid.UUID]) -> list[uuid.UUID]:
    """The groups a new post goes to: "all" is the groups you're in right
    now; a list must be your groups."""
    mine = await access.my_group_ids(db, user)
    if groups == "all":
        return mine
    want = list(dict.fromkeys(groups))
    if not want:
        raise core.bad("Pick at least one group")
    if set(want) - set(mine):
        raise core.not_found("Group")
    return want


async def _new_media(db: AsyncSession, user: User, items: list[MediaIn]) -> dict[uuid.UUID, tuple[Any, Any]]:
    """Check the new files in a post's photo list (yours, in your library)."""
    new = [m.file_id for m in items if m.id is None]
    if any(f is None for f in new):
        raise core.bad("Each photo needs a file")
    return await media.check_files(db, user, list(dict.fromkeys(f for f in new if f is not None)))


def _kind_for(kind: str, items: list[tuple[Any, Any]]) -> str:
    """photo/video posts: "video" only when every item is one."""
    if kind not in PHOTO_KINDS:
        return kind
    return "video" if items and all(media.is_video(row, fm) for row, fm in items) else "photo"


@router.post("/posts", status_code=201)
async def create_post(body: PostIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    text_ = body.body.strip()
    if body.kind in PHOTO_KINDS and not body.media:
        raise core.bad("Add at least one photo or video")
    if body.kind == "text":
        if body.media:
            raise core.bad("A text post has no photos. Make it a photo post instead.")
        if not text_ and body.link is None:
            raise core.bad("Write something first")
    if body.kind == "life_event" and body.life_event is None:
        raise core.bad("Say what happened")
    if any(m.id is not None for m in body.media):
        raise core.bad("Each photo needs a file")
    group_ids = await _audience(db, user, body.groups)
    files = await _new_media(db, user, body.media)
    ordered = [files[m.file_id] for m in body.media if m.file_id is not None]
    post = PorchPost(
        author_id=user.id, kind=_kind_for(body.kind, ordered), body=text_, place=_place(body.place), link=_link(body.link),
        life_event=_life(body.life_event) if body.kind == "life_event" else None, from_memory_id=body.from_memory_id,
    )
    db.add(post)
    await db.flush()
    for gid in group_ids:
        db.add(PorchPostGroup(post_id=post.id, group_id=gid))
    for i, m in enumerate(body.media):
        row, fm = files[m.file_id]  # type: ignore[index]
        db.add(PorchPostMedia(post_id=post.id, position=i, file_id=row.id, alt_text=m.alt_text.strip(), edit=media.clean_edit(m.edit, media.is_video(row, fm))))
    prof = await core.profile(db, user.id)
    prof.last_groups = "all" if body.groups == "all" else [str(g) for g in group_ids]
    await db.commit()
    await db.refresh(post)
    await core.publish(await access.audience_ids(db, post), {"type": "post", "post_id": str(post.id)})
    return await post_out(db, user, post)


@router.patch("/posts/{post_id}")
async def update_post(post_id: uuid.UUID, body: PostPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Change your post's words, photos (add, drop, reorder, crop, describe)
    or place. Its groups stay as they were."""
    post = await access.load_post(db, user, post_id)
    if post.author_id != user.id:
        raise core.forbidden("Only the person who posted it can change it")
    sent = body.model_fields_set
    if "body" in sent and body.body is not None:
        post.body = body.body.strip()
    if "place" in sent:
        post.place = _place(body.place)
    if "link" in sent:
        post.link = _link(body.link)
    if "life_event" in sent and post.kind == "life_event":
        if body.life_event is None:
            raise core.bad("Say what happened")
        post.life_event = _life(body.life_event)
    if body.media is not None:
        await _replace_media(db, user, post, body.media)
    if post.kind == "text" and not post.body and not post.link:
        raise core.bad("Write something first")
    post.edited_at = core.now()
    await db.commit()
    await db.refresh(post)
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
    return await post_out(db, user, post)


async def _replace_media(db: AsyncSession, user: User, post: PorchPost, items: list[MediaIn]) -> None:
    if post.kind == "text" and items:
        raise core.bad("A text post has no photos")
    if post.kind in PHOTO_KINDS and not items:
        raise core.bad("A photo post needs at least one photo. Delete the post instead.")
    existing = {m.id: m for m in (await db.execute(select(PorchPostMedia).where(PorchPostMedia.post_id == post.id))).scalars()}
    keep = [m.id for m in items if m.id is not None]
    if set(keep) - set(existing) or len(set(keep)) != len(keep):
        raise core.not_found("Photo")
    files = await _new_media(db, user, items)
    from app.files.models import FileMedia, UserFile

    for mid, row in existing.items():
        if mid not in keep:
            media.forget_renders(row.file_id, row.id)
            await db.delete(row)
    kinds: list[tuple[Any, Any]] = []
    for i, m in enumerate(items):
        if m.id is not None:
            row = existing[m.id]
            f = await db.get(UserFile, row.file_id)
            fm = await db.get(FileMedia, row.file_id)
            new_edit = media.clean_edit(m.edit, media.is_video(f, fm)) if f is not None else None
            if new_edit != row.edit:
                media.forget_renders(row.file_id, row.id)
                row.edit = new_edit
            row.position, row.alt_text = i, m.alt_text.strip()
            kinds.append((f, fm))
        else:
            f, fm = files[m.file_id]  # type: ignore[index]
            db.add(PorchPostMedia(post_id=post.id, position=i, file_id=f.id, alt_text=m.alt_text.strip(), edit=media.clean_edit(m.edit, media.is_video(f, fm))))
            kinds.append((f, fm))
    await db.flush()
    if post.kind in PHOTO_KINDS:
        post.kind = _kind_for(post.kind, [k for k in kinds if k[0] is not None])


@router.delete("/posts/{post_id}", status_code=204)
async def delete_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """Delete a post (yours, or one where you're an admin of every group
    it's in). The photos stay in the poster's library."""
    post = await access.load_post(db, user, post_id)
    if post.author_id != user.id:
        gids = set(
            (
                await db.execute(
                    select(PorchPostGroup.group_id)
                    .join(PorchGroup, PorchGroup.id == PorchPostGroup.group_id)
                    .where(PorchPostGroup.post_id == post.id, PorchGroup.deleted_at.is_(None))
                )
            ).scalars()
        )
        admin_of = {x.group.id for x in await access.my_groups(db, user) if x.is_admin}
        if not gids or not gids <= admin_of:
            raise core.forbidden("Only the person who posted it, or an admin of every group it's in, can delete it")
    audience = await access.audience_ids(db, post)
    post.deleted_at = core.now()
    await db.commit()
    await core.publish(audience, {"type": "post_change", "post_id": str(post.id)})


__all__ = ["post_out", "posts_out", "router"]
