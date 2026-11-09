"""Talking about posts: comments (one level of replies), reactions, polls
and saved posts (build §3.2, §3.5).

* **Comments** are seen by everyone who can see the post, oldest first.
  A reply hangs off a top comment; a reply to a reply goes to the same top
  comment (one level). You edit and delete your own; the post's author can
  also delete anyone's comment on their post (decision D5). Comments are
  always on. A deleted comment with replies keeps its place as "deleted".
* **Reactions** are one of a small fixed set of emoji, one per person per
  post or comment. Nobody sees counts. The post's (or comment's) author
  sees who reacted; everyone else sees only which emoji were used.
* **Polls**: 2–6 options, one vote each, changeable until the poll closes.
  Everyone who can see the post sees the counts and who voted for what
  (decision D4), once they've voted, the poll has closed, or it's theirs.
* **Saved posts** are a private list (``posts.saved``).

Blocks: comments, reactions and votes of people with a block either way
with the viewer aren't there for them (``blocks.hidden_ids``). Every route
first loads the post through ``access.load_post`` (404 when you can't see it).
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, activity, core, push
from .deps import require_porch
from .models import PorchComment, PorchPollOption, PorchPollVote, PorchPost, PorchReaction, PorchSave

router = APIRouter()

#: The fixed set (the same six as Rooms' quick reactions).
REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🙏")
HEART = "❤️"
POLL_CLOSES = {"1d": timedelta(days=1), "3d": timedelta(days=3), "1w": timedelta(weeks=1), "never": None}
COMMENTS_MAX = 1000
_AT = re.compile(r"(?<![\w.@-])@([\w.-]{1,64})", re.UNICODE)


def _norm_emoji(e: str) -> str:
    e = (e or "").strip()
    if e == "❤":  # without the emoji variation selector
        e = HEART
    if e not in REACTIONS:
        raise core.bad("Pick one of the reactions offered")
    return e


# ------------------------------------------------------------------ reactions as JSON


def reaction_summary(rows: list[PorchReaction], viewer_id: uuid.UUID, *, owner: bool, people: dict[str, Any]) -> dict[str, Any]:
    """Which emoji were used (most used first), yours, and — for the post's
    or comment's own author only — who reacted. Never a count for anyone else."""
    by: dict[str, int] = defaultdict(int)
    first: dict[str, Any] = {}
    mine = None
    for r in rows:
        by[r.emoji] += 1
        first.setdefault(r.emoji, r.created_at)
        if r.user_id == viewer_id:
            mine = r.emoji
    emojis = sorted(by, key=lambda e: (-by[e], first[e]))
    out: dict[str, Any] = {"emojis": emojis, "mine": mine}
    if owner:
        # Everyone else who reacted (newest first): "Mum, Sam and 3 others".
        recent = sorted((r for r in rows if r.user_id != viewer_id), key=lambda r: r.created_at, reverse=True)
        out["people"] = [people[str(r.user_id)] for r in recent[:3] if str(r.user_id) in people]
        out["count"] = len(recent)
    return out


async def _reactions(db: AsyncSession, target_type: str, ids: list[uuid.UUID], hidden: set[uuid.UUID]) -> dict[uuid.UUID, list[PorchReaction]]:
    out: dict[uuid.UUID, list[PorchReaction]] = {i: [] for i in ids}
    if not ids:
        return out
    q = select(PorchReaction).where(PorchReaction.target_type == target_type, PorchReaction.target_id.in_(ids))
    for r in (await db.execute(q)).scalars():
        if r.user_id not in hidden:
            out[r.target_id].append(r)
    return out


# ------------------------------------------------------------------ comments as JSON


def _visible_comments(post_ids: list[uuid.UUID], hidden: set[uuid.UUID]):  # noqa: ANN202 — a select
    """Live comments on these posts that a viewer with these ``hidden``
    people sees: not deleted, not by a hidden person, and not a reply under
    a hidden person's comment."""
    parent = aliased(PorchComment)
    q = (
        select(PorchComment)
        .outerjoin(parent, parent.id == PorchComment.parent_id)
        .where(PorchComment.post_id.in_(post_ids), PorchComment.deleted_at.is_(None))
    )
    if hidden:
        q = q.where(PorchComment.author_id.not_in(hidden), (parent.id.is_(None)) | parent.author_id.not_in(hidden))
    return q


