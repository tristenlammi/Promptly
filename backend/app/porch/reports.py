"""Reports and removals (build §3.4, WP-P1.7; WP-P2.0).

The rule: **a server admin sees another person's Porch content only as a
normal member who can see it.** So a report goes to whoever runs the group
the reporter saw it in, never to someone outside that group.

* Anyone can **report** a post, comment or story (WP-P2.1) they can see (not their own) to
  the admins of a group they see it through (their groups ∩ its groups),
  one report per person and group (``porch_reports.group_id``; NULL means
  Everyone, which the server admins run). If the only admin of a group is
  the person being reported, that group can't be picked: they'd be judging
  themselves, and nobody else is asked.
* The group's owner and admins get a push ("Something in Family was
  reported") and a line in Activity, and handle it in the group's
  **Reports** tab (Everyone's also in Admin → Porch). They see the reason,
  **never who reported it**, and they see what was reported only while they
  can see it themselves (``access.can_see_post``), it's still in their
  group, and it isn't their own.
* **Remove** takes a post out of that group only (it stays in its other
  groups; with none left, it's gone) or removes a comment. **Keep** leaves
  it. Every open report on the same thing in that group closes together.
* The poster is told, with the reason (``porch_removals``: their Activity
  and a push). Nobody else is.

Photos in the queue come through the normal signed ``porch_*`` links, so
they load only for someone who can see the post.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import case, delete, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, deps, push
from .deps import require_porch
from .models import (
    PorchComment, PorchGroup, PorchGroupMember, PorchPost, PorchPostGroup, PorchReaction, PorchRemoval, PorchReport, PorchStory,
    PorchStoryGroup,
)

router = APIRouter()


def _snip(s: str | None, n: int = 200) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _in_group(g: PorchGroup):  # noqa: ANN202 — SQL
    """Reports made in ``g`` (Everyone's are stored with no group)."""
    return PorchReport.group_id.is_(None) if g.kind == "everyone" else PorchReport.group_id == g.id


def _belongs(r: PorchReport, g: PorchGroup) -> bool:
    return r.group_id is None if g.kind == "everyone" else r.group_id == g.id


async def handler_ids(db: AsyncSession, g: PorchGroup) -> list[uuid.UUID]:
    """Who handles reports made in ``g``: its owner and admins; Everyone's,
    the server admins Porch is on for."""
    if g.kind == "everyone":
        s = await deps.settings(db)
        q = select(User.id).where(User.role == "admin", User.disabled.is_(False), deps.allowed_clause(s, User.id))
    else:
        q = select(PorchGroupMember.user_id).where(
            PorchGroupMember.group_id == g.id, PorchGroupMember.status == "member", PorchGroupMember.role.in_(("owner", "admin"))
        )
    return list((await db.execute(q)).scalars().all())


async def handles(db: AsyncSession, user: User, g: PorchGroup) -> bool:
    """``user`` runs ``g`` (and Porch is on for them)."""
    if g.deleted_at is not None or not await deps.allowed(db, user):
        return False
    m = await access.membership(db, g.id, user.id) if g.kind == "custom" else None
    return access.is_admin(user, g, m)


async def _live_groups(db: AsyncSession, post_id: uuid.UUID, *, story: bool = False) -> list[PorchGroup]:
    """A post's (or story's) groups that still exist."""
    link, col = (PorchStoryGroup, PorchStoryGroup.story_id) if story else (PorchPostGroup, PorchPostGroup.post_id)
    q = select(PorchGroup).join(link, link.group_id == PorchGroup.id).where(col == post_id, PorchGroup.deleted_at.is_(None))
    return list((await db.execute(q)).scalars().all())


async def _in(db: AsyncSession, post_id: uuid.UUID, g: PorchGroup, *, story: bool = False) -> bool:
    if story:
        q = select(PorchStoryGroup.story_id).where(PorchStoryGroup.story_id == post_id, PorchStoryGroup.group_id == g.id)
    else:
        q = select(PorchPostGroup.post_id).where(PorchPostGroup.post_id == post_id, PorchPostGroup.group_id == g.id)
    return (await db.execute(q)).first() is not None


# ------------------------------------------------------------------ reporting


class ReportIn(BaseModel):
    target_type: Literal["post", "comment", "story"]
    target_id: uuid.UUID
    reason: str = Field(default="", max_length=500)
    # The groups to report it in: yours that it's in (Everyone included).
    # Left out: every one of them whose admins can look at it.
    groups: list[uuid.UUID] | None = Field(default=None, max_length=50)


@router.post("/reports", status_code=201)
async def report(body: ReportIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Report a post, comment or story you can see to the admins of the
    group (or groups) you see it in. Reporting the same thing again in the
    same group updates your reason."""
    story = body.target_type == "story"
    post: PorchPost | PorchStory
    if story:
        # A story you see through one of your groups.
        post = await access.load_story(db, user, body.target_id, live=False)
        author_id = post.author_id
        if author_id == user.id:
            raise core.bad("This is your own story. You can delete it instead.")
    elif body.target_type == "post":
        post = await access.load_post(db, user, body.target_id)
        author_id = post.author_id
        if author_id == user.id:
            raise core.bad("This is your own post. You can delete it instead.")
    else:
        c = await db.get(PorchComment, body.target_id)
        if c is None or c.deleted_at is not None:
            raise core.not_found("Comment")
        post = await access.load_post(db, user, c.post_id)
        if await blocks.either(db, user.id, c.author_id):
            raise core.not_found("Comment")
        author_id = c.author_id
        if author_id == user.id:
            raise core.bad("This is your own comment. You can delete it instead.")

    mine = set(await access.my_group_ids(db, user))
    through = [g for g in await _live_groups(db, post.id, story=story) if g.id in mine]
    through.sort(key=lambda g: (g.kind == "everyone", g.name.lower()))
    if body.groups is not None:
        want = set(body.groups)
        picked = [g for g in through if g.id in want]
        if not picked or len(picked) != len(want):
            raise core.bad("Pick a group you see it in")
    else:
        picked = through
    author = await db.get(User, author_id)
    name = core.display_name(author) if author is not None else "they"
    handlers: dict[uuid.UUID, list[uuid.UUID]] = {}
    for g in picked:
        ids = [u for u in await handler_ids(db, g) if u != author_id]
        if ids:
            handlers[g.id] = ids
    if not handlers:
        g = picked[0] if picked else None
        if g is None:
            raise core.not_found()
        if g.kind == "everyone":
            raise core.bad(f"Only {name} runs {g.name}. You can block {name}.")
        raise core.bad(f"Only {name} runs {g.name}. You can leave the group or block {name}.")

    reason = body.reason.strip()
    fresh: list[PorchGroup] = []
    rows: list[PorchReport] = []
    for g in picked:
        if g.id not in handlers:
            continue
        gid = None if g.kind == "everyone" else g.id
        row = (
            await db.execute(
                select(PorchReport).where(
                    PorchReport.reporter_id == user.id, PorchReport.target_type == body.target_type,
                    PorchReport.target_id == body.target_id, PorchReport.status == "open",
                    PorchReport.group_id.is_(None) if gid is None else PorchReport.group_id == gid,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            row = PorchReport(reporter_id=user.id, group_id=gid, target_type=body.target_type, target_id=body.target_id, reason=reason, status="open")
            db.add(row)
            fresh.append(g)
        else:
            row.reason = reason or row.reason
        rows.append(row)
    await db.commit()
    for g in fresh:
        await _tell(db, g, handlers[g.id])
    return {
        "id": str(rows[0].id),
        "status": "open",
        "groups": [access.group_label(g) for g in picked if g.id in handlers],
    }


async def _tell(db: AsyncSession, g: PorchGroup, ids: list[uuid.UUID]) -> None:
    """The group's admins hear that something in it was reported: never
    who reported it or what it says."""
    from .activity import tell

    await tell(db, ids)
    await push.reported(db, g, ids)


# ------------------------------------------------------------------ waiting


def _author_of_target():  # noqa: ANN202 — SQL
    post_author = select(PorchPost.author_id).where(PorchPost.id == PorchReport.target_id).scalar_subquery()
    comment_author = select(PorchComment.author_id).where(PorchComment.id == PorchReport.target_id).scalar_subquery()
    story_author = select(PorchStory.author_id).where(PorchStory.id == PorchReport.target_id).scalar_subquery()
    return case((PorchReport.target_type == "comment", comment_author), (PorchReport.target_type == "story", story_author), else_=post_author)


async def waiting(db: AsyncSession, user: User, groups: list[PorchGroup] | None = None) -> dict[uuid.UUID, int]:
    """How many things wait in each group ``user`` runs (of ``groups``, or
    all theirs): reported and still open, not their own."""
    if groups is None:
        groups = [m.group for m in await access.my_groups(db, user) if m.is_admin]
    run = [g for g in groups if await handles(db, user, g)]
    if not run:
        return {}
    ev = next((g for g in run if g.kind == "everyone"), None)
    custom = [g.id for g in run if g.kind == "custom"]
    where = []
    if custom:
        where.append(PorchReport.group_id.in_(custom))
    if ev is not None:
        where.append(PorchReport.group_id.is_(None))
    q = (
        select(PorchReport.group_id, func.count(func.distinct(tuple_(PorchReport.target_type, PorchReport.target_id))))
        .where(PorchReport.status == "open", or_(*where), _author_of_target().is_distinct_from(user.id))
        .group_by(PorchReport.group_id)
    )
    out: dict[uuid.UUID, int] = {}
    for gid, n in (await db.execute(q)).all():
        key = ev.id if gid is None and ev is not None else gid
        if key is not None and n:
            out[key] = int(n)
    return out


async def open_count(db: AsyncSession, admin: User) -> int:
    """Things waiting for the server admins: reported in Everyone."""
    ev = await core.everyone(db)
    return (await waiting(db, admin, [ev])).get(ev.id, 0)


# ------------------------------------------------------------------ the queue


async def _groups_line(db: AsyncSession, viewer: User, post_id: uuid.UUID) -> dict[str, Any]:
    """Where the post is, as far as the handler should know: only their
    own groups, by name (never a hint of any other)."""
    named = (await access.labels(db, viewer, [post_id])).get(post_id, [])
    return {"in_everyone": any(g["kind"] == "everyone" for g in named), "named": named}


async def _target_out(db: AsyncSession, viewer: User, g: PorchGroup, target_type: str, target_id: uuid.UUID) -> dict[str, Any] | None:
    """What was reported, for someone who runs ``g`` — or None when it's not
    theirs to see (it's their own, a block, Porch off for them). Once it's
    deleted or out of ``g``, only that it's gone."""
    from . import media

    if target_type == "story":
        return await _story_target_out(db, viewer, g, target_id)
    comment: PorchComment | None = None
    if target_type == "comment":
        comment = await db.get(PorchComment, target_id)
        post = await db.get(PorchPost, comment.post_id) if comment is not None else None
    else:
        post = await db.get(PorchPost, target_id)
    gone = (
        post is None
        or post.deleted_at is not None
        or (target_type == "comment" and (comment is None or comment.deleted_at is not None))
        or not await _in(db, post.id, g)
    )
    out: dict[str, Any] = {"type": target_type, "id": str(target_id), "gone": gone}
    if gone:
        return out
    assert post is not None
    author_id = comment.author_id if comment is not None else post.author_id
    if author_id == viewer.id or not await access.can_see_post(db, viewer, post):
        return None
    if comment is not None and await blocks.either(db, viewer.id, comment.author_id):
        return None
    people = await core.users_map(db, [author_id])
    out["author"] = people.get(str(author_id))
    out["post_id"] = str(post.id)
    out["kind"] = post.kind
    out["created_at"] = (comment.created_at if comment is not None else post.created_at).isoformat()
    out["body"] = comment.body if comment is not None else post.body
    if comment is not None:
        out["post_body"] = _snip(post.body, 120)
    out["groups"] = await _groups_line(db, viewer, post.id)
    out["media"] = []
    if comment is None:
        for pm, row, fm in (await media.live_media(db, [post.id])).get(post.id, []):
            m = media.media_out(viewer, pm, row, fm, author=False)
            out["media"].append({"thumb": m.get("thumb") or m.get("poster"), "preview": m.get("preview") or m.get("poster"), "alt": pm.alt_text, "video": media.is_video(row, fm)})
    return out


async def _story_target_out(db: AsyncSession, viewer: User, g: PorchGroup, story_id: uuid.UUID) -> dict[str, Any] | None:
    """A reported story, for someone who runs ``g``: only while they can see
    it themselves through one of their groups."""
    from . import stories

    s = await db.get(PorchStory, story_id)
    gone = s is None or s.deleted_at is not None or not await _in(db, s.id, g, story=True)
    out: dict[str, Any] = {"type": "story", "id": str(story_id), "gone": gone}
    if gone:
        return out
    assert s is not None
    if s.author_id == viewer.id or not await access.can_see_story(db, viewer, s.id, live=False):
        return None
    shown = (await stories.stories_out(db, viewer, [s], views=False))[0]
    out["author"] = shown["author"]
    out["story_id"] = str(s.id)
    out["kind"] = s.kind
    out["created_at"] = shown["created_at"]
    out["body"] = s.text or " · ".join(str(o.get("text", "")) for o in s.overlays or [] if o.get("type") == "text")
    labels = shown["groups"]
    out["groups"] = {"in_everyone": any(x["kind"] == "everyone" for x in labels), "named": labels}
    m = shown["media"]
    out["media"] = (
        [{"thumb": m.get("thumb") or m.get("poster"), "preview": m.get("preview") or m.get("poster"), "alt": s.alt_text, "video": m["kind"] == "video"}]
        if m else []
    )
    out["background"] = s.background
    return out


async def queue(db: AsyncSession, viewer: User, g: PorchGroup) -> list[dict[str, Any]]:
    """Open reports in ``g`` for someone who runs it, one row per thing
    reported (oldest first), with every reason given — and not who gave
    them."""
    if not await handles(db, viewer, g):
        return []
    rows = (await db.execute(select(PorchReport).where(PorchReport.status == "open", _in_group(g)).order_by(PorchReport.created_at))).scalars().all()
    grouped: dict[tuple[str, uuid.UUID], list[PorchReport]] = {}
    for r in rows:
        grouped.setdefault((r.target_type, r.target_id), []).append(r)
    out = []
    for (tt, tid), reps in grouped.items():
        target = await _target_out(db, viewer, g, tt, tid)
        if target is None:
            continue
        out.append(
            {
                "id": str(reps[0].id),
                "group": access.group_label(g),
                "target": target,
                "reports": [{"id": str(r.id), "reason": r.reason, "created_at": r.created_at.isoformat()} for r in reps],
                "first_at": reps[0].created_at.isoformat(),
            }
        )
    return out


async def handled(db: AsyncSession, viewer: User, g: PorchGroup, limit: int = 30) -> list[dict[str, Any]]:
    """The latest decisions in ``g``, for the record (no content)."""
    if not await handles(db, viewer, g):
        return []
    rows = (
        await db.execute(
            select(PorchReport).where(PorchReport.status != "open", _in_group(g)).order_by(PorchReport.handled_at.desc().nulls_last()).limit(200)
        )
    ).scalars().all()
    seen: set[tuple[str, uuid.UUID]] = set()
    picked = []
    for r in rows:
        k = (r.target_type, r.target_id)
        if k in seen:
            continue
        seen.add(k)
        picked.append(r)
        if len(picked) >= limit:
            break
    people = await core.users_map(db, {r.handled_by for r in picked})
    return [
        {
            "id": str(r.id), "target_type": r.target_type, "status": r.status, "note": r.note,
            "handled_at": r.handled_at.isoformat() if r.handled_at else None,
            "handled_by": people.get(str(r.handled_by)) if r.handled_by else None,
        }
        for r in picked
    ]


# ------------------------------------------------------------------ deciding


async def _close(db: AsyncSession, by: User, target_type: str, target_id: uuid.UUID, status: str, note: str, g: PorchGroup | None) -> int:
    """Close the open reports on one thing: in ``g``, or everywhere (None:
    it's gone for everyone)."""
    q = select(PorchReport).where(PorchReport.target_type == target_type, PorchReport.target_id == target_id, PorchReport.status == "open")
    if g is not None:
        q = q.where(_in_group(g))
    rows = (await db.execute(q)).scalars().all()
    for r in rows:
        r.status, r.handled_by, r.handled_at, r.note = status, by.id, core.now(), note
    return len(rows)


async def remove_post(db: AsyncSession, by: User, post: PorchPost, reason: str, *, group: PorchGroup) -> dict[str, Any]:
    """Take a post out of one group (Everyone, or one of the poster's). It
    stays in its other groups; with none left, it's deleted. The poster is
    told why. Commits."""
    audience = await access.audience_ids(db, post)
    everyone = group.kind == "everyone"
    await db.execute(delete(PorchPostGroup).where(PorchPostGroup.post_id == post.id, PorchPostGroup.group_id == group.id))
    left = (
        await db.execute(
            select(PorchPostGroup.group_id)
            .join(PorchGroup, PorchGroup.id == PorchPostGroup.group_id)
            .where(PorchPostGroup.post_id == post.id, PorchGroup.deleted_at.is_(None))
            .limit(1)
        )
    ).first()
    if left is None:
        post.deleted_at = core.now()
    scope = "everyone" if everyone else "group"
    db.add(
        PorchRemoval(
            author_id=post.author_id, target_type="post", target_id=post.id, post_id=post.id, scope=scope,
            group_id=None if everyone else group.id,
            reason=reason, snippet=_snip(post.body) or {"photo": "A photo post", "video": "A video", "poll": "A poll"}.get(post.kind, "A post"),
            removed_by=by.id,
        )
    )
    deleted = post.deleted_at is not None
    closed = await _close(db, by, "post", post.id, "removed", reason, None if deleted else group)
    await db.commit()
    await core.publish(audience, {"type": "post_change", "post_id": str(post.id)})
    await core.publish([post.author_id], {"type": "activity"})
    await push.removed(db, post.author_id, what="post", scope=scope, reason=reason, group=group.name)
    return {"closed": closed, "deleted": deleted}


async def remove_comment(db: AsyncSession, by: User, c: PorchComment, reason: str, *, group: PorchGroup) -> dict[str, Any]:
    """Remove a comment (gone for everyone: comments are on the post, not a
    group). The commenter is told why. Commits."""
    post = await db.get(PorchPost, c.post_id)
    c.deleted_at = core.now()
    await db.execute(delete(PorchReaction).where(PorchReaction.target_type == "comment", PorchReaction.target_id == c.id))
    db.add(
        PorchRemoval(
            author_id=c.author_id, target_type="comment", target_id=c.id, post_id=c.post_id, scope="all",
            group_id=None if group.kind == "everyone" else group.id, reason=reason, snippet=_snip(c.body), removed_by=by.id,
        )
    )
    closed = await _close(db, by, "comment", c.id, "removed", reason, None)
    await db.commit()
    if post is not None:
        await core.publish(await access.audience_ids(db, post), {"type": "comment", "post_id": str(post.id), "comment_id": str(c.id)})
    await core.publish([c.author_id], {"type": "activity"})
    await push.removed(db, c.author_id, what="comment", scope="all", reason=reason, group=group.name)
    return {"closed": closed, "deleted": True}


async def remove_story(db: AsyncSession, by: User, s: PorchStory, reason: str, *, group: PorchGroup) -> dict[str, Any]:
    """Take a story out of one group; with none left, it's gone. The poster
    is told why. Commits."""
    audience = await access.story_audience_ids(db, s)
    everyone = group.kind == "everyone"
    await db.execute(delete(PorchStoryGroup).where(PorchStoryGroup.story_id == s.id, PorchStoryGroup.group_id == group.id))
    left = (
        await db.execute(
            select(PorchStoryGroup.group_id)
            .join(PorchGroup, PorchGroup.id == PorchStoryGroup.group_id)
            .where(PorchStoryGroup.story_id == s.id, PorchGroup.deleted_at.is_(None))
            .limit(1)
        )
    ).first()
    if left is None:
        from .highlights import story_gone

        s.deleted_at = core.now()
        await story_gone(db, s.id)
    scope = "everyone" if everyone else "group"
    snippet = _snip(s.text) or {"photo": "A photo story", "video": "A video story"}.get(s.kind, "A story")
    db.add(
        PorchRemoval(
            author_id=s.author_id, target_type="story", target_id=s.id, post_id=None, scope=scope,
            group_id=None if everyone else group.id, reason=reason, snippet=snippet, removed_by=by.id,
        )
    )
    deleted = s.deleted_at is not None
    closed = await _close(db, by, "story", s.id, "removed", reason, None if deleted else group)
    await db.commit()
    await core.publish(audience, {"type": "story", "user_id": str(s.author_id)})
    await core.publish([s.author_id], {"type": "activity"})
    await push.removed(db, s.author_id, what="story", scope=scope, reason=reason, group=group.name)
    return {"closed": closed, "deleted": deleted}


async def decide(db: AsyncSession, by: User, g: PorchGroup, report_id: uuid.UUID, action: str, reason: str) -> dict[str, Any]:
    """Remove or keep what a report in ``g`` is about. Only someone who runs
    ``g``, and only while they can see it; every open report on the same
    thing in ``g`` closes with it."""
    r = await db.get(PorchReport, report_id)
    if r is None or not _belongs(r, g) or not await handles(db, by, g):
        raise core.not_found("Report")
    reason = reason.strip()
    target = await _target_out(db, by, g, r.target_type, r.target_id)
    if target is None:
        raise core.not_found("Report")
    if target["gone"]:
        closed = await _close(db, by, r.target_type, r.target_id, "removed" if action == "remove" else "kept", reason, g)
        await db.commit()
        return {"closed": closed, "status": "removed" if action == "remove" else "kept", "already_gone": True}
    if action == "keep":
        closed = await _close(db, by, r.target_type, r.target_id, "kept", reason, g)
        await db.commit()
        return {"closed": closed, "status": "kept"}
    if r.target_type == "story":
        s = await db.get(PorchStory, r.target_id)
        assert s is not None
        out = await remove_story(db, by, s, reason, group=g)
    elif r.target_type == "post":
        post = await db.get(PorchPost, r.target_id)
        assert post is not None
        out = await remove_post(db, by, post, reason, group=g)
    else:
        c = await db.get(PorchComment, r.target_id)
        assert c is not None
        out = await remove_comment(db, by, c, reason, group=g)
    return {**out, "status": "removed"}


# ------------------------------------------------------------------ a group's Reports tab


async def _run_group(db: AsyncSession, user: User, group_id: uuid.UUID) -> PorchGroup:
    g, _m, _view = await access.load_group(db, user, group_id)
    if not await handles(db, user, g):
        raise core.forbidden("Only the group's admins see its reports")
    return g


@router.get("/groups/{group_id}/reports")
async def group_reports(
    group_id: uuid.UUID, status: Literal["open", "handled"] = "open", db: AsyncSession = Depends(get_db), user: User = Depends(require_porch),
) -> list[dict]:
    """A group's reports, for its owner and admins (Everyone's: the server
    admins)."""
    g = await _run_group(db, user, group_id)
    if status == "open":
        return await queue(db, user, g)
    return await handled(db, user, g)


class DecideIn(BaseModel):
    action: Literal["remove", "keep"]
    reason: str = Field(default="", max_length=500)


@router.post("/groups/{group_id}/reports/{report_id}")
async def group_decide(group_id: uuid.UUID, report_id: uuid.UUID, body: DecideIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Remove from this group (a post) or remove (a comment), with a reason
    the poster sees — or keep it."""
    g = await _run_group(db, user, group_id)
    return await decide(db, user, g, report_id, body.action, body.reason)


# ------------------------------------------------------------------ the poster's side


async def removals_for(db: AsyncSession, user_id: uuid.UUID, since: Any) -> list[PorchRemoval]:
    q = select(PorchRemoval).where(PorchRemoval.author_id == user_id, PorchRemoval.created_at >= since).order_by(PorchRemoval.created_at.desc()).limit(50)
    return list((await db.execute(q)).scalars().all())


__all__ = [
    "DecideIn", "decide", "handled", "handler_ids", "handles", "open_count", "queue", "remove_comment", "remove_post", "remove_story", "removals_for", "router", "waiting",
]
