"""Groups: make, find, join, invite, roles, leave, hand on, delete.

* Anyone can make a group; they're its owner. The owner makes and removes
  admins, hands the group on, and deletes it. Admins edit it, invite, and
  remove members. A group always has an owner: the owner hands it on
  before leaving.
* **Public** groups are listed for everyone with Porch, who can join with
  one tap (no approval) — unless they were removed from it, then only by
  invite. **Private** groups are a 404 to anyone outside them.
* **Invites** need accepting (or declining). Admins invite; members too
  when the group's "Members can invite" is on.
* **Everyone** is built in: everyone with Porch is in it, nobody can leave
  it, nobody is invited to it, server admins are its admins (they can
  rename it), and it can't be deleted.
* Deleting a group: a post only in it stays visible to its author alone; a
  post also in other groups carries on there (``access.visible_post``
  ignores deleted groups).
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, core, deps, media, push
from .deps import require_porch
from .models import PorchGroup, PorchGroupMember

router = APIRouter()


# ------------------------------------------------------------------ JSON


async def groups_out(
    db: AsyncSession, viewer: User, items: list[tuple[PorchGroup, PorchGroupMember | None, str]],
) -> list[dict[str, Any]]:
    """Groups as ``viewer`` sees them (the outline for public groups they're
    not in, and for a pending invite)."""
    if not items:
        return []
    groups = [g for g, _, _ in items]
    counts = await access.member_counts(db, groups)
    covers = await media.cover_urls(db, viewer, groups)
    hidden = await blocks.hidden_ids(db, viewer.id)
    # Admins of the custom groups, in one go.
    custom = [g.id for g in groups if g.kind == "custom"]
    admins: dict[uuid.UUID, list[uuid.UUID]] = {}
    if custom:
        q = (
            select(PorchGroupMember.group_id, PorchGroupMember.user_id)
            .where(PorchGroupMember.group_id.in_(custom), PorchGroupMember.status == "member", PorchGroupMember.role.in_(("owner", "admin")))
            .order_by(PorchGroupMember.role.desc(), PorchGroupMember.joined_at)
        )
        for gid, uid in (await db.execute(q)).all():
            admins.setdefault(gid, []).append(uid)
    if any(g.kind == "everyone" for g in groups):
        s = await deps.settings(db)
        q = select(User.id).where(User.role == "admin", deps.allowed_clause(s, User.id)).order_by(User.username)
        server_admins = list((await db.execute(q)).scalars())
        for g in groups:
            if g.kind == "everyone":
                admins[g.id] = server_admins
    inviters = {m.invited_by for _, m, _ in items if m is not None and m.status == "invited" and m.invited_by}
    people = await core.users_map(db, {u for ids in admins.values() for u in ids} | inviters)
    out = []
    for g, m, view in items:
        is_admin = access.is_admin(viewer, g, m)
        member = view == access.MEMBER
        d: dict[str, Any] = {
            "id": str(g.id),
            "kind": g.kind,
            "name": g.name,
            "emoji": g.emoji,
            "about": g.about,
            "visibility": g.visibility,
            "cover_url": covers.get(g.id),
            "member_count": counts.get(g.id, 0),
            "admins": [people[str(u)] for u in admins.get(g.id, []) if u not in hidden and str(u) in people],
            "view": view,
            "members_can_invite": g.members_can_invite,
            "is_admin": is_admin,
            "is_owner": access.is_owner(g, m),
            "can_invite": g.kind == "custom" and member and (is_admin or g.members_can_invite),
            "created_at": g.created_at.isoformat() if g.created_at else None,
        }
        if member:
            d["in_feed"] = m.in_feed if m is not None else True
            d["notify"] = m.notify if m is not None else "none"
            d["role"] = ("admin" if viewer.is_admin else "member") if g.kind == "everyone" else (m.role if m else "member")
        if m is not None and m.status == "invited":
            d["invited_by"] = people.get(str(m.invited_by)) if m.invited_by and m.invited_by not in hidden else None
            d["invited_at"] = m.joined_at.isoformat() if m.joined_at else None
        out.append(d)
    return out


async def group_out(db: AsyncSession, viewer: User, g: PorchGroup, m: PorchGroupMember | None, view: str) -> dict[str, Any]:
    return (await groups_out(db, viewer, [(g, m, view)]))[0]


async def _event(db: AsyncSession, g: PorchGroup, extra: list[uuid.UUID] | None = None) -> None:
    """Tell the group's members (and anyone else concerned) it changed."""
    ids = [] if g.kind == "everyone" else await access.group_member_ids(db, g)
    await core.publish(ids + (extra or []), {"type": "group", "group_id": str(g.id)})