def comment_out(
    c: PorchComment, viewer: User, post: PorchPost, people: dict[str, Any], hidden: set[uuid.UUID],
    reactions: list[PorchReaction] | None = None,
) -> dict[str, Any]:
    deleted = c.deleted_at is not None
    mine = c.author_id == viewer.id
    rx = reactions or []
    return {
        "id": str(c.id),
        "post_id": str(c.post_id),
        "parent_id": str(c.parent_id) if c.parent_id else None,
        "author": None if deleted else people.get(str(c.author_id)),
        "body": "" if deleted else c.body,
        "mentions": [] if deleted else [people[m] for m in (c.mentions or []) if m in people and uuid.UUID(m) not in hidden],
        "deleted": deleted,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "edited_at": c.edited_at.isoformat() if c.edited_at and not deleted else None,
        "mine": mine and not deleted,
        "can_edit": mine and not deleted,
        # D5: the post's author can delete anyone's comment on their post.
        "can_delete": not deleted and (mine or post.author_id == viewer.id),
        "reactions": reaction_summary(rx, viewer.id, owner=mine, people=people) if not deleted else {"emojis": [], "mine": None},
    }


async def comments_out(db: AsyncSession, viewer: User, post: PorchPost) -> dict[str, Any]:
    """A post's comments as ``viewer`` sees them: top comments oldest first,
    each with its replies (oldest first)."""
    hidden = await blocks.hidden_ids(db, viewer.id)
    rows = list(
        (
            await db.execute(
                select(PorchComment)
                .where(PorchComment.post_id == post.id)
                .order_by(PorchComment.created_at, PorchComment.id)
                .limit(COMMENTS_MAX)
            )
        ).scalars()
    )
    tops = [c for c in rows if c.parent_id is None]
    replies: dict[uuid.UUID, list[PorchComment]] = defaultdict(list)
    for c in rows:
        if c.parent_id is not None and c.deleted_at is None and c.author_id not in hidden:
            replies[c.parent_id].append(c)
    shown_tops = []
    for t in tops:
        if t.author_id in hidden:
            continue  # a blocked person's comment, and its thread, aren't there for you
        if t.deleted_at is not None and not replies.get(t.id):
            continue
        shown_tops.append(t)
    shown = shown_tops + [r for t in shown_tops for r in replies.get(t.id, [])]
    ids = [c.id for c in shown]
    rx = await _reactions(db, "comment", ids, hidden)
    mentioned = {uuid.UUID(m) for c in shown for m in (c.mentions or [])}
    people = await core.users_map(db, {c.author_id for c in shown} | mentioned | {u for rs in rx.values() for u in (r.user_id for r in rs)})
    out = []
    for t in shown_tops:
        d = comment_out(t, viewer, post, people, hidden, rx.get(t.id))
        d["replies"] = [comment_out(r, viewer, post, people, hidden, rx.get(r.id)) for r in replies.get(t.id, [])]
        out.append(d)
    count = sum(1 for c in shown if c.deleted_at is None)
    return {"comments": out, "count": count}


# ------------------------------------------------------------------ the post's extras


