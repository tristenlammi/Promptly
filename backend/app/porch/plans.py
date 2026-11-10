"""Group events (WP-P3.2; decisions E1, E2): an event in Calendar attached
to a Porch post, with a card that anyone who can see the post can answer.

* **Plan an event in a group** (``POST /groups/{id}/events``): the
  Calendar's own event (``calendars/service.create_event``) and a post in
  that group carrying it. "Invite everyone in Family" is on by default for
  your own groups and off for Everyone (E1); either way anyone in the group
  can answer from the card. No group calendars (E2).
* **"Make this an event"** on your own post (phase 1) now attaches the event
  to the post too (:func:`attach`), so it gets the card.
* **The card** (``post["event"]`` in every post list): date, time, place,
  who's going, Going · Maybe · Can't go, read live from the event. Answering
  makes you a guest: :func:`event_post_for` is the third way into an event
  next to Calendar membership and Rooms cards (``calendars/core
  .shared_with_me`` and ``service.rsvp``), only while you can see the post.
* **Events tab** (``GET /groups/{id}/events``): upcoming first, then past.
* Deleting the event leaves the post with "Cancelled: Family BBQ"
  (``event_title``); deleting the post can cancel the event too
  (``DELETE /posts/{id}?cancel_event=true``, the organiser only).
* Calendar's invite push covers the invitees, so the Porch new-post push
  skips them: nobody is told twice.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import access, activity, core
from .deps import require_porch
from .models import PorchPost, PorchPostGroup

router = APIRouter()

KIND = "porch_post"


class PlanIn(BaseModel):
    """The Calendar event (as the event editor sends it), plus whether to
    invite the whole group and a few words for the post."""

    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    location: str = Field(default="", max_length=300)
    all_day: bool = False
    start: str = Field(min_length=1, max_length=40)
    end: str | None = Field(default=None, max_length=40)
    tz: str | None = Field(default=None, max_length=64)
    calendar_id: uuid.UUID | None = None
    repeat: dict[str, Any] | None = None
    reminders: list[int] | None = Field(default=None, max_length=5)
    invite_all: bool | None = None
    body: str = Field(default="", max_length=5000)


# ------------------------------------------------------------------ the card


async def cards(db: AsyncSession, viewer: User, posts: list[PorchPost]) -> dict[uuid.UUID, dict[str, Any] | None]:
    """Each post's event as ``viewer`` sees it on the card (callers pass only
    posts ``viewer`` can see): when, where, who's going (names only of people
    without a block either way), your answer — or ``cancelled`` when the
    event's gone."""
    from app.calendars import core as cal_core
    from app.calendars.models import CalAttendee, CalEvent

    out: dict[uuid.UUID, dict[str, Any] | None] = {p.id: None for p in posts}
    with_event = [p for p in posts if p.event_id or p.event_title]
    if not with_event:
        return out
    ids = [p.event_id for p in with_event if p.event_id]
    events = {e.id: e for e in (await db.execute(select(CalEvent).where(CalEvent.id.in_(ids)))).scalars()} if ids else {}
    atts = await cal_core.attendees_of(db, list(events))
    hidden = await blocks.hidden_ids(db, viewer.id)
    people = await core.users_map(db, {a.user_id for v in atts.values() for a in v} | {e.created_by for e in events.values() if e.created_by})
    now = core.now()
    for p in with_event:
        ev = events.get(p.event_id) if p.event_id else None
        if ev is None:
            out[p.id] = {"cancelled": True, "title": p.event_title or "An event"}
            continue
        nxt = _next(ev, now)
        rows = atts.get(ev.id, [])
        going_ids = [a.user_id for a in rows if a.status == "going" and a.user_id not in hidden]
        if ev.created_by and ev.created_by not in hidden and ev.created_by not in going_ids:
            mine_answer = next((a for a in rows if a.user_id == ev.created_by), None)
            if mine_answer is None or mine_answer.status not in ("maybe", "declined"):
                going_ids.insert(0, ev.created_by)
        mine = next((a for a in rows if a.user_id == viewer.id), None)
        my_status = "going" if ev.created_by == viewer.id and mine is None else (mine.status if mine and mine.status != "invited" else None)
        out[p.id] = {
            "cancelled": False,
            "event_id": str(ev.id),
            "title": ev.title,
            "start": nxt["start"],
            "end": nxt["end"],
            "all_day": ev.all_day,
            "repeats": bool(ev.repeat),
            "location": ev.location,
            "going": [people[str(u)] for u in going_ids if str(u) in people][:6],
            "going_count": len(going_ids),
            "maybe_count": sum(1 for a in rows if a.status == "maybe" and a.user_id not in hidden),
            "my_status": my_status,
            "invited": mine is not None and mine.status == "invited",
            "organiser": ev.created_by == viewer.id,
            "past": nxt["past"],
        }
    return out


