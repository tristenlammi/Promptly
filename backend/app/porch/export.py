"""Porch in "Export my library" (``files/library_export.plan`` writes it as
``porch.json`` in the first part, build §7).

Only your own things: your profile, the groups you're in, your posts
(words, the groups you sent each to, place, life event, link, poll and its
results, and which photos — as paths into the export's ``My files/…``),
the comments on your posts with their authors' names, and the comments
you wrote anywhere. Nobody else's posts, and nothing about a group you
aren't in. People with a block either way with you are left out, as Porch
leaves them out for you.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import blocks

from . import access, core, deps
from .models import (
    PorchComment, PorchGroup, PorchPollOption, PorchPollVote, PorchPost, PorchPostGroup, PorchPostMedia, PorchProfile,
)


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt is not None else None


async def porch_json(db: AsyncSession, user: User, arc_of: dict[uuid.UUID, str], root: str) -> dict[str, Any] | None:
    """What goes in ``porch.json``, or None when you've never used Porch.
    ``arc_of`` maps your files to their place in the export; paths are
    written relative to ``root`` (as ``albums.json`` does)."""
    prof = await db.get(PorchProfile, user.id)
    posts = list(
        (
            await db.execute(
                select(PorchPost).where(PorchPost.author_id == user.id, PorchPost.deleted_at.is_(None)).order_by(PorchPost.created_at)
            )
        ).scalars()
    )
    my_comments = list(
        (
            await db.execute(
                select(PorchComment).where(PorchComment.author_id == user.id, PorchComment.deleted_at.is_(None)).order_by(PorchComment.created_at)
            )
        ).scalars()
    )
    if prof is None and not posts and not my_comments:
        return None
    hidden = await blocks.hidden_ids(db, user.id)

    # Groups you're in now (Everyone when Porch is on for you).
    groups_out: list[dict[str, Any]] = []
    if await deps.allowed(db, user):
        for m in await access.my_groups(db, user):
            g = m.group
            groups_out.append(
                {
                    "name": g.name, "emoji": g.emoji, "kind": g.kind, "visibility": g.visibility, "about": g.about,
                    "your_role": m.role, "in_your_feed": m.in_feed,
                }
            )

    post_ids = [p.id for p in posts]
    # The groups each post went to (yours: you chose them), by name.
    sent_to: dict[uuid.UUID, list[str]] = {pid: [] for pid in post_ids}
    if post_ids:
        q = (
            select(PorchPostGroup.post_id, PorchGroup.name)
            .join(PorchGroup, PorchGroup.id == PorchPostGroup.group_id)
            .where(PorchPostGroup.post_id.in_(post_ids))
            .order_by(PorchGroup.name)
        )
        for pid, name in (await db.execute(q)).all():
            sent_to[pid].append(name)
    media: dict[uuid.UUID, list[PorchPostMedia]] = {pid: [] for pid in post_ids}
    if post_ids:
        for pm in (await db.execute(select(PorchPostMedia).where(PorchPostMedia.post_id.in_(post_ids)).order_by(PorchPostMedia.position))).scalars():
            media[pm.post_id].append(pm)
    # Polls: each option and how many voted for it.
    options: dict[uuid.UUID, list[dict[str, Any]]] = {}
    polls = [p.id for p in posts if p.kind == "poll"]
    if polls:
        votes = dict(
            (
                await db.execute(
                    select(PorchPollVote.option_id, func.count()).where(PorchPollVote.post_id.in_(polls)).group_by(PorchPollVote.option_id)
                )
            ).all()
        )
        for o in (await db.execute(select(PorchPollOption).where(PorchPollOption.post_id.in_(polls)).order_by(PorchPollOption.position))).scalars():
            options.setdefault(o.post_id, []).append({"option": o.label, "votes": int(votes.get(o.id, 0))})
    # Comments on your posts (not anyone's you've blocked or who blocked you).
    on_mine: dict[uuid.UUID, list[PorchComment]] = {pid: [] for pid in post_ids}
    if post_ids:
        for c in (
            await db.execute(
                select(PorchComment)
                .where(PorchComment.post_id.in_(post_ids), PorchComment.deleted_at.is_(None))
                .order_by(PorchComment.created_at, PorchComment.id)
            )
        ).scalars():
            if c.author_id not in hidden:
                on_mine[c.post_id].append(c)
    people = await core.users_map(db, {c.author_id for cs in on_mine.values() for c in cs})

    def name_of(uid: uuid.UUID) -> str:
        p = people.get(str(uid))
        return p["name"] if p else "Someone"

    def comment(c: PorchComment) -> dict[str, Any]:
        return {"by": name_of(c.author_id), "text": c.body, "at": _iso(c.created_at), "edited": _iso(c.edited_at)}

    posts_out: list[dict[str, Any]] = []
    for p in posts:
        tops = [c for c in on_mine[p.id] if c.parent_id is None]
        replies: dict[uuid.UUID, list[PorchComment]] = {}
        for c in on_mine[p.id]:
            if c.parent_id is not None:
                replies.setdefault(c.parent_id, []).append(c)
        photos = []
        for pm in media[p.id]:
            arc = arc_of.get(pm.file_id)
            photos.append(
                {
                    # None: the photo isn't in your library any more.
                    "file": arc[len(root):] if arc else None,
                    "description": pm.alt_text or None,
                    "edited_for_this_post": bool(pm.edit),
                }
            )
        out: dict[str, Any] = {
            "id": str(p.id),
            "kind": p.kind,
            "text": p.body,
            "posted": _iso(p.created_at),
            "edited": _iso(p.edited_at),
            "groups": sent_to[p.id],
            "place": p.place,
            "photos": photos,
            "comments": [{**comment(t), "replies": [comment(r) for r in replies.get(t.id, [])]} for t in tops],
        }
        if p.life_event:
            out["life_event"] = p.life_event
        if p.link:
            out["link"] = p.link
        if p.kind == "poll":
            out["poll"] = {"closes": _iso(p.poll_closes_at), "options": options.get(p.id, [])}
        posts_out.append(out)

    # Your comments on other people's posts.
    elsewhere = [c for c in my_comments if c.post_id not in set(post_ids)]
    authors: dict[uuid.UUID, uuid.UUID] = {}
    if elsewhere:
        q = select(PorchPost.id, PorchPost.author_id).where(PorchPost.id.in_({c.post_id for c in elsewhere}))
        authors = dict((await db.execute(q)).all())
    post_people = await core.users_map(db, set(authors.values()) - hidden)
    comments_out = []
    for c in elsewhere:
        a = post_people.get(str(authors.get(c.post_id)))
        comments_out.append(
            {"on_post_by": a["name"] if a else None, "post_id": str(c.post_id), "text": c.body, "at": _iso(c.created_at), "edited": _iso(c.edited_at)}
        )

    return {
        "about": "Your Porch: your profile, the groups you're in, your posts with their comments, and your comments on other posts.",
        "profile": {
            "name": core.display_name(user),
            "username": user.username,
            "bio": prof.bio if prof else "",
            "birthday": prof.birthday.isoformat() if prof and prof.birthday else None,
            "show_birthday": bool(prof.show_birthday) if prof else False,
        },
        "groups": groups_out,
        "posts": posts_out,
        "your_comments_on_other_posts": comments_out,
    }


__all__ = ["porch_json"]