async def decorate(db: AsyncSession, viewer: User, posts: list[PorchPost], out: list[dict[str, Any]]) -> None:
    """Add what's talked about to each post's JSON: how many comments and the
    latest two, the reactions, the poll, and whether you saved it."""
    if not posts:
        return
    ids = [p.id for p in posts]
    hidden = await blocks.hidden_ids(db, viewer.id)

    vis = _visible_comments(ids, hidden).subquery()
    counts = {pid: int(n) for pid, n in (await db.execute(select(vis.c.post_id, func.count()).group_by(vis.c.post_id))).all()}
    ranked = select(
        vis, func.row_number().over(partition_by=vis.c.post_id, order_by=(vis.c.created_at.desc(), vis.c.id.desc())).label("rn")
    ).subquery()
    latest_rows = (await db.execute(select(ranked).where(ranked.c.rn <= 2))).all()

    rx = await _reactions(db, "post", ids, hidden)
    saved = set((await db.execute(select(PorchSave.post_id).where(PorchSave.user_id == viewer.id, PorchSave.post_id.in_(ids)))).scalars())
    polls = await _polls(db, viewer, [p for p in posts if p.kind == "poll"], hidden)

    people = await core.users_map(
        db, {r.author_id for r in latest_rows} | {r.user_id for rs in rx.values() for r in rs} | {u for p in polls.values() for u in p.pop("_users", set())}
    )
    latest: dict[uuid.UUID, list[dict[str, Any]]] = defaultdict(list)
    for r in sorted(latest_rows, key=lambda r: (r.created_at, r.id)):
        latest[r.post_id].append(
            {"id": str(r.id), "parent_id": str(r.parent_id) if r.parent_id else None, "author": people.get(str(r.author_id)), "body": r.body}
        )
    for p, d in zip(posts, out):
        d["comment_count"] = counts.get(p.id, 0)
        d["latest_comments"] = latest.get(p.id, [])
        d["reactions"] = reaction_summary(rx.get(p.id, []), viewer.id, owner=p.author_id == viewer.id, people=people)
        d["saved"] = p.id in saved
        poll = polls.get(p.id)
        if poll is not None:
            for o in poll["options"]:
                if o["voters"] is not None:
                    o["voters"] = [people[u] for u in o["voters"] if u in people]
        d["poll"] = poll


