"""Who can see what in Porch — the one definition (plan: "Who can see what").

A viewer sees a post when

* it isn't deleted,
* Porch is on for them (``deps.allowed`` — every route runs it first),
* neither has blocked the other, and
* they wrote it, or they're a current member of at least one of the
  post's live groups (everyone who may use Porch is in Everyone).

It's here twice, as :func:`visible_post` (SQLAlchemy, for listings) and
:func:`visible_post_sql` (raw SQL, for search and other apps), with
:func:`can_see_post` for one post. The feed narrows it to ticked groups and
never widens it.

Groups: a member sees everything; someone invited, or anyone for a public
group, sees only the outline (name, emoji, cover, about, admins, member
count); a private group is a 404 to everyone else, like one that doesn't
exist. A post's group labels are only the viewer's own groups, so a private
group you're not in is never named.

Every reader — feed, group and profile pages, the post itself, signed
photo links, and later search, Today, Rooms cards, push and export — goes
through here. Files' ``readable_predicate`` is deliberately *not* widened:
another person's Porch photo never shows in your Drive, search or "Shared
with me"; its bytes come only through ``porch_*`` media links.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import blocks

from . import core, deps
from .models import PorchGroup, PorchGroupMember, PorchPost, PorchPostGroup

MEMBER, INVITED, OUTLINE = "member", "invited", "outline"


# ------------------------------------------------------------------ posts


def member_groups(me: Any):  # noqa: ANN001, ANN201 — a subquery of group ids
    """Groups ``me`` is a current member of (Everyone's settings row aside)."""
    return select(PorchGroupMember.group_id).where(PorchGroupMember.user_id == me, PorchGroupMember.status == "member")


def visible_post(me: Any, post: Any = PorchPost):  # noqa: ANN001, ANN201 — SQL
    """SQL: ``me`` (a bound id) may see ``post`` (the entity or an alias).
    Assumes Porch is on for ``me`` (``require_porch`` ran)."""
    in_a_group = exists().where(
        PorchPostGroup.post_id == post.id,
        PorchGroup.id == PorchPostGroup.group_id,
        PorchGroup.deleted_at.is_(None),
        or_(PorchGroup.kind == "everyone", PorchGroup.id.in_(member_groups(me))),
    )
    return and_(
        post.deleted_at.is_(None),
        or_(post.author_id == me, in_a_group),
        not_(blocks.either_sql(me, post.author_id)),
    )


def visible_post_sql(alias: str = "p", param: str = "me") -> str:
    """The same rule as raw SQL over ``porch_posts AS <alias>``, the viewer
    bound as ``:<param>``."""
    return f"""(
        {alias}.deleted_at IS NULL
        AND ({alias}.author_id = :{param} OR EXISTS (
            SELECT 1 FROM porch_post_groups pg
            JOIN porch_groups g ON g.id = pg.group_id AND g.deleted_at IS NULL
            WHERE pg.post_id = {alias}.id
              AND (g.kind = 'everyone' OR EXISTS (
                  SELECT 1 FROM porch_group_members m
                  WHERE m.group_id = g.id AND m.user_id = :{param} AND m.status = 'member'))))
        AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = :{param} AND b.blocked_id = {alias}.author_id)
               OR (b.blocker_id = {alias}.author_id AND b.blocked_id = :{param}))
    )"""


async def can_see_post(db: AsyncSession, user: User, post: PorchPost | uuid.UUID) -> bool:
    """One post, the whole rule (Porch on for them included)."""
    post_id = post.id if isinstance(post, PorchPost) else post
    if not await deps.allowed(db, user):
        return False
    q = select(exists().where(PorchPost.id == post_id, visible_post(user.id)))
    return bool((await db.execute(q)).scalar())


async def load_post(db: AsyncSession, user: User, post_id: uuid.UUID) -> PorchPost:
    """The post if ``user`` may see it, else 404 (whatever the reason)."""
    row = (await db.execute(select(PorchPost).where(PorchPost.id == post_id, visible_post(user.id)))).scalar_one_or_none()
    if row is None:
        raise core.not_found()
    return row


# ------------------------------------------------------------------ groups


@dataclass
class Mine:
    """One of your groups, as you see it."""

    group: PorchGroup
    role: str
    in_feed: bool
    notify: str

    @property
    def is_everyone(self) -> bool:
        return self.group.kind == "everyone"

    @property
    def is_admin(self) -> bool:
        return self.role in ("owner", "admin")


async def my_groups(db: AsyncSession, user: User) -> list[Mine]:
    """Every group you're in, Everyone first (its row made if missing)."""
    ev = await core.everyone(db)
    # Your Everyone row only keeps your tick and bell (made by bootstrap);
    # without one, the defaults.
    ev_row = await membership(db, ev.id, user.id)
    out = [Mine(ev, "admin" if user.is_admin else "member", ev_row.in_feed if ev_row else True, ev_row.notify if ev_row else "none")]
    rows = (
        await db.execute(
            select(PorchGroup, PorchGroupMember)
            .join(PorchGroupMember, PorchGroupMember.group_id == PorchGroup.id)
            .where(
                PorchGroupMember.user_id == user.id,
                PorchGroupMember.status == "member",
                PorchGroup.deleted_at.is_(None),
                PorchGroup.kind == "custom",
            )
            .order_by(func.lower(PorchGroup.name))
        )
    ).all()
    out += [Mine(g, m.role, m.in_feed, m.notify) for g, m in rows]
    return out


async def my_group_ids(db: AsyncSession, user: User) -> list[uuid.UUID]:
    return [m.group.id for m in await my_groups(db, user)]


async def ticked_group_ids(db: AsyncSession, user: User) -> list[uuid.UUID]:
    """Your feed: the groups you're in and have ticked."""
    return [m.group.id for m in await my_groups(db, user) if m.in_feed]


async def membership(db: AsyncSession, group_id: uuid.UUID, user_id: uuid.UUID) -> PorchGroupMember | None:
    return await db.get(PorchGroupMember, (group_id, user_id))


def view_of(group: PorchGroup | None, m: PorchGroupMember | None) -> str | None:
    """How much of a group someone sees: member, invited (the outline and
    their invite), outline (public), or None (private and not theirs: 404)."""
    if group is None or group.deleted_at is not None:
        return None
    if group.kind == "everyone":
        return MEMBER
    if m is not None and m.status == "member":
        return MEMBER
    if m is not None and m.status == "invited":
        return INVITED
    if group.visibility == "public":
        return OUTLINE
    return None


async def can_see_group(db: AsyncSession, user: User, group: PorchGroup | uuid.UUID) -> str | None:
    """:func:`view_of` for one person (Porch on for them included)."""
    if not await deps.allowed(db, user):
        return None
    g = group if isinstance(group, PorchGroup) else await db.get(PorchGroup, group)
    if g is None:
        return None
    return view_of(g, await membership(db, g.id, user.id))


async def load_group(db: AsyncSession, user: User, group_id: uuid.UUID) -> tuple[PorchGroup, PorchGroupMember | None, str]:
    """The group, your row in it, and how much you see — or 404."""
    g = await db.get(PorchGroup, group_id)
    m = await membership(db, group_id, user.id) if g is not None else None
    view = view_of(g, m)
    if g is None or view is None:
        raise core.not_found("Group")
    return g, m, view


def is_admin(user: User, group: PorchGroup, m: PorchGroupMember | None) -> bool:
    """Admins look after a group; server admins are Everyone's admins."""
    if group.kind == "everyone":
        return user.is_admin
    return m is not None and m.status == "member" and m.role in ("owner", "admin")


def is_owner(group: PorchGroup, m: PorchGroupMember | None) -> bool:
    return group.kind == "custom" and m is not None and m.status == "member" and m.role == "owner"


# ------------------------------------------------------------------ audiences


async def group_member_ids(db: AsyncSession, group: PorchGroup) -> list[uuid.UUID]:
    """Everyone in a group (Everyone: everyone Porch is on for)."""
    if group.kind == "everyone":
        s = await deps.settings(db)
        q = select(User.id).where(deps.allowed_clause(s, User.id)).order_by(User.username)
        return list((await db.execute(q)).scalars().all())
    q = (
        select(PorchGroupMember.user_id)
        .where(PorchGroupMember.group_id == group.id, PorchGroupMember.status == "member")
        .order_by(PorchGroupMember.joined_at)
    )
    return list((await db.execute(q)).scalars().all())


async def member_count(db: AsyncSession, group: PorchGroup) -> int:
    if group.kind == "everyone":
        s = await deps.settings(db)
        return int((await db.execute(select(func.count()).select_from(User).where(deps.allowed_clause(s, User.id)))).scalar() or 0)
    q = select(func.count()).select_from(PorchGroupMember).where(PorchGroupMember.group_id == group.id, PorchGroupMember.status == "member")
    return int((await db.execute(q)).scalar() or 0)


async def member_counts(db: AsyncSession, groups: list[PorchGroup]) -> dict[uuid.UUID, int]:
    out: dict[uuid.UUID, int] = {}
    custom = [g.id for g in groups if g.kind == "custom"]
    if custom:
        q = (
            select(PorchGroupMember.group_id, func.count())
            .where(PorchGroupMember.group_id.in_(custom), PorchGroupMember.status == "member")
            .group_by(PorchGroupMember.group_id)
        )
        out.update({gid: int(n) for gid, n in (await db.execute(q)).all()})
    for g in groups:
        if g.kind == "everyone":
            out[g.id] = await member_count(db, g)
        out.setdefault(g.id, 0)
    return out


async def audience_ids(db: AsyncSession, post: PorchPost) -> set[uuid.UUID]:
    """Everyone who can see ``post`` right now: the author plus the members
    of its live groups who may use Porch, less anyone with a block either
    way with the author. (For pickers, push fan-out and live events.)"""
    gids = list((await db.execute(select(PorchPostGroup.group_id).where(PorchPostGroup.post_id == post.id))).scalars())
    groups = list((await db.execute(select(PorchGroup).where(PorchGroup.id.in_(gids), PorchGroup.deleted_at.is_(None)))).scalars()) if gids else []
    return await groups_audience(db, groups, author_id=post.author_id) if not post.deleted_at else set()


async def groups_audience(db: AsyncSession, groups: list[PorchGroup], *, author_id: uuid.UUID | None = None) -> set[uuid.UUID]:
    """Who'd see a post to these groups (the composer's mention picker)."""
    ids: set[uuid.UUID] = set()
    for g in groups:
        ids.update(await group_member_ids(db, g))
    if author_id is not None:
        s = await deps.settings(db)
        if ids:
            ok = select(User.id).where(User.id.in_(ids), deps.allowed_clause(s, User.id))
            ids = set((await db.execute(ok)).scalars())
        ids -= await blocks.hidden_ids(db, author_id)
        ids.add(author_id)
    return ids


async def labels(db: AsyncSession, user: User, post_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """Each post's groups that are also *your* groups (never a private group
    you're not in)."""
    if not post_ids:
        return {}
    mine = {m.group.id: m.group for m in await my_groups(db, user)}
    q = select(PorchPostGroup.post_id, PorchPostGroup.group_id).where(PorchPostGroup.post_id.in_(post_ids))
    out: dict[uuid.UUID, list[dict[str, Any]]] = {pid: [] for pid in post_ids}
    for pid, gid in (await db.execute(q)).all():
        g = mine.get(gid)
        if g is not None:
            out[pid].append(group_label(g))
    for pid in out:
        # Everyone last: the specific groups say more.
        out[pid].sort(key=lambda d: (d["kind"] == "everyone", d["name"].lower()))
    return out


def group_label(g: PorchGroup) -> dict[str, Any]:
    return {"id": str(g.id), "name": g.name, "emoji": g.emoji, "kind": g.kind, "visibility": g.visibility}


__all__ = [
    "INVITED", "MEMBER", "OUTLINE", "Mine", "audience_ids", "can_see_group", "can_see_post", "group_label", "group_member_ids",
    "groups_audience", "is_admin", "is_owner", "labels", "load_group", "load_post", "member_count", "member_counts",
    "member_groups", "membership", "my_group_ids", "my_groups", "ticked_group_ids", "view_of", "visible_post",
    "visible_post_sql",
]
