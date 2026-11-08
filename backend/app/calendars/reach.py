"""Events reaching out past the calendar: photos from an event, "starting in
1 hour" posts in the rooms it was planned in, and guests invited by email
(people who aren't on this Promptly) answering from a link.

* **Photos** — only ever the viewer's own library: what they took during
  the occurrence (an hour before to two hours after; an all-day event's
  days by the wall clock). Time only — there's no address → place lookup
  to narrow it by where.
* **Room posts** — :func:`send_room_due` runs with the reminder loop.
* **Email guests** — a row in ``cal_external_guests`` with a random token;
  the email links to ``/calendar/answer/<token>``, a public page.
"""
from __future__ import annotations

import html
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import core, notify, recur
from .models import CalEvent, CalEventRoom, CalExternalGuest, CalRoomReminderSent

logger = logging.getLogger("promptly.calendar.reach")
UTC = timezone.utc

BEFORE = timedelta(hours=1)
AFTER = timedelta(hours=2)
STRIP = 12  # thumbnails shown in the event
ALBUM_MAX = 2000
MAX_EMAIL_GUESTS = 50
ROOM_REMIND_CHOICES = (15, 30, 60, 120, 1440)
_EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


def bad(detail: str, code: int = 400) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


# ================================================================== photos


def _occurrence_for(ev: CalEvent, occurrence: str | None, now: datetime) -> tuple[datetime, datetime] | None:
    """The occurrence asked for, else the latest one that has started (None:
    nothing has started yet)."""
    if occurrence:
        from .service import _occurrence

        s = _occurrence(ev, occurrence)
        return s, s + (ev.end_at - ev.start_at)
    hits = recur.occurrences(
        start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
        exdates=ev.exdates, range_start=now - timedelta(days=400), range_end=now + timedelta(seconds=1),
    )
    started = [(s, e) for s, e in hits if s <= now]
    return started[-1] if started else None


def _window_filter(ev: CalEvent, start: datetime, end: datetime):  # noqa: ANN202
    from app.photos.models import PhotoAsset

    if ev.all_day:
        # All-day events are dates: the photos taken on those days, by the
        # clock where they were taken.
        first = datetime.combine(start.astimezone(UTC).date(), datetime.min.time())
        last = datetime.combine(end.astimezone(UTC).date(), datetime.min.time())
        return and_(PhotoAsset.taken_local >= first, PhotoAsset.taken_local < last)
    return and_(PhotoAsset.taken_at >= start - BEFORE, PhotoAsset.taken_at <= end + AFTER)


async def _photo_rows(db: AsyncSession, user: User, ev: CalEvent, start: datetime, end: datetime, limit: int | None):  # noqa: ANN202
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    where = (in_library(user.id), PhotoAsset.archived_at.is_(None), _window_filter(ev, start, end))
    total = (
        await db.execute(select(func.count()).select_from(PhotoAsset).join(UserFile, UserFile.id == PhotoAsset.file_id).where(*where))
    ).scalar_one()
    q = (
        select(PhotoAsset, UserFile, FileMedia)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
        .where(*where)
        .order_by(PhotoAsset.taken_at, PhotoAsset.file_id)
    )
    if limit is not None:
        q = q.limit(limit)
    return int(total), (await db.execute(q)).all()


async def _album_for(db: AsyncSession, ev: CalEvent, user: User) -> dict | None:
    """The album made from this event that the viewer can open: their own
    (remembered on them), else the event's when they're on it."""
    from app.photos.album_models import Album, AlbumMember

    ids = []
    mine = ((user.settings or {}).get("calendar_albums") or {}).get(str(ev.id))
    if mine:
        try:
            ids.append(uuid.UUID(mine))
        except ValueError:
            pass
    if ev.album_id:
        ids.append(ev.album_id)
    for aid in ids:
        album = await db.get(Album, aid)
        if album is None:
            continue
        if album.owner_id == user.id or await db.get(AlbumMember, (album.id, user.id)) is not None:
            return {"id": str(album.id), "title": album.title, "mine": album.owner_id == user.id}
    return None


async def _visible(db: AsyncSession, event_id: uuid.UUID, user: User) -> CalEvent:
    ev, m, att = await core.load_event(db, event_id, user)
    if core.busy_only(m, att):
        raise core.not_found()
    return ev


