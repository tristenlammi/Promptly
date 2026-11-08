"""Reports and removals (build §3.4, WP-P1.7).

* Anyone can **report** a post or comment they can see (not their own). The
  server admins get a nudge ("Something was reported in Porch"), never who
  reported it or what it says; the queue is in Admin → Porch.
* A server admin **removes** a reported post or comment (gone for everyone)
  or **keeps** it; every open report on the same thing is closed with it.
  A post in Everyone can also be taken **out of Everyone** (it stays in the
  poster's other groups; with none left, it's gone).
* The poster is told, with the reason (``porch_removals``: their Activity
  and a push). Nobody else is.

While a post has an open report, the server admins can see it in the queue
(its words and photos, through :func:`admin_may_review` in the photo-link
check) — the one way an admin sees into a group they're not in, and only
for something someone reported.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, push
from .deps import require_porch
from .models import PorchComment, PorchGroup, PorchPost, PorchPostGroup, PorchReaction, PorchRemoval, PorchReport

router = APIRouter()


def _snip(s: str | None, n: int = 200) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# ------------------------------------------------------------------ reporting


class ReportIn(BaseModel):
    target_type: Literal["post", "comment"]
    target_id: uuid.UUID
    reason: str = Field(default="", max_length=500)


@router.post("/reports", status_code=201)
async def report(body: ReportIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Report a post or comment you can see to the people who run this
    Promptly. Reporting the same thing again updates your reason."""
    if body.target_type == "post":
        post = await access.load_post(db, user, body.target_id)
        if post.author_id == user.id:
            raise core.bad("This is your own post. You can delete it instead.")
    else:
        c = await db.get(PorchComment, body.target_id)
        if c is None or c.deleted_at is not None:
            raise core.not_found("Comment")
        await access.load_post(db, user, c.post_id)
        if await blocks.either(db, user.id, c.author_id):
            raise core.not_found("Comment")
        if c.author_id == user.id:
            raise core.bad("This is your own comment. You can delete it instead.")
    reason = body.reason.strip()
    row = (
        await db.execute(
            select(PorchReport).where(
                PorchReport.reporter_id == user.id, PorchReport.target_type == body.target_type,
                PorchReport.target_id == body.target_id, PorchReport.status == "open",
            )
        )
    ).scalar_one_or_none()
    fresh = row is None
    if row is None:
        row = PorchReport(reporter_id=user.id, target_type=body.target_type, target_id=body.target_id, reason=reason, status="open")
        db.add(row)
    else:
        row.reason = reason or row.reason
    await db.commit()
    if fresh:
        await _tell_admins(db)
    return {"id": str(row.id), "status": row.status}


async def _tell_admins(db: AsyncSession) -> None:
    """A nudge for the server admins: no reporter, no content."""
    from app.notifications.dispatch import notify_user

    admins = (await db.execute(select(User.id).where(User.role == "admin", User.disabled.is_(False)))).scalars().all()
    n = await open_count(db)
    for uid in admins:
        try:
            await notify_user(
                user_id=uid, category="system_alert", title="Something was reported in Porch",
                body=f"{n} {'report is' if n == 1 else 'reports are'} waiting in Admin → Porch.",
                url="/admin?tab=porch", tag="porch-reports",
            )
        except Exception:  # noqa: BLE001
            core.logger.warning("porch report nudge failed", exc_info=True)


async def open_count(db: AsyncSession) -> int:
    """Things (not reports) waiting for an admin."""
    from sqlalchemy import func, tuple_

    q = select(func.count(func.distinct(tuple_(PorchReport.target_type, PorchReport.target_id)))).where(PorchReport.status == "open")
    return int((await db.execute(q)).scalar() or 0)


async def admin_may_review(db: AsyncSession, user: User, post_id: uuid.UUID) -> bool:
    """A server admin looking at a post someone reported (still open, still up)."""
    if not user.is_admin:
        return False
    q = select(
        exists().where(
            PorchReport.status == "open", PorchReport.target_type == "post", PorchReport.target_id == post_id,
            PorchPost.id == post_id, PorchPost.deleted_at.is_(None),
        )
    )
    return bool((await db.execute(q)).scalar())


