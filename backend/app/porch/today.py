"""Porch on the Today page (build §7): new posts from the groups you've
ticked since you last looked at your feed, and today's birthdays of people
in your groups ("Post for Sam").

Called from ``today/hub.extend`` inside its own try, so Porch's trouble
costs its card, never the page. Nothing for someone Porch isn't on for.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import blocks

from . import access, core, deps, handoffs
from .models import PorchGroup, PorchGroupMember, PorchPost, PorchPostGroup, PorchProfile

#: With no "seen" mark yet (the feed never opened), this far back.
FIRST_LOOK = timedelta(days=7)
THUMBS = 3


def _is_birthday(b: date, today: date) -> bool:
    if (b.month, b.day) == (today.month, today.day):
        return True
    # 29 February on the 28th, in a year without one.
    if (b.month, b.day) == (2, 29) and (today.month, today.day) == (2, 28):
        try:
            date(today.year, 2, 29)
        except ValueError:
            return True
    return False


async def _new_where(db: AsyncSession, user: User, now: datetime) -> list | None:
    """Other people's posts in the groups you've ticked since you last had
    the top of your feed on screen (``feed_seen_at``), as WHERE clauses."""
    ticked = await access.ticked_group_ids(db, user)
    if not ticked:
        return None
    prof = await db.get(PorchProfile, user.id)
    since = prof.feed_seen_at if prof is not None and prof.feed_seen_at else now - FIRST_LOOK
    in_ticked = exists().where(PorchPostGroup.post_id == PorchPost.id, PorchPostGroup.group_id.in_(ticked))
    return [access.visible_post(user.id), in_ticked, PorchPost.created_at > since, PorchPost.author_id != user.id]


async def new_post_count(db: AsyncSession, user: User, now: datetime | None = None) -> int:
    """How many new posts are waiting in your feed (Today's card, the
    sidebar's Porch badge)."""
    where = await _new_where(db, user, now or core.now())
    if where is None:
        return 0
    return int((await db.execute(select(func.count()).select_from(PorchPost).where(*where))).scalar() or 0)


async def _new_posts(db: AsyncSession, user: User, now: datetime) -> dict[str, Any] | None:
    where = await _new_where(db, user, now)
    if where is None:
        return None
    n = int((await db.execute(select(func.count()).select_from(PorchPost).where(*where))).scalar() or 0)
    if not n:
        return None
    latest = list((await db.execute(select(PorchPost).where(*where).order_by(PorchPost.created_at.desc()).limit(12))).scalars())
    cards = await handoffs.summaries(db, user, latest)
    thumbs = [{"post_id": str(p.id), "thumb": cards[p.id]["thumb"], "url": cards[p.id]["href"]} for p in latest if cards[p.id]["thumb"]][:THUMBS]
    names: list[str] = []
    for p in latest:
        a = cards[p.id]["author"]
        if a and a["name"] not in names:
            names.append(a["name"])
    return {"count": n, "thumbs": thumbs, "from": names[:3], "more_people": max(0, len(names) - 3)}


async def _birthdays(db: AsyncSession, user: User, today: date) -> list[dict[str, Any]]:
    """People in a group with you (Everyone too, while it's ticked) who
    show their birthday and have one today."""
    mine = await access.my_groups(db, user)
    custom = [m.group.id for m in mine if not m.is_everyone]
    everyone = any(m.is_everyone and m.in_feed for m in mine)
    s = await deps.settings(db)
    q = (
        select(User, PorchProfile.birthday)
        .join(PorchProfile, PorchProfile.user_id == User.id)
        .where(
            PorchProfile.show_birthday.is_(True),
            PorchProfile.birthday.is_not(None),
            func.extract("month", PorchProfile.birthday) == today.month,
            User.id != user.id,
            deps.allowed_clause(s, User.id),
        )
    )
    if not everyone:
        if not custom:
            return []
        q = q.where(
            exists().where(
                PorchGroupMember.user_id == User.id,
                PorchGroupMember.status == "member",
                PorchGroupMember.group_id.in_(custom),
                PorchGroup.id == PorchGroupMember.group_id,
                PorchGroup.deleted_at.is_(None),
            )
        )
    hidden = await blocks.hidden_ids(db, user.id)
    out = []
    for u, b in (await db.execute(q.order_by(User.username))).all():
        if u.id in hidden or b is None or not _is_birthday(b, today):
            continue
        out.append({"user": core.user_out(u), "profile_url": f"/porch/u/{u.id}", "post_url": f"/porch/new?for={u.id}"})
    return out[:6]


async def today_section(db: AsyncSession, user: User, now: datetime, today: date) -> dict[str, Any] | None:
    """The Today card, or None when there's nothing to say."""
    if not await deps.allowed(db, user):
        return None
    new = await _new_posts(db, user, now)
    bdays = await _birthdays(db, user, today)
    if not new and not bdays:
        return None
    return {"url": "/porch", "new_posts": new, "birthdays": bdays}


__all__ = ["today_section"]