def _next(ev: Any, now: datetime) -> dict[str, Any]:
    """The next occurrence (or the last one, once it's over)."""
    from app.calendars import core as cal_core
    from app.calendars import recur

    upcoming = recur.occurrences(
        start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
        exdates=ev.exdates, range_start=now, range_end=now + timedelta(days=400),
    )[:1]
    if upcoming:
        s, e = upcoming[0]
        return {"start": cal_core.iso(s, ev.all_day), "end": cal_core.end_iso(e, ev.all_day), "past": False}
    return {"start": cal_core.iso(ev.start_at, ev.all_day), "end": cal_core.end_iso(ev.end_at, ev.all_day), "past": True}


# ------------------------------------------------------------------ Calendar's third way in


async def event_post_for(db: AsyncSession, event_id: uuid.UUID, user: User) -> PorchPost | None:
    """A live Porch post carrying this event that ``user`` can see now (the
    way into the event for people who aren't on its calendar or invited)."""
    from . import deps

    if not await deps.allowed(db, user):
        return None
    q = select(PorchPost).where(PorchPost.event_id == event_id, access.visible_post(user.id)).order_by(PorchPost.created_at).limit(1)
    return (await db.execute(q)).scalar_one_or_none()


async def attach(db: AsyncSession, user: User, post_id: uuid.UUID, ev: Any) -> bool:
    """"Make this an event" on your own post: the post carries it (its card),
    if it doesn't carry one already. Someone else's post stays as it is —
    the event is just yours. Flushed, not committed."""
    post = await db.get(PorchPost, post_id)
    if post is None or post.deleted_at is not None or post.author_id != user.id or post.event_id is not None:
        return False
    post.event_id = ev.id
    post.event_title = ev.title
    await db.flush()
    return True


async def renamed(db: AsyncSession, ev: Any) -> None:
    """The event's title changed: its posts keep the new one (for "Cancelled: …")."""
    rows = (await db.execute(select(PorchPost).where(PorchPost.event_id == ev.id))).scalars()
    for p in rows:
        p.event_title = ev.title


async def post_audiences(db: AsyncSession, event_id: uuid.UUID) -> set[uuid.UUID]:
    """Everyone who sees a post carrying this event (to refresh their cards)."""
    out: set[uuid.UUID] = set()
    for p in (await db.execute(select(PorchPost).where(PorchPost.event_id == event_id, PorchPost.deleted_at.is_(None)))).scalars():
        out |= await access.audience_ids(db, p)
    return out


async def post_ids(db: AsyncSession, event_id: uuid.UUID) -> list[uuid.UUID]:
    return list((await db.execute(select(PorchPost.id).where(PorchPost.event_id == event_id))).scalars())


async def tell(post_ids_: list[uuid.UUID], who: set[uuid.UUID]) -> None:
    """Cards on screen refresh (ids only; the client refetches, checked)."""
    for pid in post_ids_:
        await core.publish(who, {"type": "post_change", "post_id": str(pid)})