# ------------------------------------------------------------------ the queue (admin)


async def _groups_line(db: AsyncSession, admin: User, post_id: uuid.UUID) -> dict[str, Any]:
    """Where the post is, as far as the admin should know: Everyone, the
    groups they're in themselves by name, and how many others."""
    rows = (
        await db.execute(
            select(PorchGroup)
            .join(PorchPostGroup, PorchPostGroup.group_id == PorchGroup.id)
            .where(PorchPostGroup.post_id == post_id, PorchGroup.deleted_at.is_(None))
        )
    ).scalars().all()
    mine = {m.group.id for m in await access.my_groups(db, admin)}
    named = [access.group_label(g) for g in rows if g.kind == "everyone" or g.id in mine]
    return {"in_everyone": any(g.kind == "everyone" for g in rows), "named": named, "others": sum(1 for g in rows if g.kind != "everyone" and g.id not in mine)}


async def _target_out(db: AsyncSession, admin: User, target_type: str, target_id: uuid.UUID) -> dict[str, Any]:
    from . import media

    post: PorchPost | None
    comment: PorchComment | None = None
    if target_type == "comment":
        comment = await db.get(PorchComment, target_id)
        post = await db.get(PorchPost, comment.post_id) if comment is not None else None
    else:
        post = await db.get(PorchPost, target_id)
    gone = post is None or post.deleted_at is not None or (target_type == "comment" and (comment is None or comment.deleted_at is not None))
    out: dict[str, Any] = {"type": target_type, "id": str(target_id), "gone": gone}
    author_id = comment.author_id if comment is not None else (post.author_id if post is not None else None)
    people = await core.users_map(db, [author_id])
    out["author"] = people.get(str(author_id)) if author_id else None
    if post is None:
        return out
    out["post_id"] = str(post.id)
    out["kind"] = post.kind
    out["created_at"] = (comment.created_at if comment is not None else post.created_at).isoformat()
    out["body"] = (comment.body if comment is not None else post.body) if not gone else ""
    if comment is not None and not gone:
        out["post_body"] = _snip(post.body, 120)
    out["groups"] = await _groups_line(db, admin, post.id)
    out["media"] = []
    if target_type == "post" and not gone:
        for pm, row, fm in (await media.live_media(db, [post.id])).get(post.id, []):
            m = media.media_out(admin, pm, row, fm, author=False)
            out["media"].append({"thumb": m.get("thumb") or m.get("poster"), "preview": m.get("preview") or m.get("poster"), "alt": pm.alt_text, "video": media.is_video(row, fm)})
    return out


async def queue(db: AsyncSession, admin: User) -> list[dict[str, Any]]:
    """Open reports, one row per thing reported (oldest first), with every
    reason given."""
    rows = (await db.execute(select(PorchReport).where(PorchReport.status == "open").order_by(PorchReport.created_at))).scalars().all()
    grouped: dict[tuple[str, uuid.UUID], list[PorchReport]] = {}
    for r in rows:
        grouped.setdefault((r.target_type, r.target_id), []).append(r)
    people = await core.users_map(db, {r.reporter_id for r in rows})
    out = []
    for (tt, tid), reps in grouped.items():
        out.append(
            {
                "id": str(reps[0].id),
                "target": await _target_out(db, admin, tt, tid),
                "reports": [
                    {"id": str(r.id), "reporter": people.get(str(r.reporter_id)) if r.reporter_id else None, "reason": r.reason, "created_at": r.created_at.isoformat()}
                    for r in reps
                ],
                "first_at": reps[0].created_at.isoformat(),
            }
        )
    return out