async def event_photos(db: AsyncSession, user: User, event_id: uuid.UUID, occurrence: str | None) -> dict[str, Any]:
    """"Photos from this event": the viewer's own, taken during it."""
    from app.photos.router import _item

    ev = await _visible(db, event_id, user)
    now = core.now()
    occ = _occurrence_for(ev, occurrence, now)
    album = await _album_for(db, ev, user)
    if occ is None or occ[0] > now:
        return {"started": False, "count": 0, "items": [], "album": album}
    start, end = occ
    total, rows = await _photo_rows(db, user, ev, start, end, STRIP)
    if ev.all_day:
        win = {"start": core.iso(start, True), "end": core.end_iso(end, True)}
    else:
        win = {"start": core.iso(start - BEFORE, False), "end": core.iso(end + AFTER, False)}
    return {
        "started": True,
        "occurrence": recur.stamp(start),
        "count": total,
        "items": [_item(a, r, m, user) for a, r, m in rows],
        "window": win,
        "album": album,
    }


async def make_album(db: AsyncSession, user: User, event_id: uuid.UUID, occurrence: str | None) -> dict[str, Any]:
    """An album of those photos, named after the event (and its day, for a
    repeating one). Commits."""
    from app.photos.album_models import Album
    from app.photos.albums_router import _add_items

    ev = await _visible(db, event_id, user)
    now = core.now()
    occ = _occurrence_for(ev, occurrence, now)
    if occ is None or occ[0] > now:
        raise bad("This event hasn't started yet.")
    _total, rows = await _photo_rows(db, user, ev, occ[0], occ[1], ALBUM_MAX)
    ids = [a.file_id for a, _r, _m in rows]
    if not ids:
        raise bad("There are no photos of yours from this event.")
    title = ev.title
    if ev.repeat:
        d = occ[0].astimezone(recur.zone(ev.tz)) if not ev.all_day else occ[0]
        title = f"{ev.title} · {d.day} {d:%b %Y}"
    album = Album(owner_id=user.id, title=title[:200], cover_file_id=ids[len(ids) // 2])
    db.add(album)
    await db.flush()
    await _add_items(db, album, user, ids)
    # Remembered on you (the event's own link may already be someone else's).
    saved = dict((user.settings or {}).get("calendar_albums") or {})
    saved[str(ev.id)] = str(album.id)
    if len(saved) > 300:
        saved = dict(list(saved.items())[-300:])
    user.settings = {**(user.settings or {}), "calendar_albums": saved}
    locked = (await db.execute(select(CalEvent).where(CalEvent.id == ev.id).with_for_update())).scalar_one()
    if locked.album_id is None or await db.get(Album, locked.album_id) is None:
        locked.album_id = album.id
    await db.commit()
    return {"id": str(album.id), "title": album.title, "mine": True, "count": len(ids)}


# ================================================================== rooms


def room_lead(minutes: int, all_day: bool) -> str:
    if all_day:
        return "Tomorrow" if minutes >= 1440 else "Today"
    if minutes >= 1440 and minutes % 1440 == 0:
        return "Tomorrow" if minutes == 1440 else f"In {minutes // 1440} days"
    if minutes >= 60 and minutes % 60 == 0:
        h = minutes // 60
        return f"Starting in {h} hour{'s' if h != 1 else ''}"
    return f"Starting in {minutes} min"


def _room_due(start: datetime, minutes: int, ev: CalEvent) -> datetime:
    """When a room's post goes: ``minutes`` before; an all-day event's at
    9:00 on the day (or the day before, for "1 day"), in its zone."""
    if not ev.all_day:
        return start - timedelta(minutes=minutes)
    nine = datetime.combine(start.date(), datetime.min.time()).replace(hour=9, tzinfo=recur.zone(ev.tz))
    return nine.astimezone(UTC) - (timedelta(days=1) if minutes >= 1440 else timedelta())


_GRACE = timedelta(minutes=10)


async def send_room_due(db: AsyncSession, now: datetime | None = None) -> int:
    """Post "Starting in 1 hour · 3 going" in each room an event was planned
    in or shared to, once per occurrence (``cal_room_reminders_sent``
    claims it). Posted as the person who shared it — and not at all when
    they've left the room."""
    from app.rooms import core as rooms_core
    from app.rooms import service as rooms_service
    from app.rooms.models import Room

    from .models import CalAttendee
    from .sharing import publish_card

    now = now or core.now()
    rows = (
        await db.execute(
            select(CalEventRoom, CalEvent)
            .join(CalEvent, CalEvent.id == CalEventRoom.event_id)
            .where(CalEventRoom.remind_minutes.is_not(None), core.in_range_filter(now - _GRACE, now + timedelta(days=2)))
        )
    ).all()
    posted: list[tuple[uuid.UUID, uuid.UUID]] = []
    for link, ev in rows:
        minutes = int(link.remind_minutes or 0)
        lead_time = timedelta(minutes=minutes) + (timedelta(days=1) if ev.all_day else timedelta())
        for start, _end in recur.occurrences(
            start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
            exdates=ev.exdates, range_start=now - _GRACE, range_end=now + lead_time + _GRACE,
        ):
            due = _room_due(start, minutes, ev)
            if not (now - _GRACE < due <= now) or start < now - _GRACE:
                continue
            claimed = await db.execute(
                insert(CalRoomReminderSent)
                .values(event_id=ev.id, room_id=link.room_id, occurrence=start)
                .on_conflict_do_nothing()
                .returning(CalRoomReminderSent.event_id)
            )
            if claimed.scalar_one_or_none() is None:
                continue
            poster = await db.get(User, link.shared_by or ev.created_by) if (link.shared_by or ev.created_by) else None
            room = (await db.execute(select(Room).where(Room.id == link.room_id).with_for_update())).scalar_one_or_none()
            if poster is None or poster.disabled or room is None or poster.id not in await rooms_core.member_ids(db, room):
                continue
            if await rooms_service.dm_refusal(db, room, poster.id):
                continue  # a 1:1 conversation closed by a block
            going = (
                await db.execute(select(func.count()).select_from(CalAttendee).where(CalAttendee.event_id == ev.id, CalAttendee.status == "going"))
            ).scalar_one()
            going += 1 if ev.created_by else 0  # the organiser
            when = notify.when_text(start, start + (ev.end_at - ev.start_at), ev.all_day, ev.tz)
            body = f"⏰ {ev.title} · {room_lead(minutes, ev.all_day)} ({when})" + (f" · {going} going" if going else "")
            msg = await rooms_service.post_message(db, room, poster, body)
            # Plain text, not a second card; never an @mention.
            msg.mentions = []
            msg.meta = {**(msg.meta or {}), "event_reminder": str(ev.id), "reminder": True}
            await db.flush()
            posted.append((room.id, msg.id))
    await db.commit()
    for room_id, msg_id in posted:
        try:
            await publish_card(db, room_id, msg_id)
        except Exception:  # noqa: BLE001 — the post is made; live update is best-effort
            logger.exception("publishing a room reminder failed")
    return len(posted)


async def room_links_out(db: AsyncSession, ev: CalEvent, user: User, can_edit: bool) -> list[dict]:
    """Each room (you're in) it's in: its "starting soon" post, and whether
    you can change it (the organiser side, or whoever shared it there)."""
    rooms = await core.shared_rooms(db, ev.id, user)
    if not rooms:
        return []
    links = (await db.execute(select(CalEventRoom).where(CalEventRoom.event_id == ev.id, CalEventRoom.room_id.in_(rooms)))).scalars()
    return [
        {"room_id": str(link.room_id), "remind_minutes": link.remind_minutes, "can_change": can_edit or link.shared_by == user.id}
        for link in links
    ]


async def set_room_reminder(db: AsyncSession, user: User, event_id: uuid.UUID, room_id: uuid.UUID, minutes: int | None) -> dict:
    ev, m, att = await core.load_event(db, event_id, user)
    if room_id not in await core.shared_rooms(db, ev.id, user):
        raise core.not_found()
    link = await db.get(CalEventRoom, (ev.id, room_id))
    if link is None:
        raise core.not_found()
    if not (core.can_edit(ev, m, att, user) or link.shared_by == user.id):
        raise core.forbidden("Only the organiser can change that.")
    if minutes is not None and minutes not in ROOM_REMIND_CHOICES:
        raise bad("Pick 15 or 30 minutes, 1 or 2 hours, or a day before.")
    link.remind_minutes = minutes
    await db.commit()
    return {"room_id": str(room_id), "remind_minutes": minutes}


# ================================================================== email guests


def clean_email(raw: str) -> str:
    e = (raw or "").strip().strip("<>").strip()
    if len(e) > 254 or not _EMAIL.match(e):
        raise bad(f"“{raw[:80]}” isn't an email address.")
    return e.lower()


async def smtp_ready(db: AsyncSession) -> bool:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return bool(row is not None and row.smtp_configured)


async def site_origin(db: AsyncSession, request_origin: str | None = None) -> str:
    """Where links in an email point: the admin's public address, else the
    one the organiser is using, else the configured one."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.config import get_settings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    for o in list(getattr(row, "public_origins", None) or []):
        if isinstance(o, str) and o.startswith(("https://", "http://")):
            return o.strip().rstrip("/")
    if request_origin and request_origin.startswith(("https://", "http://")):
        return request_origin.rstrip("/")
    origins = get_settings().allowed_origins_list
    return (origins[0] if origins else "http://localhost").rstrip("/")


async def email_check(db: AsyncSession, raw: str) -> dict:
    """Is this someone on Promptly (invite them normally), or an outsider
    (invite by email — when this server can send email)?"""
    try:
        email = clean_email(raw)
    except HTTPException:
        return {"email": raw, "valid": False, "user": None, "can_email": await smtp_ready(db)}
    u = (await db.execute(select(User).where(func.lower(User.email) == email, User.disabled.is_(False)).limit(1))).scalar_one_or_none()
    return {"email": email, "valid": True, "user": core.user_out(u) if u else None, "can_email": await smtp_ready(db)}


def guest_out(g: CalExternalGuest, show_email: bool) -> dict:
    if show_email:
        email = g.email
    else:
        name, _, domain = g.email.partition("@")
        email = f"{name[:1]}•••@{domain}"
    return {"id": str(g.id), "email": email, "name": g.name, "status": g.status}


async def guests_of(db: AsyncSession, event_id: uuid.UUID) -> list[CalExternalGuest]:
    return list((await db.execute(select(CalExternalGuest).where(CalExternalGuest.event_id == event_id).order_by(CalExternalGuest.created_at))).scalars())


async def detail_extra(db: AsyncSession, ev: CalEvent, user: User, can_edit: bool) -> dict:
    """What the event's detail adds: email guests, the rooms' "starting
    soon" posts."""
    return {
        "email_guests": [guest_out(g, can_edit) for g in await guests_of(db, ev.id)],
        "room_links": await room_links_out(db, ev, user, can_edit),
    }


async def invite_by_email(db: AsyncSession, user: User, event_id: uuid.UUID, emails: list[str], origin: str | None) -> list[CalExternalGuest]:
    """Add people by email and send each their invitation. Commits."""
    ev, m, att = await core.load_event(db, event_id, user)
    if not core.can_edit(ev, m, att, user):
        raise core.forbidden("Only the organiser can invite people.")
    if not await smtp_ready(db):
        raise bad("This server can't send email yet — an admin can set it up in Settings.")
    wanted = list(dict.fromkeys(clean_email(e) for e in emails))
    have = {g.email: g for g in await guests_of(db, ev.id)}
    new = [e for e in wanted if e not in have]
    if len(have) + len(new) > MAX_EMAIL_GUESTS:
        raise bad(f"An event can have at most {MAX_EMAIL_GUESTS} guests by email.")
    # Someone on Promptly is invited the usual way, not by email.
    on_promptly = set(
        (await db.execute(select(func.lower(User.email)).where(func.lower(User.email).in_(new), User.disabled.is_(False)))).scalars()
    )
    if on_promptly:
        raise bad(f"{sorted(on_promptly)[0]} is on Promptly — add them as a guest instead.")
    rows = []
    for e in new:
        g = CalExternalGuest(event_id=ev.id, email=e, token=secrets.token_urlsafe(24), invited_by=user.id)
        db.add(g)
        rows.append(g)
    await db.flush()
    base = await site_origin(db, origin)
    for g in rows:
        try:
            await _mail(db, ev, g, user, "invite", base)
        except Exception as exc:  # noqa: BLE001 — never show raw SMTP errors
            await db.rollback()
            raise bad("Couldn't send the invitation email — check the server's email settings.", 502) from exc
    await db.commit()
    return rows


async def remove_email_guest(db: AsyncSession, user: User, event_id: uuid.UUID, guest_id: uuid.UUID) -> None:
    ev, m, att = await core.load_event(db, event_id, user)
    if not core.can_edit(ev, m, att, user):
        raise core.forbidden("Only the organiser can remove guests.")
    g = await db.get(CalExternalGuest, guest_id)
    if g is None or g.event_id != ev.id:
        raise core.not_found("Guest")
    snap = _snapshot(ev, [g], user)
    await db.delete(g)
    await db.commit()
    await _schedule(snap, "cancel", await site_origin(db))


# ------------------------------------------------------------------ public answer


async def by_token(db: AsyncSession, token: str) -> tuple[CalExternalGuest, CalEvent]:
    if not token or len(token) > 64:
        raise core.not_found("Invitation")
    g = (await db.execute(select(CalExternalGuest).where(CalExternalGuest.token == token))).scalar_one_or_none()
    ev = await db.get(CalEvent, g.event_id) if g else None
    if g is None or ev is None:
        raise core.not_found("Invitation")
    return g, ev


async def answer_out(db: AsyncSession, g: CalExternalGuest, ev: CalEvent) -> dict:
    """What the public page shows: the event, never its other guests."""
    organiser = await db.get(User, ev.created_by) if ev.created_by else None
    nxt = recur.occurrences(start_at=ev.start_at, end_at=ev.end_at, all_day=ev.all_day, tz_name=ev.tz, repeat=ev.repeat,
                            exdates=ev.exdates, range_start=core.now(), range_end=core.now() + timedelta(days=400))[:1]
    s, e = nxt[0] if nxt else (ev.start_at, ev.end_at)
    return {
        "title": ev.title,
        "when": _when_line(ev, s, e),
        "repeats": recur.rrule_text(ev.repeat, ev.start_at, ev.all_day, ev.tz) if ev.repeat else None,
        "location": ev.location,
        "description": (ev.description or "")[:2000],
        "organiser": organiser.username if organiser else None,
        "email": g.email,
        "status": g.status,
        "over": not nxt,
    }


async def answer(db: AsyncSession, token: str, status: str) -> dict:
    if status not in ("going", "maybe", "declined"):
        raise bad("Answer going, maybe or declined.")
    g, ev = await by_token(db, token)
    changed = g.status != status
    g.status = status
    g.responded_at = core.now()
    await db.commit()
    if changed:
        await notify.answered_by_email(db, ev, g.name or g.email, status)
    return await answer_out(db, g, ev)


# ------------------------------------------------------------------ the emails


def _when_line(ev: CalEvent, start: datetime, end: datetime) -> str:
    text = notify.when_text(start, end, ev.all_day, ev.tz)
    if not ev.all_day:
        local_end = end.astimezone(recur.zone(ev.tz))
        text += " – " + local_end.strftime("%I:%M %p").lstrip("0").lower().replace(":00 ", " ") + f" ({ev.tz})"
    return text


def _snapshot(ev: CalEvent, guests: list[CalExternalGuest], actor: User, occurrence: datetime | None = None) -> dict:
    """Everything an email needs, taken now (the event may be gone when it's sent)."""
    s = occurrence or ev.start_at
    e = s + (ev.end_at - ev.start_at)
    copy = CalEvent(
        id=ev.id, calendar_id=ev.calendar_id, title=ev.title, description=ev.description, location=ev.location,
        all_day=ev.all_day, start_at=ev.start_at, end_at=ev.end_at, tz=ev.tz, repeat=ev.repeat, exdates=list(ev.exdates or []),
    )
    copy.updated_at = core.now()
    copy.created_at = ev.created_at
    return {
        "ev": copy, "when": _when_line(ev, s, e), "occurrence": occurrence, "actor": actor.username,
        "guests": [(g.email, g.name, g.token, g.status) for g in guests],
    }


async def _schedule(snap: dict, kind: str, base: str) -> None:
    """Send in the background (a change shouldn't wait on the mail server)."""
    from app.background import spawn

    if snap["guests"]:
        spawn(_send_snapshot(snap, kind, base), name=f"cal-email-{kind}-{snap['ev'].id}")


async def _send_snapshot(snap: dict, kind: str, base: str) -> None:
    from app.database import SessionLocal

    async with SessionLocal() as db:
        if not await smtp_ready(db):
            return
        for email, name, token, status in snap["guests"]:
            g = CalExternalGuest(email=email, name=name, token=token, status=status)
            try:
                await _deliver(db, snap["ev"], g, snap["actor"], kind, base, snap["when"], snap["occurrence"])
            except Exception:  # noqa: BLE001
                logger.exception("calendar email (%s) failed", kind)


async def email_changed(db: AsyncSession, ev: CalEvent, actor: User) -> None:
    """The event's time or place changed: tell the email guests."""
    guests = [g for g in await guests_of(db, ev.id) if g.status != "declined"]
    if guests:
        await _schedule(_snapshot(ev, guests, actor), "update", await site_origin(db))


async def email_cancelled(db: AsyncSession, ev: CalEvent, actor: User, occurrence: datetime | None = None) -> None:
    """Call before the event is deleted (its guests go with it)."""
    guests = await guests_of(db, ev.id)
    if guests:
        await _schedule(_snapshot(ev, guests, actor, occurrence), "cancel", await site_origin(db))


async def _mail(db: AsyncSession, ev: CalEvent, g: CalExternalGuest, actor: User, kind: str, base: str) -> None:
    await _deliver(db, ev, g, actor.username, kind, base, _when_line(ev, ev.start_at, ev.end_at), None)


async def _deliver(
    db: AsyncSession, ev: CalEvent, g: CalExternalGuest, actor: str, kind: str, base: str, when: str, occurrence: datetime | None,
) -> None:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    from . import ics

    cfg = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    from_addr = (cfg.smtp_from_address if cfg else None) or "calendar@localhost"
    link = f"{base}/calendar/answer/{g.token}"
    subject, text_body, html_body = render_email(ev, kind=kind, actor=actor, when=when, link=link, status=g.status)
    method = "CANCEL" if kind == "cancel" else "REQUEST"
    cal = ics.invite(
        ev, method=method, guest_email=g.email, guest_name=g.name, organiser_name=actor, organiser_email=from_addr,
        status=g.status, url=link, occurrence=occurrence,
    )
    await send_mail(db, to=g.email, subject=subject, text_body=text_body, html_body=html_body,
                    attachments=[("invite.ics", f"text/calendar; method={method}", cal)])


async def send_mail(db: AsyncSession, **kw: Any) -> None:
    """The instance's own SMTP (a seam for tests)."""
    from app.mfa.smtp import send_message

    await send_message(db, **kw)


def render_email(ev: CalEvent, *, kind: str, actor: str, when: str, link: str, status: str = "invited") -> tuple[str, str, str]:
    """(subject, text, html). Only this guest's own links — no other guest
    is named anywhere in it."""
    title = ev.title
    if kind == "cancel":
        subject = f"Cancelled: {title}"
        intro = f"{actor} cancelled {title}."
    elif kind == "update":
        subject = f"Changed: {title} · {when}"
        intro = f"{actor} changed {title}."
    else:
        subject = f"Invitation: {title} · {when}"
        intro = f"{actor} invited you to {title}."
    lines = [intro, "", f"When: {when}"]
    if ev.location:
        lines.append(f"Where: {ev.location}")
    if ev.description and kind != "cancel":
        lines += ["", ev.description[:1500]]
    answers = [("going", "Going"), ("maybe", "Maybe"), ("declined", "Can't go")]
    if kind != "cancel":
        lines += ["", "Will you come?"] + [f"  {label}: {link}?a={key}" for key, label in answers]
        lines += ["", "The attached invite adds it to your calendar."]
    lines += ["", "— Sent from Promptly"]
    text_body = "\n".join(lines)

    e = html.escape
    rows = f"<p style=\"margin:4px 0\"><b>When:</b> {e(when)}</p>"
    if ev.location:
        rows += f"<p style=\"margin:4px 0\"><b>Where:</b> {e(ev.location)}</p>"
    if ev.description and kind != "cancel":
        rows += f"<p style=\"margin:12px 0;white-space:pre-wrap\">{e(ev.description[:1500])}</p>"
    buttons = ""
    if kind != "cancel":
        buttons = "<p style=\"margin:20px 0 8px\">Will you come?</p><p>" + "".join(
            f"<a href=\"{e(link)}?a={key}\" style=\"display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:999px;"
            f"background:{'#c2410c' if key == 'going' else '#ffffff'};color:{'#ffffff' if key == 'going' else '#1c1917'};"
            f"border:1px solid #d6d3d1;text-decoration:none;font-weight:600\">{label}</a>"
            for key, label in answers
        ) + "</p>"
    html_body = (
        "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;background:#fafaf7;margin:0;padding:24px;color:#1c1917\">"
        "<div style=\"max-width:520px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:24px\">"
        f"<p style=\"font-size:15px;margin:0 0 12px\">{e(intro)}</p>"
        f"<h2 style=\"font-size:20px;margin:0 0 12px\">{e(title)}</h2>{rows}{buttons}"
        "<p style=\"font-size:12px;color:#78716c;margin-top:20px\">Sent from Promptly.</p></div></body></html>"
    )
    return subject, text_body, html_body


async def prune_room_sent(db: AsyncSession) -> None:
    await db.execute(delete(CalRoomReminderSent).where(CalRoomReminderSent.sent_at < core.now() - timedelta(days=30)))

