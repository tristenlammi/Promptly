"""Porch API, mounted at ``/api/porch``. See ``docs/porch-plan.md`` and
``docs/porch-build.md``. Every route depends on ``require_porch``: for
someone Porch isn't on for, all of it is a 404.

Here: first open (``/bootstrap``), the people picker, profiles and "seen"
marks. Groups are in :mod:`app.porch.groups`, posts and the feed in
:mod:`app.porch.posts`, photo links in :mod:`app.porch.media`; the
hand-offs to Rooms, Calendar and Photos in :mod:`app.porch.handoffs`, search
in :mod:`app.porch.search` (Today: :mod:`app.porch.today`, export:
:mod:`app.porch.export`).
"""
from __future__ import annotations

import uuid
from datetime import date as Date, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, activity, compose, core, deps, events, groups, handoffs, media, posts, prefs, reports, search, stories, tags, talk
from .deps import require_porch
from .models import PorchGroup, PorchGroupMember, PorchProfile

router = APIRouter()
router.include_router(groups.router)
router.include_router(posts.router)
router.include_router(events.router)
router.include_router(compose.router)
router.include_router(talk.router)
router.include_router(tags.router)
router.include_router(activity.router)
router.include_router(handoffs.router)
router.include_router(search.router)
router.include_router(prefs.router)
router.include_router(reports.router)
router.include_router(stories.router)


def _profile_out(p: PorchProfile, *, me: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "bio": p.bio,
        "birthday": p.birthday.isoformat() if p.birthday and (me or p.show_birthday) else None,
    }
    if me:
        out.update(
            show_birthday=p.show_birthday,
            face_suggestions=p.face_suggestions,
            feed_seen_at=p.feed_seen_at.isoformat() if p.feed_seen_at else None,
            activity_seen_at=p.activity_seen_at.isoformat() if p.activity_seen_at else None,
            welcomed=p.welcomed_at is not None,
            last_groups=p.last_groups,
        )
    return out