# ------------------------------------------------------------------ lists


@router.get("/groups")
async def my_groups(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Your groups (Everyone first) with your tick, bell and role, and the
    invites waiting for you."""
    mine = await access.my_groups(db, user)
    rows = {
        m.group_id: m
        for m in (
            await db.execute(select(PorchGroupMember).where(PorchGroupMember.user_id == user.id, PorchGroupMember.group_id.in_([x.group.id for x in mine])))
        ).scalars()
    }
    groups = await groups_out(db, user, [(x.group, rows.get(x.group.id), access.MEMBER) for x in mine])
    return {"groups": groups, "invites": await _invites(db, user)}


async def _invites(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    q = (
        select(PorchGroup, PorchGroupMember)
        .join(PorchGroupMember, PorchGroupMember.group_id == PorchGroup.id)
        .where(PorchGroupMember.user_id == user.id, PorchGroupMember.status == "invited", PorchGroup.deleted_at.is_(None), PorchGroup.kind == "custom")
        .order_by(PorchGroupMember.joined_at.desc())
    )
    hidden = await blocks.hidden_ids(db, user.id)
    # An invite from someone you've blocked (or who blocked you) waits unseen.
    items = [(g, m, access.INVITED) for g, m in (await db.execute(q)).all() if m.invited_by not in hidden]
    return await groups_out(db, user, items)


@router.get("/groups/discover")
async def discover(q: str = "", db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Public groups you're not in (nor invited to, nor removed from)."""
    mine = select(PorchGroupMember.group_id).where(PorchGroupMember.user_id == user.id)
    where = [PorchGroup.kind == "custom", PorchGroup.visibility == "public", PorchGroup.deleted_at.is_(None), PorchGroup.id.not_in(mine)]
    term = q.strip()
    if term:
        esc = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append(PorchGroup.name.ilike(f"%{esc}%", escape="\\") | PorchGroup.about.ilike(f"%{esc}%", escape="\\"))
    rows = (await db.execute(select(PorchGroup).where(*where).order_by(func.lower(PorchGroup.name)).limit(200))).scalars().all()
    return await groups_out(db, user, [(g, None, access.OUTLINE) for g in rows])


# ------------------------------------------------------------------ make / change / delete


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    visibility: Literal["public", "private"] = "private"  # decision D6
    emoji: str = Field(default="", max_length=16)
    about: str = Field(default="", max_length=500)
    members_can_invite: bool = False
    invite: list[uuid.UUID] = Field(default_factory=list, max_length=200)


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    visibility: Literal["public", "private"] | None = None
    emoji: str | None = Field(default=None, max_length=16)
    about: str | None = Field(default=None, max_length=500)
    members_can_invite: bool | None = None
    cover_file_id: uuid.UUID | None = None


@router.post("/groups", status_code=201)
async def create_group(body: GroupIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    name = body.name.strip()
    if not name:
        raise core.bad("Give the group a name")
    g = PorchGroup(
        kind="custom", visibility=body.visibility, name=name, emoji=body.emoji.strip(), about=body.about.strip(),
        members_can_invite=body.members_can_invite, created_by=user.id,
    )
    db.add(g)
    await db.flush()
    me = PorchGroupMember(group_id=g.id, user_id=user.id, role="owner", status="member", in_feed=True, joined_at=core.now())
    db.add(me)
    invited = await _invite(db, user, g, body.invite)
    await db.commit()
    await core.publish(invited, {"type": "invite", "group_id": str(g.id)})
    await push.invited(db, user, g, invited)
    out = await group_out(db, user, g, me, access.MEMBER)
    out["invited"] = [str(u) for u in invited]
    return out


@router.get("/groups/{group_id}")
async def get_group(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    g, m, view = await access.load_group(db, user, group_id)
    return await group_out(db, user, g, m, view)


@router.patch("/groups/{group_id}")
async def update_group(group_id: uuid.UUID, body: GroupPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    g, m, view = await access.load_group(db, user, group_id)
    if not access.is_admin(user, g, m):
        raise core.forbidden("Only the group's admins can change it")
    changes = body.model_dump(exclude_unset=True)
    if g.kind == "everyone" and ({"visibility", "members_can_invite"} & {k for k, v in changes.items() if v is not None}):
        raise core.bad("Everyone is always open to everyone on this Promptly")
    for k in ("name", "emoji", "about"):
        v = changes.get(k)
        if v is not None:
            v = v.strip()
            if k == "name" and not v:
                raise core.bad("Give the group a name")
            setattr(g, k, v)
    if changes.get("visibility") is not None:
        g.visibility = changes["visibility"]
    if changes.get("members_can_invite") is not None:
        g.members_can_invite = bool(changes["members_can_invite"])
    if "cover_file_id" in changes:
        fid = changes["cover_file_id"]
        if fid is None:
            g.cover_file_id = None
        else:
            found = await media.check_files(db, user, [fid])
            row, fm = found[fid]
            if media.is_video(row, fm):
                raise core.bad("A cover has to be a photo")
            g.cover_file_id = fid
    await db.commit()
    await _event(db, g)
    return await group_out(db, user, g, m, view)


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    g, m, _ = await access.load_group(db, user, group_id)
    if g.kind == "everyone":
        raise core.bad("Everyone can't be deleted")
    if not access.is_owner(g, m):
        raise core.forbidden("Only the group's owner can delete it")
    members = await access.group_member_ids(db, g)
    g.deleted_at = core.now()
    await db.commit()
    await core.publish(members, {"type": "group", "group_id": str(g.id)})


class TransferIn(BaseModel):
    user_id: uuid.UUID


@router.post("/groups/{group_id}/transfer")
async def transfer(group_id: uuid.UUID, body: TransferIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Hand the group on: they become the owner, you an admin."""
    g, m, view = await access.load_group(db, user, group_id)
    if not access.is_owner(g, m):
        raise core.forbidden("Only the group's owner can hand it on")
    target = await access.membership(db, g.id, body.user_id)
    if body.user_id == user.id or target is None or target.status != "member" or await blocks.either(db, user.id, body.user_id):
        raise core.bad("Pick someone in the group")
    target.role = "owner"
    m.role = "admin"  # type: ignore[union-attr]
    await db.commit()
    await _event(db, g)
    return await group_out(db, user, g, m, view)


# ------------------------------------------------------------------ members


@router.get("/groups/{group_id}/members")
async def members(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Who's in it (members only; blocked people left out both ways)."""
    g, m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Join the group to see who's in it")
    hidden = await blocks.hidden_ids(db, user.id)
    if g.kind == "everyone":
        ids = [u for u in await access.group_member_ids(db, g) if u not in hidden]
        people = await core.users_map(db, ids)
        admins = set((await db.execute(select(User.id).where(User.id.in_(ids), User.role == "admin"))).scalars()) if ids else set()
        return [{**people[str(u)], "role": "admin" if u in admins else "member", "joined_at": None} for u in ids if str(u) in people]
    rows = (
        await db.execute(
            select(PorchGroupMember)
            .where(PorchGroupMember.group_id == g.id, PorchGroupMember.status == "member")
            .order_by(PorchGroupMember.joined_at)
        )
    ).scalars().all()
    rows = [r for r in rows if r.user_id not in hidden]
    people = await core.users_map(db, [r.user_id for r in rows])
    order = {"owner": 0, "admin": 1, "member": 2}
    rows.sort(key=lambda r: (order.get(r.role, 3), r.joined_at))
    return [
        {**people[str(r.user_id)], "role": r.role, "joined_at": r.joined_at.isoformat() if r.joined_at else None}
        for r in rows if str(r.user_id) in people
    ]


class RoleIn(BaseModel):
    role: Literal["admin", "member"]


@router.patch("/groups/{group_id}/members/{user_id}")
async def set_role(group_id: uuid.UUID, user_id: uuid.UUID, body: RoleIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Make someone an admin, or not (the owner only)."""
    g, m, _ = await access.load_group(db, user, group_id)
    if not access.is_owner(g, m):
        raise core.forbidden("Only the group's owner can change who's an admin")
    target = await access.membership(db, g.id, user_id)
    if target is None or target.status != "member" or user_id == user.id:
        raise core.not_found("Member")
    target.role = body.role
    await db.commit()
    await _event(db, g)
    return {"user_id": str(user_id), "role": target.role}


@router.delete("/groups/{group_id}/members/{user_id}", status_code=204)
async def remove_member(group_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    """Leave (yourself), or remove someone (admins). Someone removed from a
    public group can come back only by invite. Their posts stay."""
    g, m, view = await access.load_group(db, user, group_id)
    if g.kind == "everyone":
        raise core.bad("Nobody can leave Everyone. Untick it to hide it from your feed.")
    if user_id == user.id:
        if view != access.MEMBER or m is None:
            raise core.not_found("Member")
        if m.role == "owner":
            alone = await access.member_count(db, g) <= 1
            raise core.bad(f"You're the only one in {g.name}. Delete the group instead." if alone else "Make someone else the owner before you leave")
        await db.delete(m)
        await db.commit()
        await _event(db, g, [user.id])
        return
    if not access.is_admin(user, g, m):
        raise core.forbidden("Only the group's admins can remove people")
    target = await access.membership(db, g.id, user_id)
    if target is None or target.status != "member":
        raise core.not_found("Member")
    if target.role == "owner" or (target.role == "admin" and not access.is_owner(g, m)):
        raise core.forbidden("Only the owner can remove an admin" if target.role == "admin" else "The owner can't be removed")
    target.status = "removed"
    target.role = "member"
    target.in_feed = False
    target.notify = "none"
    await db.commit()
    await _event(db, g, [user_id])


class MeIn(BaseModel):
    in_feed: bool | None = None
    notify: Literal["all", "none"] | None = None


@router.patch("/groups/{group_id}/me")
async def set_mine(group_id: uuid.UUID, body: MeIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Your tick (in your feed or not) and bell for one group."""
    g, m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.not_found("Group")
    if g.kind == "everyone":
        m = await core.everyone_settings(db, g, user.id)
    assert m is not None
    if body.in_feed is not None:
        m.in_feed = body.in_feed
    if body.notify is not None:
        m.notify = body.notify
    await db.commit()
    return {"group_id": str(g.id), "in_feed": m.in_feed, "notify": m.notify}


# ------------------------------------------------------------------ invites and joining


class InviteIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


async def _invite(db: AsyncSession, inviter: User, g: PorchGroup, user_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Invite people (skipping anyone in it or invited already, anyone
    Porch isn't on for, and anyone with a block either way). Someone
    removed before can be invited back. Flushed, not committed."""
    want = [u for u in dict.fromkeys(user_ids) if u != inviter.id]
    if not want:
        return []
    s = await deps.settings(db)
    ok = set((await db.execute(select(User.id).where(User.id.in_(want), deps.allowed_clause(s, User.id)))).scalars())
    ok -= await blocks.hidden_ids(db, inviter.id)
    rows = {r.user_id: r for r in (await db.execute(select(PorchGroupMember).where(PorchGroupMember.group_id == g.id, PorchGroupMember.user_id.in_(ok)))).scalars()} if ok else {}
    out = []
    for uid in want:
        if uid not in ok:
            continue
        row = rows.get(uid)
        if row is not None and row.status in ("member", "invited"):
            continue
        if row is None:
            db.add(PorchGroupMember(group_id=g.id, user_id=uid, role="member", status="invited", invited_by=inviter.id, in_feed=True, joined_at=core.now()))
        else:
            row.status, row.role, row.invited_by, row.joined_at, row.in_feed = "invited", "member", inviter.id, core.now(), True
        out.append(uid)
    await db.flush()
    return out


@router.post("/groups/{group_id}/invites")
async def invite(group_id: uuid.UUID, body: InviteIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    g, m, view = await access.load_group(db, user, group_id)
    if g.kind == "everyone":
        raise core.bad("Everyone on this Promptly is in Everyone already")
    if view != access.MEMBER or not (access.is_admin(user, g, m) or g.members_can_invite):
        raise core.forbidden("Only the group's admins can invite people")
    invited = await _invite(db, user, g, body.user_ids)
    await db.commit()
    await core.publish(invited, {"type": "invite", "group_id": str(g.id)})
    await push.invited(db, user, g, invited)
    return {"invited": [str(u) for u in invited]}


@router.get("/groups/{group_id}/invites")
async def pending_invites(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """Invites waiting for an answer (admins)."""
    g, m, _ = await access.load_group(db, user, group_id)
    if not access.is_admin(user, g, m) or g.kind == "everyone":
        raise core.forbidden("Only the group's admins can see its invites")
    rows = (
        await db.execute(
            select(PorchGroupMember)
            .where(PorchGroupMember.group_id == g.id, PorchGroupMember.status == "invited")
            .order_by(PorchGroupMember.joined_at.desc())
        )
    ).scalars().all()
    hidden = await blocks.hidden_ids(db, user.id)
    rows = [r for r in rows if r.user_id not in hidden]
    people = await core.users_map(db, [r.user_id for r in rows] + [r.invited_by for r in rows])
    return [
        {
            "user": people.get(str(r.user_id)),
            "invited_by": people.get(str(r.invited_by)) if r.invited_by else None,
            "invited_at": r.joined_at.isoformat() if r.joined_at else None,
        }
        for r in rows if str(r.user_id) in people
    ]


@router.delete("/groups/{group_id}/invites/{user_id}", status_code=204)
async def cancel_invite(group_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    g, m, _ = await access.load_group(db, user, group_id)
    if not access.is_admin(user, g, m):
        raise core.forbidden("Only the group's admins can cancel invites")
    row = await access.membership(db, g.id, user_id)
    if row is None or row.status != "invited":
        raise core.not_found("Invite")
    await db.delete(row)
    await db.commit()
    await core.publish([user_id], {"type": "invite", "group_id": str(g.id)})


async def _become_member(db: AsyncSession, row: PorchGroupMember) -> None:
    row.status, row.role, row.in_feed, row.joined_at = "member", "member", True, core.now()


@router.post("/groups/{group_id}/accept")
async def accept(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Say yes to an invite: you're in, and it's ticked in your feed."""
    g, m, _ = await access.load_group(db, user, group_id)
    if m is None or m.status != "invited":
        raise core.not_found("Invite")
    await _become_member(db, m)
    await db.commit()
    await _event(db, g)
    return await group_out(db, user, g, m, access.MEMBER)


@router.post("/groups/{group_id}/decline", status_code=204)
async def decline(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> None:
    g, m, _ = await access.load_group(db, user, group_id)
    if m is None or m.status != "invited":
        raise core.not_found("Invite")
    await db.delete(m)
    await db.commit()


@router.post("/groups/{group_id}/join")
async def join(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Join a public group at once (ticked in your feed). Someone removed
    from it needs an invite; a private group is a 404 from outside."""
    g, m, view = await access.load_group(db, user, group_id)
    if g.kind == "everyone" or view == access.MEMBER:
        return await group_out(db, user, g, m, access.MEMBER)
    if view == access.INVITED:
        assert m is not None
        await _become_member(db, m)
    elif m is not None and m.status == "removed":
        raise core.forbidden("You were removed from this group. Ask one of its admins to invite you back.")
    else:
        m = PorchGroupMember(group_id=g.id, user_id=user.id, role="member", status="member", in_feed=True, joined_at=core.now())
        db.add(m)
    await db.commit()
    await _event(db, g)
    return await group_out(db, user, g, m, access.MEMBER)


__all__ = ["group_out", "groups_out", "router"]
