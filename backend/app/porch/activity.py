"""Activity (build §3.8): what's happened that's about you.

Pinned at the top: group **invites** (Join / Not now) and **tag requests**
(Show it / Not me). Then, newest first: comments on your posts, replies to
your comments, @mentions of you in posts and comments, and reactions to
your posts and comments (one line per post or comment: "Sam and 2 others
reacted to your post").

It's read from the talking tables as it is now, so it can never show
something you can't see any more: only posts you can see
(``access.visible_post``), nothing from anyone with a block either way
(``blocks.hidden_ids``), nothing deleted. Opening it marks it seen
(``porch_profiles.activity_seen_at``), which clears the badge.

Live: :func:`tell` sends ``{"type": "activity"}`` to the people something
new is for, so their badge and list refresh. Push notifications
(:mod:`app.porch.push`) go from the same places: ``after_comment``,
``after_post``, reactions, invites. An admin's removals
(``porch_removals``) show here too, with the reason, to the poster only.
Someone who runs a group sees how many things wait in its Reports tab
(pinned, like invites, until they're handled; never who reported them).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, media, push
from .deps import require_porch
from .models import PorchComment, PorchPost, PorchProfile, PorchReaction, PorchTag

router = APIRouter()

WINDOW = timedelta(days=90)
LIMIT = 100


# ------------------------------------------------------------------ telling people


async def tell(db: AsyncSession, user_ids: Iterable[uuid.UUID | None], *, actor: uuid.UUID | None = None) -> None:
    """Something new in these people's Activity (never the actor's own, and
    never across a block): a live nudge to refresh it."""
    ids = {u for u in user_ids if u is not None and u != actor}
    if actor is not None and ids:
        ids -= await blocks.hidden_ids(db, actor)
    if ids:
        await core.publish(ids, {"type": "activity"})


async def after_comment(db: AsyncSession, post: PorchPost, c: PorchComment, parent: PorchComment | None) -> None:
    """A new comment: the post's author, the person replied to, and anyone
    @mentioned (all could see the post when it was written)."""
    who: set[uuid.UUID] = {post.author_id}
    if parent is not None:
        who.add(parent.author_id)
    who |= {uuid.UUID(m) for m in (c.mentions or [])}
    await tell(db, who, actor=c.author_id)
    await push.comment_added(db, post, c, parent)


async def after_post(db: AsyncSession, post: PorchPost, mentioned: Iterable[str | uuid.UUID], tagged: Iterable[uuid.UUID], *, created: bool = False) -> None:
    """A new or changed post: anyone newly @mentioned or asked about a tag
    (and, for a new post, the pushes for bells and "Notify me when they post")."""
    mentioned, tagged = list(mentioned), list(tagged)
    who = {uuid.UUID(str(m)) for m in mentioned} | set(tagged)
    await tell(db, who, actor=post.author_id)
    await push.post_created(db, post, mentioned, tagged, created=created)


# ------------------------------------------------------------------ reading


def _snippet(s: str, n: int = 120) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


async def collect(db: AsyncSession, user: User) -> dict[str, Any]:
    """Everything for the Activity page (and the badge's count)."""
    from .groups import _invites

    me = user.id
    since = core.now() - WINDOW
    hidden = await blocks.hidden_ids(db, me)
    prof = await db.get(PorchProfile, me)
    seen = prof.activity_seen_at if prof is not None else None
    raw: list[dict[str, Any]] = []

    # Comments on your posts, replies to your comments, comments mentioning you.
    parent = aliased(PorchComment)
    q = (
        select(PorchComment, PorchPost, parent.author_id)
        .join(PorchPost, PorchPost.id == PorchComment.post_id)
        .outerjoin(parent, parent.id == PorchComment.parent_id)
        .where(
            PorchComment.deleted_at.is_(None),
            PorchComment.author_id != me,
            PorchComment.created_at >= since,
            access.visible_post(me),
            or_(PorchPost.author_id == me, parent.author_id == me, PorchComment.mentions.contains([str(me)])),
        )
        .order_by(PorchComment.created_at.desc())
        .limit(LIMIT)
    )
    for c, post, parent_author in (await db.execute(q)).all():
        if c.author_id in hidden or (parent_author is not None and parent_author in hidden):
            continue
        kind = "reply" if parent_author == me else "comment" if post.author_id == me else "mention"
        raw.append({"key": f"c:{c.id}", "kind": kind, "at": c.created_at, "actors": [c.author_id], "post": post, "text": _snippet(c.body), "comment_id": c.id})

    # Posts mentioning you.
    q = (
        select(PorchPost)
        .where(PorchPost.mentions.contains([str(me)]), PorchPost.author_id != me, PorchPost.created_at >= since, access.visible_post(me))
        .order_by(PorchPost.created_at.desc())
        .limit(LIMIT)
    )
    for post in (await db.execute(q)).scalars():
        raw.append({"key": f"m:{post.id}", "kind": "mention", "at": post.created_at, "actors": [post.author_id], "post": post, "text": _snippet(post.body)})

    # Reactions to your posts and comments: one line each.
    q = (
        select(PorchReaction, PorchPost)
        .join(PorchPost, PorchPost.id == PorchReaction.post_id)
        .outerjoin(PorchComment, and_(PorchReaction.target_type == "comment", PorchComment.id == PorchReaction.target_id))
        .where(
            PorchReaction.user_id != me,
            PorchReaction.created_at >= since,
            access.visible_post(me),
            or_(
                and_(PorchReaction.target_type == "post", PorchPost.author_id == me),
                and_(PorchReaction.target_type == "comment", PorchComment.author_id == me, PorchComment.deleted_at.is_(None)),
            ),
        )
        .order_by(PorchReaction.created_at.desc())
    )
    grouped: dict[tuple[str, uuid.UUID], dict[str, Any]] = {}
    for r, post in (await db.execute(q)).all():
        if r.user_id in hidden:
            continue
        g = grouped.get((r.target_type, r.target_id))
        if g is None:
            g = grouped[(r.target_type, r.target_id)] = {
                "key": f"r:{r.target_type}:{r.target_id}", "kind": "reaction", "target": r.target_type, "at": r.created_at,
                "actors": [], "emoji": [], "post": post, "comment_id": r.target_id if r.target_type == "comment" else None,
            }
        g["actors"].append(r.user_id)
        if r.emoji not in g["emoji"]:
            g["emoji"].append(r.emoji)
    raw += grouped.values()

    # Tag requests waiting for your answer.
    q = (
        select(PorchTag, PorchPost)
        .join(PorchPost, PorchPost.id == PorchTag.post_id)
        .where(PorchTag.tagged_user_id == me, PorchTag.status == "pending", access.visible_post(me))
        .order_by(PorchTag.created_at.desc())
        .limit(LIMIT)
    )
    tag_rows = [(t, p) for t, p in (await db.execute(q)).all() if t.tagged_by not in hidden]

    # One item per thing, the strongest reason first (a comment on your post
    # that also mentions you is "commented on your post").
    seen_keys: set[str] = set()
    items_raw = []
    for it in sorted(raw, key=lambda d: d["at"], reverse=True):
        if it["key"] in seen_keys:
            continue
        seen_keys.add(it["key"])
        items_raw.append(it)
    items_raw = items_raw[:LIMIT]

    posts = {it["post"].id: it["post"] for it in items_raw} | {p.id: p for _, p in tag_rows}
    medias = await media.live_media(db, list(posts))
    thumbs: dict[uuid.UUID, str | None] = {}
    first: dict[uuid.UUID, str | None] = {}
    for pid, rows in medias.items():
        for pm, row, fm in rows:
            m = media.media_out(user, pm, row, fm, author=False)
            thumbs[pm.id] = m["thumb"] or m["poster"]
            first.setdefault(pid, thumbs[pm.id])
    people = await core.users_map(db, {a for it in items_raw for a in it["actors"]} | {t.tagged_by for t, _ in tag_rows})

    def post_ref(p: PorchPost) -> dict[str, Any]:
        return {"id": str(p.id), "kind": p.kind, "thumb": first.get(p.id), "body": _snippet(p.body, 80), "mine": p.author_id == me}

    items: list[dict[str, Any]] = []
    for it in items_raw:
        actors = [people[str(a)] for a in dict.fromkeys(it["actors"]) if str(a) in people]
        if not actors:
            continue
        items.append(
            {
                "id": it["key"],
                "kind": it["kind"],
                "at": it["at"].isoformat(),
                "actors": actors[:2],
                "others": max(0, len(actors) - 2),
                "post": post_ref(it["post"]),
                "text": it.get("text"),
                "emoji": it.get("emoji"),
                "target": it.get("target", "post"),
                "comment_id": str(it["comment_id"]) if it.get("comment_id") else None,
                "unseen": seen is None or it["at"] > seen,
            }
        )
    tag_requests = [
        {
            "id": str(t.id),
            "post": post_ref(p),
            "by": people.get(str(t.tagged_by)),
            "thumb": thumbs.get(t.media_id),
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t, p in tag_rows
    ]
    # An admin took something of yours down: what, where, and why.
    from .models import PorchGroup
    from .reports import removals_for, waiting

    removals = await removals_for(db, me, since)
    gids = {r.group_id for r in removals if r.group_id}
    gnames = dict((await db.execute(select(PorchGroup.id, PorchGroup.name).where(PorchGroup.id.in_(gids)))).all()) if gids else {}
    for r in removals:
        items.append(
            {
                "id": f"x:{r.id}",
                "kind": "removed",
                "at": r.created_at.isoformat(),
                "actors": [],
                "others": 0,
                # Something to open only while the post is still up (out of
                # Everyone, or a comment taken off a post).
                "post": {"id": str(r.post_id), "kind": None, "thumb": None, "body": r.snippet, "mine": True}
                if r.post_id and not (r.target_type == "post" and r.scope == "all")
                else None,
                "text": r.snippet,
                "emoji": None,
                "target": r.target_type,
                "comment_id": str(r.target_id) if r.target_type == "comment" else None,
                "removed": {"scope": r.scope, "reason": r.reason, "group": gnames.get(r.group_id) if r.group_id else None},
                "unseen": seen is None or r.created_at > seen,
            }
        )
    items.sort(key=lambda i: i["at"], reverse=True)
    invites = await _invites(db, user)
    # Groups you run with something reported in them.
    run = [m.group for m in await access.my_groups(db, user) if m.is_admin]
    counts = await waiting(db, user, run)
    reports = [{"group": access.group_label(g), "count": counts[g.id]} for g in run if counts.get(g.id)]
    unseen = sum(1 for i in items if i["unseen"]) + len(tag_requests) + len(invites) + len(reports)
    return {
        "invites": invites,
        "reports": reports,
        "tag_requests": tag_requests,
        "items": items,
        "seen_at": seen.isoformat() if seen else None,
        "unseen": unseen,
    }


async def unseen_count(db: AsyncSession, user: User) -> int:
    """The badge: new things since you last opened Activity, plus invites
    and tag requests still waiting for an answer."""
    try:
        return int((await collect(db, user))["unseen"])
    except Exception:  # noqa: BLE001 — a badge never breaks the app
        core.logger.warning("porch activity count failed", exc_info=True)
        return 0


@router.get("/activity")
async def get_activity(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    return await collect(db, user)


@router.post("/activity/seen")
async def mark_seen(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """You've opened Activity: the badge clears (invites and tag requests
    still count until you answer them)."""
    prof = await core.profile(db, user.id)
    prof.activity_seen_at = core.now()
    await db.commit()
    return {"seen_at": prof.activity_seen_at.isoformat()}


__all__ = ["after_comment", "after_post", "collect", "router", "tell", "unseen_count"]