@router.get("/available")
async def available(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Is Porch on for you? (The Apps tile asks; it never 404s.)"""
    return {"available": await deps.allowed(db, user)}


@router.get("/bootstrap")
async def bootstrap(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """First thing the app asks: you, your profile, your groups (Everyone
    first) and invites, and Porch's limits. Makes your profile and your
    Everyone settings on first open."""
    prof = await core.profile(db, user.id)
    ev = await core.everyone(db)
    await core.everyone_settings(db, ev, user.id)
    await db.commit()
    mine = await groups.my_groups(db, user)
    s = await deps.settings(db)
    return {
        "me": {**core.user_out(user), "is_admin": user.is_admin},
        "profile": _profile_out(prof, me=True),
        "groups": mine["groups"],
        "invites": mine["invites"],
        "everyone": {"id": str(ev.id), "name": ev.name, "emoji": ev.emoji, "member_count": await access.member_count(db, ev)},
        # The Activity tab's badge: new since you last looked, plus invites
        # and tag requests waiting for an answer.
        "activity_unseen": await activity.unseen_count(db, user),
        "limits": {
            "max_media": media.MAX_MEDIA,
            "video_max_seconds": s.porch_video_max_seconds if s is not None else 300,
            "video_max_mb": s.porch_video_max_mb if s is not None else 1024,
            "story_video_max_seconds": stories.VIDEO_MAX_SECONDS,
        },
    }


# ------------------------------------------------------------------ people


@router.get("/people")
async def people(
    q: str = "",
    groups_: list[uuid.UUID] = Query(default_factory=list, alias="groups"),
    post: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_porch),
) -> list[dict]:
    """The people picker: people with Porch (not you, nobody with a block
    either way). With ``groups`` (yours) or ``post`` (one you can see), only
    the people who'd see it — the mention and tag picker. Otherwise type 2+
    letters."""
    term = q.strip()
    narrowed: set[uuid.UUID] | None = None
    if post is not None:
        p = await access.load_post(db, user, post)
        narrowed = await access.audience_ids(db, p)
    elif groups_:
        mine = {m.group.id: m.group for m in await access.my_groups(db, user)}
        if set(groups_) - set(mine):
            raise core.not_found("Group")
        narrowed = await access.groups_audience(db, [mine[g] for g in dict.fromkeys(groups_)], author_id=user.id)
    elif len(term) < 2:
        return []
    s = await deps.settings(db)
    where = [User.id != user.id, deps.allowed_clause(s, User.id)]
    hidden = await blocks.hidden_ids(db, user.id)
    if hidden:
        where.append(User.id.not_in(hidden))
    if narrowed is not None:
        if not narrowed:
            return []
        where.append(User.id.in_(narrowed))
    if term:
        esc = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append(or_(User.username.ilike(f"%{esc}%", escape="\\"), User.settings["display_name"].astext.ilike(f"%{esc}%", escape="\\")))
    rows = (await db.execute(select(User).where(*where).order_by(User.username).limit(50))).scalars().all()
    return [core.user_out(u) for u in rows]


# ------------------------------------------------------------------ profiles


@router.get("/users/{user_id}")
async def profile(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Someone's Porch profile as you see it: bio, birthday if they show it,
    and the groups you're both in (never one you're not in)."""
    other = await posts._person(db, user, user_id)
    prof = await db.get(PorchProfile, other.id)
    me = other.id == user.id
    out: dict[str, Any] = {
        "user": core.user_out(other),
        "is_me": me,
        **(_profile_out(prof, me=me) if prof is not None else {"bio": "", "birthday": None}),
    }
    if not me:
        out["relation"] = await _relation(db, user, other)
        out["alert"] = await prefs.has_alert(db, user, other.id)
        theirs = select(PorchGroupMember.group_id).where(PorchGroupMember.user_id == other.id, PorchGroupMember.status == "member")
        shared = (
            await db.execute(
                select(PorchGroup)
                .join(PorchGroupMember, PorchGroupMember.group_id == PorchGroup.id)
                .where(
                    PorchGroupMember.user_id == user.id, PorchGroupMember.status == "member", PorchGroup.kind == "custom",
                    PorchGroup.deleted_at.is_(None), PorchGroup.id.in_(theirs),
                )
                .order_by(PorchGroup.name)
            )
        ).scalars().all()
        out["shared_groups"] = [access.group_label(g) for g in shared]
    return out


async def _relation(db: AsyncSession, viewer: User, other: User) -> dict[str, Any] | None:
    """What they are to you ("Sam, your brother"), from your own Contacts
    and Photos people. Only ever shown to you."""
    from app.people.directory import Person, complete

    try:
        p = await complete(db, viewer, Person(user=other))
    except Exception:  # noqa: BLE001 — a nicety; never fail the profile
        core.logger.warning("porch relation lookup failed", exc_info=True)
        return None
    if not p.label and p.contact is None and p.person_id is None:
        return None
    return {"name": p.name, "label": p.label}


@router.get("/people/suggested")
async def suggested_people(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """People you know (your Contacts and Photos people, matched to accounts
    here) who have Porch: the first run's "Make a Family group?" card.
    Only your own directory is read; nobody is ticked for you."""
    from app.people.directory import directory

    try:
        people_ = await directory(db, user)
    except Exception:  # noqa: BLE001
        core.logger.warning("porch suggestions failed", exc_info=True)
        return []
    hidden = await blocks.hidden_ids(db, user.id)
    seen: set[uuid.UUID] = set()
    out: list[dict[str, Any]] = []
    for p in people_:
        u = p.user
        if u is None or u.id == user.id or u.id in seen or u.id in hidden or u.disabled:
            continue
        if not await deps.allowed(db, u):
            continue
        seen.add(u.id)
        out.append({"user": core.user_out(u), "label": p.label, "name": p.name})
    # The people with a relationship first ("Wife", "Mum"), then by name.
    out.sort(key=lambda d: (d["label"] is None, d["name"].lower()))
    return out[:24]


class ProfilePatch(BaseModel):
    bio: str | None = Field(default=None, max_length=300)
    birthday: Date | None = None
    show_birthday: bool | None = None
    face_suggestions: bool | None = None
    welcomed: bool | None = None


@router.get("/me/profile")
async def my_profile(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    prof = await core.profile(db, user.id)
    await db.commit()
    return _profile_out(prof, me=True)


@router.patch("/me/profile")
async def update_profile(body: ProfilePatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    prof = await core.profile(db, user.id)
    sent = body.model_fields_set
    if body.bio is not None:
        prof.bio = body.bio.strip()
    if "birthday" in sent:
        prof.birthday = body.birthday
    if body.show_birthday is not None:
        prof.show_birthday = body.show_birthday
    if body.face_suggestions is not None:
        prof.face_suggestions = body.face_suggestions
    if body.welcomed:
        prof.welcomed_at = prof.welcomed_at or core.now()
    await db.commit()
    return _profile_out(prof, me=True)


class SeenIn(BaseModel):
    at: datetime | None = None


@router.post("/feed/seen")
async def feed_seen(body: SeenIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """You've had the top of your feed on screen: "You're all caught up"
    moves to here (never backwards, never into the future)."""
    prof = await core.profile(db, user.id)
    now = core.now()
    at = body.at or now
    if at.tzinfo is None:
        at = at.replace(tzinfo=now.tzinfo)
    at = min(at, now)
    if prof.feed_seen_at is None or at > prof.feed_seen_at:
        prof.feed_seen_at = at
    await db.commit()
    return {"feed_seen_at": prof.feed_seen_at.isoformat() if prof.feed_seen_at else None}


__all__ = ["router"]