async def handled(db: AsyncSession, limit: int = 30) -> list[dict[str, Any]]:
    """The latest decisions, for the record."""
    rows = (
        await db.execute(
            select(PorchReport).where(PorchReport.status != "open").order_by(PorchReport.handled_at.desc().nulls_last()).limit(200)
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


async def _close(db: AsyncSession, admin: User, target_type: str, target_id: uuid.UUID, status: str, note: str) -> int:
    rows = (
        await db.execute(
            select(PorchReport).where(PorchReport.target_type == target_type, PorchReport.target_id == target_id, PorchReport.status == "open")
        )
    ).scalars().all()
    for r in rows:
        r.status, r.handled_by, r.handled_at, r.note = status, admin.id, core.now(), note
    return len(rows)


async def remove_post(db: AsyncSession, admin: User, post: PorchPost, reason: str, *, scope: str = "all") -> dict[str, Any]:
    """Take a post down (``all``) or out of Everyone (``everyone``). The
    poster is told why. Commits."""
    audience = await access.audience_ids(db, post)
    if scope == "everyone":
        ev = await core.everyone(db)
        await db.execute(delete(PorchPostGroup).where(PorchPostGroup.post_id == post.id, PorchPostGroup.group_id == ev.id))
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
    else:
        post.deleted_at = core.now()
    db.add(
        PorchRemoval(
            author_id=post.author_id, target_type="post", target_id=post.id, post_id=post.id, scope=scope,
            reason=reason, snippet=_snip(post.body) or {"photo": "A photo post", "video": "A video", "poll": "A poll"}.get(post.kind, "A post"),
            removed_by=admin.id,
        )
    )
    closed = await _close(db, admin, "post", post.id, "removed", reason) if scope == "all" else 0
    await db.commit()
    await core.publish(audience, {"type": "post_change", "post_id": str(post.id)})
    await core.publish([post.author_id], {"type": "activity"})
    await push.removed(db, post.author_id, what="post", scope=scope, reason=reason)
    return {"closed": closed, "deleted": post.deleted_at is not None}


async def remove_comment(db: AsyncSession, admin: User, c: PorchComment, reason: str) -> dict[str, Any]:
    post = await db.get(PorchPost, c.post_id)
    c.deleted_at = core.now()
    await db.execute(delete(PorchReaction).where(PorchReaction.target_type == "comment", PorchReaction.target_id == c.id))
    db.add(
        PorchRemoval(author_id=c.author_id, target_type="comment", target_id=c.id, post_id=c.post_id, scope="all", reason=reason, snippet=_snip(c.body), removed_by=admin.id)
    )
    closed = await _close(db, admin, "comment", c.id, "removed", reason)
    await db.commit()
    if post is not None:
        await core.publish(await access.audience_ids(db, post), {"type": "comment", "post_id": str(post.id), "comment_id": str(c.id)})
    await core.publish([c.author_id], {"type": "activity"})
    await push.removed(db, c.author_id, what="comment", scope="all", reason=reason)
    return {"closed": closed, "deleted": True}


async def decide(db: AsyncSession, admin: User, report_id: uuid.UUID, action: str, reason: str) -> dict[str, Any]:
    """Remove or keep what a report is about (every open report on it is
    closed together)."""
    r = await db.get(PorchReport, report_id)
    if r is None:
        raise core.not_found("Report")
    reason = reason.strip()
    if action == "keep":
        closed = await _close(db, admin, r.target_type, r.target_id, "kept", reason)
        await db.commit()
        return {"closed": closed, "status": "kept"}
    if r.target_type == "post":
        post = await db.get(PorchPost, r.target_id)
        if post is None or post.deleted_at is not None:
            closed = await _close(db, admin, "post", r.target_id, "removed", reason)
            await db.commit()
            return {"closed": closed, "status": "removed", "already_gone": True}
        out = await remove_post(db, admin, post, reason)
    else:
        c = await db.get(PorchComment, r.target_id)
        if c is None or c.deleted_at is not None:
            closed = await _close(db, admin, "comment", r.target_id, "removed", reason)
            await db.commit()
            return {"closed": closed, "status": "removed", "already_gone": True}
        out = await remove_comment(db, admin, c, reason)
    return {**out, "status": "removed"}


# ------------------------------------------------------------------ the poster's side


async def removals_for(db: AsyncSession, user_id: uuid.UUID, since: Any) -> list[PorchRemoval]:
    q = select(PorchRemoval).where(PorchRemoval.author_id == user_id, PorchRemoval.created_at >= since).order_by(PorchRemoval.created_at.desc()).limit(50)
    return list((await db.execute(q)).scalars().all())


__all__ = ["admin_may_review", "decide", "handled", "open_count", "queue", "remove_comment", "remove_post", "removals_for", "router"]