async def _polls(db: AsyncSession, viewer: User, posts: list[PorchPost], hidden: set[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    """Each poll as ``viewer`` sees it. Results (counts and who voted for
    what, decision D4) once they've voted, it's closed, or it's theirs."""
    if not posts:
        return {}
    ids = [p.id for p in posts]
    options: dict[uuid.UUID, list[PorchPollOption]] = defaultdict(list)
    for o in (await db.execute(select(PorchPollOption).where(PorchPollOption.post_id.in_(ids)).order_by(PorchPollOption.position))).scalars():
        options[o.post_id].append(o)
    votes: dict[uuid.UUID, list[PorchPollVote]] = defaultdict(list)
    for v in (await db.execute(select(PorchPollVote).where(PorchPollVote.post_id.in_(ids)).order_by(PorchPollVote.created_at))).scalars():
        if v.user_id not in hidden:
            votes[v.post_id].append(v)
    now = core.now()
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for p in posts:
        vs = votes.get(p.id, [])
        mine = next((v.option_id for v in vs if v.user_id == viewer.id), None)
        closed = p.poll_closes_at is not None and p.poll_closes_at <= now
        show = closed or mine is not None or p.author_id == viewer.id
        by_option: dict[uuid.UUID, list[str]] = defaultdict(list)
        for v in vs:
            by_option[v.option_id].append(str(v.user_id))
        out[p.id] = {
            "options": [
                {
                    "id": str(o.id),
                    "label": o.label,
                    "votes": len(by_option.get(o.id, [])) if show else None,
                    "voters": by_option.get(o.id, []) if show else None,
                }
                for o in options.get(p.id, [])
            ],
            "closes_at": p.poll_closes_at.isoformat() if p.poll_closes_at else None,
            "closed": closed,
            "my_vote": str(mine) if mine else None,
            "show_results": show,
            "total": len(vs) if show else None,
            "_users": {v.user_id for v in vs} if show else set(),
        }
    return out


# ------------------------------------------------------------------ polls: making one


class PollIn(BaseModel):
    options: list[str] = Field(min_length=2, max_length=6)
    closes: Literal["1d", "3d", "1w", "never"] = "never"


async def add_poll(db: AsyncSession, post: PorchPost, poll: PollIn) -> None:
    """The options of a new poll (flushed). The question is the post's words."""
    labels = [o.strip() for o in poll.options]
    if any(not o for o in labels):
        raise core.bad("Fill in every option, or take the empty ones out")
    if any(len(o) > 80 for o in labels):
        raise core.bad("Keep each option under 80 characters")
    if len({o.lower() for o in labels}) != len(labels):
        raise core.bad("Two options are the same")
    delta = POLL_CLOSES[poll.closes]
    post.poll_closes_at = core.now() + delta if delta else None
    for i, label in enumerate(labels):
        db.add(PorchPollOption(post_id=post.id, position=i, label=label))
    await db.flush()


# ------------------------------------------------------------------ mentions


async def mentioned_ids(db: AsyncSession, post: PorchPost, author_id: uuid.UUID, body: str, wanted: list[uuid.UUID]) -> list[str]:
    """Who a comment @mentions: people picked from the list, or named as
    @username in the words — only people who can see the post, never the
    writer, and nobody with a block either way with the writer."""
    audience = await access.audience_ids(db, post)
    hidden = await blocks.hidden_ids(db, author_id)
    names = {m.lower() for m in _AT.findall(body or "")}
    found: list[uuid.UUID] = list(dict.fromkeys(wanted))
    if names and audience:
        rows = (await db.execute(select(User.id).where(User.id.in_(audience), func.lower(User.username).in_(names)))).scalars()
        found += [u for u in rows if u not in found]
    return [str(u) for u in found if u in audience and u != author_id and u not in hidden]


# ------------------------------------------------------------------ comments: routes


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    parent_id: uuid.UUID | None = None
    mentions: list[uuid.UUID] = Field(default_factory=list, max_length=50)


class CommentPatch(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    mentions: list[uuid.UUID] = Field(default_factory=list, max_length=50)


async def _load_comment(db: AsyncSession, user: User, comment_id: uuid.UUID) -> tuple[PorchComment, PorchPost]:
    """A comment you can see (on a post you can see, by someone with no
    block either way), else 404."""
    c = await db.get(PorchComment, comment_id)
    if c is None or c.deleted_at is not None:
        raise core.not_found("Comment")
    post = await access.load_post(db, user, c.post_id)
    if await blocks.either(db, user.id, c.author_id):
        raise core.not_found("Comment")
    return c, post


async def _comment_event(db: AsyncSession, post: PorchPost, comment_id: uuid.UUID) -> None:
    await core.publish(await access.audience_ids(db, post), {"type": "comment", "post_id": str(post.id), "comment_id": str(comment_id)})


@router.get("/posts/{post_id}/comments")
async def list_comments(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    post = await access.load_post(db, user, post_id)
    return await comments_out(db, user, post)


@router.post("/posts/{post_id}/comments", status_code=201)
async def add_comment(post_id: uuid.UUID, body: CommentIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Comment on a post you can see, or reply to a comment on it."""
    post = await access.load_post(db, user, post_id)
    text_ = body.body.strip()
    if not text_:
        raise core.bad("Write something first")
    parent: PorchComment | None = None
    top_id: uuid.UUID | None = None
    if body.parent_id is not None:
        parent = await db.get(PorchComment, body.parent_id)
        if parent is None or parent.post_id != post.id or parent.deleted_at is not None or await blocks.either(db, user.id, parent.author_id):
            raise core.not_found("Comment")
        top_id = parent.parent_id or parent.id
        top = await db.get(PorchComment, top_id) if top_id != parent.id else parent
        if top is None or await blocks.either(db, user.id, top.author_id):
            raise core.not_found("Comment")
    c = PorchComment(post_id=post.id, author_id=user.id, parent_id=top_id, body=text_, created_at=core.now())
    c.mentions = await mentioned_ids(db, post, user.id, text_, body.mentions)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    await _comment_event(db, post, c.id)
    await activity.after_comment(db, post, c, parent)
    hidden = await blocks.hidden_ids(db, user.id)
    people = await core.users_map(db, {user.id} | {uuid.UUID(m) for m in c.mentions})
    out = comment_out(c, user, post, people, hidden)
    out["replies"] = []
    return out


@router.patch("/comments/{comment_id}")
async def edit_comment(comment_id: uuid.UUID, body: CommentPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Change your own comment's words ("edited")."""
    c, post = await _load_comment(db, user, comment_id)
    if c.author_id != user.id:
        raise core.forbidden("Only the person who wrote it can change it")
    text_ = body.body.strip()
    if not text_:
        raise core.bad("Write something first")
    before = set(c.mentions or [])
    c.body = text_
    c.mentions = await mentioned_ids(db, post, user.id, text_, body.mentions)
    c.edited_at = core.now()
    await db.commit()
    await db.refresh(c)
    await _comment_event(db, post, c.id)
    new = [uuid.UUID(m) for m in c.mentions if m not in before]
    if new:
        await activity.tell(db, new, actor=user.id)
        await push.comment_added(db, post, c, None, mentioned=new)
    hidden = await blocks.hidden_ids(db, user.id)
    rx = await _reactions(db, "comment", [c.id], hidden)
    people = await core.users_map(db, {user.id} | {uuid.UUID(m) for m in c.mentions} | {r.user_id for r in rx[c.id]})
    return comment_out(c, user, post, people, hidden, rx[c.id])


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """Delete your own comment, or any comment on your own post (D5)."""
    c, post = await _load_comment(db, user, comment_id)
    if c.author_id != user.id and post.author_id != user.id:
        raise core.forbidden("Only the person who wrote it, or the post's author, can delete it")
    c.deleted_at = core.now()
    await db.execute(delete(PorchReaction).where(PorchReaction.target_type == "comment", PorchReaction.target_id == c.id))
    await db.commit()
    await _comment_event(db, post, c.id)


# ------------------------------------------------------------------ reactions: routes


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


async def _react(db: AsyncSession, user: User, target_type: str, target_id: uuid.UUID, post: PorchPost, emoji: str | None) -> None:
    if emoji is None:
        await db.execute(
            delete(PorchReaction).where(PorchReaction.target_type == target_type, PorchReaction.target_id == target_id, PorchReaction.user_id == user.id)
        )
    else:
        stmt = insert(PorchReaction).values(
            target_type=target_type, target_id=target_id, user_id=user.id, post_id=post.id, emoji=emoji, created_at=core.now()
        )
        await db.execute(stmt.on_conflict_do_update(index_elements=["target_type", "target_id", "user_id"], set_={"emoji": emoji}))
    await db.commit()


async def _summary(db: AsyncSession, user: User, target_type: str, target_id: uuid.UUID, owner: bool) -> dict[str, Any]:
    hidden = await blocks.hidden_ids(db, user.id)
    rows = (await _reactions(db, target_type, [target_id], hidden))[target_id]
    people = await core.users_map(db, {r.user_id for r in rows}) if owner else {}
    return reaction_summary(rows, user.id, owner=owner, people=people)


async def _who(db: AsyncSession, user: User, target_type: str, target_id: uuid.UUID) -> list[dict[str, Any]]:
    hidden = await blocks.hidden_ids(db, user.id)
    rows = sorted((await _reactions(db, target_type, [target_id], hidden))[target_id], key=lambda r: r.created_at, reverse=True)
    people = await core.users_map(db, {r.user_id for r in rows})
    return [
        {"user": people[str(r.user_id)], "emoji": r.emoji, "created_at": r.created_at.isoformat() if r.created_at else None}
        for r in rows if str(r.user_id) in people
    ]


@router.put("/posts/{post_id}/reactions")
async def react_post(post_id: uuid.UUID, body: ReactionIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    post = await access.load_post(db, user, post_id)
    emoji = _norm_emoji(body.emoji)
    fresh = await db.get(PorchReaction, ("post", post.id, user.id)) is None
    await _react(db, user, "post", post.id, post, emoji)
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
    if fresh and post.author_id != user.id:
        await activity.tell(db, [post.author_id], actor=user.id)
        await push.reacted(db, post, user, emoji)
    return await _summary(db, user, "post", post.id, post.author_id == user.id)


@router.delete("/posts/{post_id}/reactions")
async def unreact_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    post = await access.load_post(db, user, post_id)
    await _react(db, user, "post", post.id, post, None)
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
    return await _summary(db, user, "post", post.id, post.author_id == user.id)


@router.get("/posts/{post_id}/reactions")
async def post_reactions(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Who reacted to your post (yours only: nobody else sees names or counts)."""
    post = await access.load_post(db, user, post_id)
    if post.author_id != user.id:
        raise core.forbidden("Only the person who posted it sees who reacted")
    return await _who(db, user, "post", post.id)


@router.put("/comments/{comment_id}/reactions")
async def react_comment(comment_id: uuid.UUID, body: ReactionIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    c, post = await _load_comment(db, user, comment_id)
    emoji = _norm_emoji(body.emoji)
    fresh = await db.get(PorchReaction, ("comment", c.id, user.id)) is None
    await _react(db, user, "comment", c.id, post, emoji)
    await _comment_event(db, post, c.id)
    if fresh and c.author_id != user.id:
        await activity.tell(db, [c.author_id], actor=user.id)
        await push.reacted(db, post, user, emoji, comment=c)
    return await _summary(db, user, "comment", c.id, c.author_id == user.id)


@router.delete("/comments/{comment_id}/reactions")
async def unreact_comment(comment_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    c, post = await _load_comment(db, user, comment_id)
    await _react(db, user, "comment", c.id, post, None)
    await _comment_event(db, post, c.id)
    return await _summary(db, user, "comment", c.id, c.author_id == user.id)


@router.get("/comments/{comment_id}/reactions")
async def comment_reactions(comment_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Who reacted to your comment (yours only)."""
    c, _ = await _load_comment(db, user, comment_id)
    if c.author_id != user.id:
        raise core.forbidden("Only the person who wrote it sees who reacted")
    return await _who(db, user, "comment", c.id)


# ------------------------------------------------------------------ polls: voting


class VoteIn(BaseModel):
    option_id: uuid.UUID


async def _poll(db: AsyncSession, user: User, post_id: uuid.UUID) -> PorchPost:
    post = await access.load_post(db, user, post_id)
    if post.kind != "poll":
        raise core.not_found("Poll")
    if post.poll_closes_at is not None and post.poll_closes_at <= core.now():
        raise core.bad("This poll has closed")
    return post


@router.put("/posts/{post_id}/vote")
async def vote(post_id: uuid.UUID, body: VoteIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Vote, or change your vote, until the poll closes."""
    from .posts import post_out

    post = await _poll(db, user, post_id)
    opt = await db.get(PorchPollOption, body.option_id)
    if opt is None or opt.post_id != post.id:
        raise core.not_found("Option")
    stmt = insert(PorchPollVote).values(post_id=post.id, user_id=user.id, option_id=opt.id, created_at=core.now())
    await db.execute(stmt.on_conflict_do_update(index_elements=["post_id", "user_id"], set_={"option_id": opt.id}))
    await db.commit()
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
    return await post_out(db, user, post)


@router.delete("/posts/{post_id}/vote")
async def unvote(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Take your vote back (until the poll closes)."""
    from .posts import post_out

    post = await _poll(db, user, post_id)
    await db.execute(delete(PorchPollVote).where(PorchPollVote.post_id == post.id, PorchPollVote.user_id == user.id))
    await db.commit()
    await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
    return await post_out(db, user, post)


# ------------------------------------------------------------------ saved posts


@router.put("/posts/{post_id}/save")
async def save(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    post = await access.load_post(db, user, post_id)
    await db.execute(insert(PorchSave).values(user_id=user.id, post_id=post.id, created_at=core.now()).on_conflict_do_nothing())
    await db.commit()
    return {"saved": True}


@router.delete("/posts/{post_id}/save")
async def unsave(post_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    # No visibility check: you can always take a post out of your own list.
    await db.execute(delete(PorchSave).where(PorchSave.user_id == user.id, PorchSave.post_id == post_id))
    await db.commit()
    return {"saved": False}


__all__ = ["HEART", "REACTIONS", "PollIn", "add_poll", "comment_out", "comments_out", "decorate", "router"]