async def changed(db: AsyncSession, event_id: uuid.UUID) -> None:
    """After an answer or a change: the cards on screen refresh."""
    try:
        ids = await post_ids(db, event_id)
        if ids:
            await tell(ids, await post_audiences(db, event_id))
    except Exception:  # noqa: BLE001 — a live nudge never breaks the answer
        core.logger.debug("porch event refresh failed", exc_info=True)


# ------------------------------------------------------------------ plan an event in a group


@router.post("/groups/{group_id}/events", status_code=201)
async def plan(group_id: uuid.UUID, body: PlanIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Plan an event in a group: it goes in your calendar, everyone in the
    group is invited (unless you untick it; Everyone: unticked by default),
    and a post in the group carries its card."""
    from app.calendars import service as cal_service
    from app.calendars.router import get_event

    from .posts import post_out

    g, _m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Join the group to plan something in it")
    invite_all = body.invite_all if body.invite_all is not None else g.kind != "everyone"
    guests: list[uuid.UUID] = []
    if invite_all:
        hidden = await blocks.hidden_ids(db, user.id)
        allowed = await access.groups_audience(db, [g], author_id=user.id)
        guests = [u for u in await access.group_member_ids(db, g) if u != user.id and u not in hidden and u in allowed]
        if len(guests) > cal_service.MAX_GUESTS:
            raise core.bad(f"Inviting everyone works for groups of up to {cal_service.MAX_GUESTS}. Untick it: people can still answer from the post.")
    post = PorchPost(author_id=user.id, kind="text", body=body.body.strip())
    db.add(post)
    await db.flush()
    db.add(PorchPostGroup(post_id=post.id, group_id=g.id))
    f = cal_service.EventFields(
        title=body.title, description=body.description, location=body.location, all_day=body.all_day, start=body.start, end=body.end,
        tz=body.tz, calendar_id=body.calendar_id, repeat=body.repeat, repeat_set=True, reminders=body.reminders, guests=guests,
        guests_can_edit=False,
    )
    ev = await cal_service.create_event(db, user, f, ping_guests=True)
    ev.source = {"kind": KIND, "post_id": str(post.id)}
    post.event_id = ev.id
    post.event_title = ev.title
    prof = await core.profile(db, user.id)
    prof.last_groups = [str(g.id)]
    await db.commit()
    await db.refresh(post)
    await core.publish(await access.audience_ids(db, post), {"type": "post", "post_id": str(post.id)})
    # Calendar's invite told the invitees: the post's own pushes skip them.
    await activity.after_post(db, post, [], [], created=True, skip=set(guests))
    out = await get_event(ev.id, db, user)
    return {**out, "post": await post_out(db, user, post)}


# ------------------------------------------------------------------ a group's Events tab


@router.get("/groups/{group_id}/events")
async def group_events(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """The group's events you can see: upcoming first (soonest first), then
    past ones (latest first). Each is the post with its card."""
    from .posts import posts_out

    g, _m, view = await access.load_group(db, user, group_id)
    if view != access.MEMBER:
        raise core.forbidden("Posts show once you join")
    in_group = exists().where(PorchPostGroup.post_id == PorchPost.id, PorchPostGroup.group_id == g.id)
    q = (
        select(PorchPost)
        .where(in_group, access.visible_post(user.id), or_(PorchPost.event_id.is_not(None), PorchPost.event_title.is_not(None)))
        .order_by(PorchPost.created_at.desc())
        .limit(200)
    )
    posts = await posts_out(db, user, list((await db.execute(q)).scalars()))
    live = [p for p in posts if p["event"] and not p["event"]["cancelled"]]
    upcoming = sorted((p for p in live if not p["event"]["past"]), key=lambda p: p["event"]["start"])
    past = sorted((p for p in live if p["event"]["past"]), key=lambda p: p["event"]["start"], reverse=True)
    cancelled = [p for p in posts if p["event"] and p["event"]["cancelled"]]
    return {"upcoming": upcoming, "past": past + cancelled}


__all__ = ["KIND", "attach", "cards", "changed", "event_post_for", "renamed", "router"]
