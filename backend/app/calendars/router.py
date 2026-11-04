"""Calendar API, mounted at ``/api/calendar``. See ``docs/calendar-plan.md``."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import core, extras, ics, lookup, notify, service, sharing
from .models import CalAttendee, CalCalendar, CalEvent, CalEventRoom, CalFeed, CalMember

router = APIRouter()

_HEX = r"^#[0-9a-fA-F]{6}$"
UTC = timezone.utc


# ================================================================== bootstrap


async def _calendars_out(db: AsyncSession, user: User) -> list[dict]:
    mine = list((await db.execute(select(CalMember).where(CalMember.user_id == user.id))).scalars())
    ids = [m.calendar_id for m in mine]
    cals = {c.id: c for c in (await db.execute(select(CalCalendar).where(CalCalendar.id.in_(ids)))).scalars()} if ids else {}
    roles: dict[uuid.UUID, dict[str, str]] = {}
    if ids:
        for cid, uid, role in (await db.execute(select(CalMember.calendar_id, CalMember.user_id, CalMember.role).where(CalMember.calendar_id.in_(ids)).order_by(CalMember.joined_at))).all():
            roles.setdefault(cid, {})[str(uid)] = role
    # Someone else's own calendar shared with you reads "Sam's calendar".
    owners = {
        u.id: u.username
        for u in (await db.execute(select(User).where(User.id.in_({c.owner_id for c in cals.values() if c.personal and c.owner_id != user.id})))).scalars()
    } if cals else {}
    out = []
    for m in sorted(mine, key=lambda x: (not (cals[x.calendar_id].personal and cals[x.calendar_id].owner_id == user.id) if x.calendar_id in cals else True, x.joined_at)):
        c = cals.get(m.calendar_id)
        if c is None:
            continue
        theirs = c.personal and c.owner_id != user.id
        out.append(
            {
                "id": str(c.id),
                "name": f"{owners.get(c.owner_id, 'Someone')}'s calendar" if theirs else c.name,
                "personal": c.personal,
                "base_color": c.color,
                "color": m.color or c.color,
                "role": m.role,
                "hidden": m.hidden,
                "owner_id": str(c.owner_id) if c.owner_id else None,
                "member_roles": roles.get(c.id, {}),
            }
        )
    return out


@router.get("/bootstrap")
async def bootstrap(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await core.ensure_personal(db, user)
    await db.commit()
    cals = await _calendars_out(db, user)
    people = {user.id} | {uuid.UUID(uid) for c in cals for uid in c["member_roles"]}
    feed = await db.get(CalFeed, user.id)
    from app.items.service import installed_kinds

    kinds = await installed_kinds(db, user)
    return {
        "me": core.user_out(user),
        "tz": core.user_tz(user),
        "calendars": cals,
        "users": await core.users_map(db, people),
        "feed_token": feed.token if feed else None,
        "prefs": _prefs(user),
        # Which other apps can show on the calendar ("Also show").
        "apps": {k: k in kinds for k in ("tasks", "contacts", "workout", "mealplan", "budget", "trip", "health")},
    }


# What shows on the calendar besides events ("Also show"). Holidays stay off
# until a country is picked; ``second_tz`` adds a second time column.
_PREF_DEFAULTS: dict[str, bool] = {"tasks": True, "birthdays": True, "workouts": False, "meals": False, "bills": False, "trips": False, "appointments": False, "holidays": False}


def _prefs(user: User) -> dict[str, Any]:
    saved = (user.settings or {}).get("calendar") or {}
    out: dict[str, Any] = {k: bool(saved.get(k, v)) for k, v in _PREF_DEFAULTS.items()}
    out["holiday_country"] = str(saved.get("holiday_country") or "")
    out["second_tz"] = str(saved.get("second_tz") or "")
    return out


class PrefsIn(BaseModel):
    tasks: bool | None = None
    birthdays: bool | None = None
    workouts: bool | None = None
    meals: bool | None = None
    bills: bool | None = None
    trips: bool | None = None
    appointments: bool | None = None
    holidays: bool | None = None
    holiday_country: str | None = Field(default=None, max_length=8)  # "" = none
    second_tz: str | None = Field(default=None, max_length=64)  # "" = off


@router.patch("/prefs")
async def set_prefs(body: PrefsIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """What else shows on the calendar (tasks, birthdays, workouts, meals,
    bills, trips, Health appointments, holidays and their country), and a
    second time zone."""
    patch = body.model_dump(exclude_none=True)
    if patch.get("holiday_country"):
        patch["holiday_country"] = patch["holiday_country"].upper()
        if patch["holiday_country"] not in extras.holiday_countries():
            raise service.bad("We don't have holidays for that country.")
    if patch.get("second_tz"):
        from zoneinfo import ZoneInfo

        try:
            ZoneInfo(patch["second_tz"])
        except Exception as exc:  # noqa: BLE001 — ZoneInfoNotFoundError / ValueError
            raise service.bad("Unknown time zone.") from exc
    prefs = {**_prefs(user), **patch}
    user.settings = {**(user.settings or {}), "calendar": prefs}
    await db.commit()
    return prefs


@router.get("/holiday-countries")
async def holiday_countries(user: User = Depends(get_current_user)) -> dict:
    """Countries we have public holidays for, and a guess at yours (from your time zone)."""
    return {
        "countries": [{"code": c, "name": n} for c, n in extras.holiday_countries().items()],
        "guess": extras.guess_country(core.user_tz(user)),
    }


# ================================================================== calendars


class CalendarIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#4F7FE0", pattern=_HEX)
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)


class CalendarPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, pattern=_HEX)


class CalendarMe(BaseModel):
    color: str | None = Field(default=None, pattern=_HEX)
    reset_color: bool = False
    hidden: bool | None = None


# editor: make changes · viewer: see all details · busy: free/busy only.
Role = Literal["editor", "viewer", "busy"]


class MembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    role: Role = "editor"


class RoleIn(BaseModel):
    role: Role


async def _one_calendar(db: AsyncSession, user: User, cal_id: uuid.UUID) -> dict:
    return next(c for c in await _calendars_out(db, user) if c["id"] == str(cal_id))


def _owner(cal: CalCalendar, m: CalMember) -> None:
    if m.role != "owner":
        raise core.forbidden("Only the calendar's owner can do that.")


@router.post("/calendars", status_code=201)
async def create_calendar(body: CalendarIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    cal = CalCalendar(name=body.name.strip(), color=body.color, owner_id=user.id, personal=False)
    db.add(cal)
    await db.flush()
    db.add(CalMember(calendar_id=cal.id, user_id=user.id, role="owner"))
    added = await _add_members(db, cal, body.member_ids, "editor", user)
    await db.commit()
    await notify.added_to_calendar(db, cal.name, user, added)
    return await _one_calendar(db, user, cal.id)


async def _add_members(db: AsyncSession, cal: CalCalendar, ids: list[uuid.UUID], role: str, user: User) -> set[uuid.UUID]:
    have = set(await core.member_ids(db, cal.id))
    want = set((await db.execute(select(User.id).where(User.id.in_(ids), User.disabled.is_(False)))).scalars()) - have
    for uid in want:
        db.add(CalMember(calendar_id=cal.id, user_id=uid, role=role))
    await db.flush()
    return want


@router.patch("/calendars/{cal_id}")
async def update_calendar(cal_id: uuid.UUID, body: CalendarPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    cal, m = await core.load_calendar(db, cal_id, user)
    _owner(cal, m)
    if body.name is not None:
        cal.name = body.name.strip()
    if body.color is not None:
        cal.color = body.color
    await db.commit()
    return await _one_calendar(db, user, cal.id)


@router.patch("/calendars/{cal_id}/me")
async def calendar_me(cal_id: uuid.UUID, body: CalendarMe, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    _cal, m = await core.load_calendar(db, cal_id, user)
    if body.reset_color:
        m.color = None
    elif body.color is not None:
        m.color = body.color
    if body.hidden is not None:
        m.hidden = body.hidden
    await db.commit()
    return await _one_calendar(db, user, cal_id)


@router.delete("/calendars/{cal_id}", status_code=204)
async def delete_calendar(cal_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    cal, m = await core.load_calendar(db, cal_id, user)
    _owner(cal, m)
    if cal.personal:
        raise service.bad("Your own calendar can't be deleted.")
    await db.delete(cal)
    await db.commit()


@router.post("/calendars/{cal_id}/members")
async def add_members(cal_id: uuid.UUID, body: MembersIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    cal, m = await core.load_calendar(db, cal_id, user)
    _owner(cal, m)
    # Sharing your own calendar ("my wife sees mine"): they see it as
    # "<you>'s calendar", as much as the role allows.
    added = await _add_members(db, cal, body.user_ids, body.role, user)
    await db.commit()
    await notify.added_to_calendar(db, cal.name, user, added, own=cal.personal)
    out = await _one_calendar(db, user, cal.id)
    out["users"] = await core.users_map(db, {uuid.UUID(u) for u in out["member_roles"]})
    return out


@router.patch("/calendars/{cal_id}/members/{user_id}")
async def set_role(cal_id: uuid.UUID, user_id: uuid.UUID, body: RoleIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    cal, m = await core.load_calendar(db, cal_id, user)
    _owner(cal, m)
    target = await core.membership(db, cal.id, user_id)
    if target is None or target.role == "owner":
        raise core.not_found("Member")
    target.role = body.role
    await db.commit()
    return await _one_calendar(db, user, cal.id)


@router.delete("/calendars/{cal_id}/members/{user_id}", status_code=204)
async def remove_member(cal_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    """The owner removes someone, or anyone leaves (the owner can't leave —
    they delete the calendar instead)."""
    cal, m = await core.load_calendar(db, cal_id, user)
    if user_id != user.id:
        _owner(cal, m)
    target = await core.membership(db, cal.id, user_id)
    if target is None:
        raise core.not_found("Member")
    if target.role == "owner":
        raise service.bad("The owner can't leave — delete the calendar instead.")
    await db.delete(target)
    await db.commit()


@router.get("/people-suggestions")
async def people_suggestions(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """People on this Promptly who are in your Contacts (matched by email, or
    by name), with what they are to you ("Wife" — from Photos), closest first."""
    return {"people": await sharing.contact_people(db, user)}


# ================================================================== events


_MAX_RANGE = timedelta(days=400)


def _range(start: str, end: str) -> tuple[datetime, datetime]:
    try:
        s = _when(start)
        e = _when(end)
    except ValueError as exc:
        raise service.bad("Bad range.") from exc
    if e <= s or e - s > _MAX_RANGE:
        raise service.bad("The range must be under 400 days.")
    return s, e


def _when(raw: str) -> datetime:
    if len(raw) == 10:
        d = date.fromisoformat(raw)
        return datetime(d.year, d.month, d.day, tzinfo=UTC)
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


@router.get("/events")
async def list_events(
    start: str = Query(..., max_length=40),
    end: str = Query(..., max_length=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    s, e = _range(start, end)
    events = await core.visible_events(db, user, s, e)
    occ = await core.occurrences_out(db, user, events, s, e)
    people = {uuid.UUID(a["user_id"]) for o in occ for a in o["attendees"]} | {uuid.UUID(o["created_by"]) for o in occ if o["created_by"]}
    return {"events": occ, "users": await core.users_map(db, people)}


@router.get("/events/{event_id}")
async def get_event(event_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    ev, m, att = await core.load_event(db, event_id, user)
    atts = (await core.attendees_of(db, [ev.id])).get(ev.id, [])
    out = core.event_out(ev, m, att, atts, user)
    # Positioned on the next occurrence — for a notification's link to open on.
    out.update(_next_occurrence(ev, core.now()))
    if out.get("busy_only"):
        return {"event": out, "users": {}}
    out["rooms"] = await sharing.rooms_out(db, ev, user)
    # Guests invited by email, and each room's "starting soon" post (reach.py).
    from . import reach

    out.update(await reach.detail_extra(db, ev, user, out["can_edit"]))
    people = {a.user_id for a in atts} | ({ev.created_by} if ev.created_by else set())
    return {"event": out, "users": await core.users_map(db, people)}


def _next_occurrence(ev: CalEvent, now: datetime) -> dict:
    """The occurrence fields for the next one from now (or the first, if all past)."""
    from . import recur

    nxt = recur.occurrences(start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
                            exdates=ev.exdates, range_start=now, range_end=now + timedelta(days=400))[:1]
    s, e = nxt[0] if nxt else (ev.start_at, ev.end_at)
    return {"id": f"{ev.id}:{recur.stamp(s)}", "occurrence": recur.stamp(s), "start": core.iso(s, ev.all_day), "end": core.end_iso(e, ev.all_day)}


class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    location: str = Field(default="", max_length=300)
    all_day: bool = False
    start: str = Field(max_length=40)
    end: str | None = Field(default=None, max_length=40)
    tz: str | None = Field(default=None, max_length=64)
    calendar_id: uuid.UUID | None = None
    repeat: dict[str, Any] | None = None
    reminders: list[int] | None = Field(default=None, max_length=5)
    guests: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    guests_can_edit: bool = False
    color: str | None = Field(default=None, pattern=_HEX)
    # Planned in a room: everyone in it is invited, and a card is posted there.
    room_id: uuid.UUID | None = None
    # What it was made from: a task planned into a time slot.
    source: "EventSource | None" = None


class EventSource(BaseModel):
    kind: Literal["task"]
    file_id: uuid.UUID
    task_id: str = Field(min_length=1, max_length=64)


EventIn.model_rebuild()


class EventPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    location: str | None = Field(default=None, max_length=300)
    all_day: bool | None = None
    start: str | None = Field(default=None, max_length=40)
    end: str | None = Field(default=None, max_length=40)
    tz: str | None = Field(default=None, max_length=64)
    calendar_id: uuid.UUID | None = None
    repeat: dict[str, Any] | None = None
    reminders: list[int] | None = Field(default=None, max_length=5)
    guests: list[uuid.UUID] | None = Field(default=None, max_length=50)
    guests_can_edit: bool | None = None
    color: str | None = Field(default=None, pattern=_HEX)
    scope: Literal["all", "this", "following"] = "all"
    occurrence: str | None = Field(default=None, max_length=40)


@router.post("/events", status_code=201)
async def create_event(body: EventIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    f = service.EventFields(**body.model_dump(exclude={"repeat", "color", "room_id", "source"}), repeat=body.repeat, repeat_set=True, color=body.color, color_set=True)
    # In a room, the card (and its push) is the invitation — no second ping.
    ev = await service.create_event(db, user, f, ping_guests=body.room_id is None)
    if body.source is not None:
        ev.source = body.source.model_dump(mode="json")
    card = await sharing.share_to_room(db, user, ev, body.room_id, invite_all=True) if body.room_id else None
    await db.commit()
    if card:
        await sharing.publish_card(db, *card)
    return await get_event(ev.id, db, user)


class ShareIn(BaseModel):
    room_id: uuid.UUID
    # Also invite everyone in the room (else they add themselves from the card).
    invite_all: bool = False


@router.post("/events/{event_id}/share")
async def share_event(event_id: uuid.UUID, body: ShareIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Post an event's card in a room you're in."""
    ev, m, att = await core.load_event(db, event_id, user, lock=True)
    if not core.can_edit(ev, m, att, user):
        raise core.forbidden("Only the organiser can share this event.")
    card = await sharing.share_to_room(db, user, ev, body.room_id, invite_all=body.invite_all)
    await db.commit()
    await sharing.publish_card(db, *card)
    return await get_event(ev.id, db, user)


@router.get("/rooms/{room_id}/upcoming")
async def room_upcoming(room_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Events planned in or shared to a room, from now on (for the room's panel)."""
    from app.rooms import core as rooms_core

    await rooms_core.load_room(db, room_id, user)
    now = core.now()
    events = list(
        (
            await db.execute(
                select(CalEvent)
                .join(CalEventRoom, CalEventRoom.event_id == CalEvent.id)
                .where(CalEventRoom.room_id == room_id, (CalEvent.last_end.is_(None)) | (CalEvent.last_end > now))
                .order_by(CalEvent.start_at)
                .limit(50)
            )
        ).scalars()
    )
    atts = await core.attendees_of(db, [e.id for e in events])
    out = []
    for ev in events:
        al = atts.get(ev.id, [])
        my_att = next((a for a in al if a.user_id == user.id), None)
        o = core.event_out(ev, await core.membership(db, ev.calendar_id, user.id), my_att, al, user)
        o.update(_next_occurrence(ev, now))
        out.append(o)
    out.sort(key=lambda o: o["start"])
    people = {uuid.UUID(a["user_id"]) for o in out for a in o["attendees"]} | {uuid.UUID(o["created_by"]) for o in out if o["created_by"]}
    return {"events": out[:20], "users": await core.users_map(db, people)}


@router.patch("/events/{event_id}")
async def update_event(event_id: uuid.UUID, body: EventPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    given = body.model_fields_set
    data = body.model_dump(exclude={"scope", "occurrence", "repeat", "color"}, exclude_unset=True)
    f = service.EventFields(
        **data,
        repeat=body.repeat, repeat_set="repeat" in given,
        color=body.color, color_set="color" in given,
    )
    ev = await service.update_event(db, user, event_id, f, scope=body.scope, occurrence=body.occurrence)
    await db.commit()
    return await get_event(ev.id, db, user)


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: uuid.UUID,
    scope: Literal["all", "this", "following"] = "all",
    occurrence: str | None = Query(default=None, max_length=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    await service.delete_event(db, user, event_id, scope=scope, occurrence=occurrence)
    await db.commit()


class RsvpIn(BaseModel):
    status: Literal["going", "maybe", "declined"]


@router.post("/events/{event_id}/rsvp")
async def rsvp(event_id: uuid.UUID, body: RsvpIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await service.rsvp(db, user, event_id, body.status)
    await db.commit()
    return await get_event(event_id, db, user)


class EventMe(BaseModel):
    reminders: list[int] | None = Field(default=None, max_length=5)
    use_event_reminders: bool = False
    hidden: bool | None = None


@router.patch("/events/{event_id}/me")
async def event_me(event_id: uuid.UUID, body: EventMe, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Your own settings for an event (a guest's, or a shared calendar
    member's): your reminders, or removing it from your calendar (``hidden``)."""
    ev, m, att = await core.load_event(db, event_id, user)
    if att is None:
        if m is None:
            raise core.not_found()
        # A shared calendar's member: their own row holds their settings.
        att = CalAttendee(event_id=ev.id, user_id=user.id, invited_by=None)
        db.add(att)
    if body.use_event_reminders:
        att.reminders = None
    elif body.reminders is not None:
        att.reminders = service.clean_reminders(body.reminders)
    if body.hidden is not None:
        att.hidden = body.hidden
    await db.commit()
    if att.hidden:
        return {"hidden": True}
    return await get_event(ev.id, db, user)


@router.get("/invites")
async def invites(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Invitations you haven't answered, for events that aren't over."""
    now = core.now()
    rows = (
        await db.execute(
            select(CalEvent, CalAttendee)
            .join(CalAttendee, CalAttendee.event_id == CalEvent.id)
            .where(
                CalAttendee.user_id == user.id, CalAttendee.status == "invited", CalAttendee.hidden.is_(False),
                CalAttendee.invited_by.is_not(None),
                (CalEvent.last_end.is_(None)) | (CalEvent.last_end > now),
            )
            .order_by(CalEvent.start_at)
            .limit(50)
        )
    ).all()
    events = [ev for ev, _ in rows]
    atts = await core.attendees_of(db, [e.id for e in events])
    out = []
    for ev, att in rows:
        o = core.event_out(ev, None, att, atts.get(ev.id, []), user)
        o.update(_next_occurrence(ev, now))
        out.append(o)
    people = {e.created_by for e in events if e.created_by}
    return {"invites": out, "users": await core.users_map(db, people)}


# ================================================================== lookups


@router.get("/busy")
async def busy(
    users: str = Query(..., max_length=2000),
    start: str = Query(..., max_length=40),
    end: str = Query(..., max_length=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """When each person isn't available — times only, never what or where."""
    s, e = _range(start, end)
    if e - s > lookup.MAX_RANGE:
        raise service.bad("Ask about a month at most.")
    try:
        ids = [uuid.UUID(x) for x in users.split(",") if x.strip()]
    except ValueError as exc:
        raise service.bad("Bad people.") from exc
    return {"busy": await lookup.busy(db, ids, s, e)}


@router.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=200), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    found = await lookup.search(db, user, q)
    people = {uuid.UUID(o["created_by"]) for o in found if o["created_by"]}
    return {"events": found, "users": await core.users_map(db, people)}


@router.get("/extras")
async def extras_in(
    start: str = Query(..., max_length=40),
    end: str = Query(..., max_length=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """What else is on in a range of days (``YYYY-MM-DD``) — tasks due,
    birthdays, workouts, meals, bills, trips, Health appointments and holidays — as your calendar
    settings allow (and only from apps you have)."""
    try:
        s, e = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
    except ValueError as exc:
        raise service.bad("Bad range.") from exc
    if e <= s or (e - s).days > 400:
        raise service.bad("The range must be under 400 days.")
    from app.items.service import installed_kinds

    prefs = _prefs(user)
    kinds = await installed_kinds(db, user)

    def on(pref: str, kind: str | None = None) -> bool:
        return bool(prefs[pref]) and (kind is None or kind in kinds)

    country = prefs["holiday_country"]
    return {
        "tasks": await extras.tasks_in(db, user, s, e) if on("tasks") else [],
        "birthdays": await extras.birthdays_in(db, user, s, e) if on("birthdays") else [],
        "workouts": await extras.workouts_in(db, user, s, e) if on("workouts", "workout") else [],
        "meals": await extras.meals_in(db, user, s, e) if on("meals", "mealplan") else [],
        "bills": await extras.bills_in(db, user, s, e) if on("bills", "budget") else [],
        "trips": await extras.trips_in(db, user, s, e) if on("trips", "trip") else [],
        "appointments": await extras.appointments_in(db, user, s, e) if on("appointments", "health") else [],
        "holidays": extras.holidays_in(country, s, e) if on("holidays") and country else [],
    }


@router.get("/extras/task")
async def extras_task(
    file_id: uuid.UUID = Query(...),
    task_id: str = Query(..., min_length=1, max_length=64),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A planned task's title and whether it's done (for the event's "Done" box)."""
    return await extras.task_status(db, user, file_id, task_id)


# ================================================================== feed


@router.post("/feed")
async def make_feed(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Make (or replace — the old link stops working) your subscribe link."""
    await db.execute(delete(CalFeed).where(CalFeed.user_id == user.id))
    feed = CalFeed(user_id=user.id, token=ics.new_token())
    db.add(feed)
    await db.commit()
    return {"feed_token": feed.token}


@router.delete("/feed", status_code=204)
async def drop_feed(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    await db.execute(delete(CalFeed).where(CalFeed.user_id == user.id))
    await db.commit()


# No login: the token in the link is the key (a phone's calendar app can't
# sign in). Read-only, and reset from the app if it leaks.
public_router = APIRouter()


@public_router.get("/feed/{token}.ics")
async def feed(token: str, db: AsyncSession = Depends(get_db)) -> Response:
    if len(token) > 64:
        raise HTTPException(status_code=404)
    row = (await db.execute(select(CalFeed).where(CalFeed.token == token))).scalar_one_or_none()
    owner = await db.get(User, row.user_id) if row else None
    if row is None or owner is None or owner.disabled:
        raise HTTPException(status_code=404)
    body = await ics.build(db, owner)
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "private, max-age=300", "Content-Disposition": 'inline; filename="promptly.ics"'},
    )
