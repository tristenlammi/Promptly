"""What today holds, across Promptly, for one person — in their own time zone.

:func:`build` is the whole Today page in one call (and what the morning push
reads). Each section is there only when the person uses that part of
Promptly (a Tasks app, a habit list, a meal plan…); each item links into its
app. Everything here is the person's own or shared with them the usual way —
other people's events, rooms and photos never appear, rooms show only names
and unread counts (never message text), and free/busy-only calendars,
hidden events and ones you said no to are left out.

Queries stay cheap: each app's one file is read once, events for one day,
photos with a LIMIT.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.today")

UTC = timezone.utc
MAX_LIST = 12
SLOT_ORDER = {"breakfast": 0, "lunch": 1, "dinner": 2, "snack": 3}


def zone_of(user: User) -> ZoneInfo:
    from app.items.service import zone_for

    return zone_for(user)


def day_bounds(day: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """[local midnight, next local midnight) as UTC instants."""
    start = datetime.combine(day, time(0, 0), tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), time(0, 0), tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


def first_name(user: User) -> str:
    raw = str((user.settings or {}).get("display_name") or user.username or "").strip()
    name = raw.split()[0] if raw else ""
    return name[:1].upper() + name[1:] if name else ""


def greeting(now: datetime, user: User) -> str:
    h = now.hour
    part = "morning" if 4 <= h < 12 else "afternoon" if 12 <= h < 18 else "evening"
    name = first_name(user)
    return f"Good {part}, {name}" if name else f"Good {part}"


def item_url(kind: str, file_id: uuid.UUID | str, extra: str = "") -> str:
    return f"/apps/{kind}/{file_id}{extra}"


# ------------------------------------------------------------------ events


async def events_on(db: AsyncSession, user: User, day: date, tz: ZoneInfo, limit: int = 50) -> list[dict]:
    """Your events on ``day`` — not free/busy-only ones (someone else's
    time), not hidden ones (``occurrences_out`` drops those), not ones you
    declined."""
    from app.calendars import core as cal

    start, end = day_bounds(day, tz)
    events = await cal.visible_events(db, user, start, end)
    out = []
    for o in await cal.occurrences_out(db, user, events, start, end):
        if o.get("busy_only") or o.get("my_status") == "declined":
            continue
        out.append(
            {
                "id": o["id"],
                "event_id": o["event_id"],
                "title": o["title"] or "Untitled event",
                "start": o["start"],
                "end": o["end"],
                "all_day": o["all_day"],
                "location": o.get("location") or "",
                "color": o.get("color"),
                "url": f"/calendar?event={o['event_id']}",
            }
        )
    # All-day first, then by time.
    out.sort(key=lambda e: (not e["all_day"], e["start"]))
    return out[:limit]


async def has_calendar(db: AsyncSession, user: User) -> bool:
    from app.calendars.models import CalAttendee, CalMember

    q = select(CalMember.calendar_id).where(CalMember.user_id == user.id).limit(1)
    if (await db.execute(q)).first():
        return True
    q2 = select(CalAttendee.event_id).where(CalAttendee.user_id == user.id).limit(1)
    return (await db.execute(q2)).first() is not None


def local_clock(iso: str, tz: ZoneInfo) -> str:
    """``HH:MM`` in ``tz`` of a client ISO instant (``…Z``)."""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(tz).strftime("%H:%M")
    except ValueError:
        return ""


# ------------------------------------------------------------------ photos


async def photos_where(db: AsyncSession, user: User, conds: list, limit: int) -> tuple[int, list[dict]]:
    """Your own library's photos matching ``conds`` (count, first ``limit``
    with fresh thumbnail links) — never shared or family ones."""
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset
    from app.photos.router import _item

    where = [in_library(user.id), PhotoAsset.archived_at.is_(None), *conds]
    total = (
        await db.execute(select(func.count()).select_from(PhotoAsset).join(UserFile, UserFile.id == PhotoAsset.file_id).where(*where))
    ).scalar_one()
    if not total:
        return 0, []
    rows = (
        await db.execute(
            select(PhotoAsset, UserFile, FileMedia)
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(*where)
            .order_by(PhotoAsset.quality.desc().nulls_last(), PhotoAsset.taken_local)
            .limit(limit)
        )
    ).all()
    items = [_item(a, r, m, user) for a, r, m in rows]
    items.sort(key=lambda i: i["taken_local"])
    return int(total), items


async def on_this_day(db: AsyncSession, user: User, today: date, limit: int = 6) -> dict | None:
    """Photos taken on today's date in earlier years."""
    from app.photos.models import PhotoAsset

    conds = [
        extract("month", PhotoAsset.taken_local) == today.month,
        extract("day", PhotoAsset.taken_local) == today.day,
        extract("year", PhotoAsset.taken_local) < today.year,
    ]
    total, items = await photos_where(db, user, conds, limit)
    if not total:
        return None
    years = sorted({int(i["taken_local"][:4]) for i in items}, reverse=True)
    return {"count": total, "items": items, "years": years, "url": "/photos"}


async def photos_taken_on(db: AsyncSession, user: User, day: date, limit: int = 24) -> tuple[int, list[dict]]:
    """Your photos taken on ``day`` (their local wall clock)."""
    from app.photos.models import PhotoAsset

    start = datetime.combine(day, time(0, 0))
    conds = [PhotoAsset.taken_local >= start, PhotoAsset.taken_local < start + timedelta(days=1)]
    return await photos_where(db, user, conds, limit)


# ------------------------------------------------------------------ items (pure)


def tasks_section(file_id: uuid.UUID, data: dict, today: date) -> dict:
    from app.items.kinds.tasks import logic as L

    b = L.buckets(data, today)

    def brief(t: dict) -> dict:
        return {
            "id": t["id"],
            "title": t["title"],
            "due": t.get("due"),
            "time": t.get("time"),
            "priority": t.get("priority", 0),
            "list": L.list_name(data, t.get("list_id", "inbox")) if t.get("list_id", "inbox") != "inbox" else "",
        }

    return {
        "file_id": str(file_id),
        "url": item_url("tasks", file_id),
        "overdue_count": len(b["overdue"]),
        "today_count": len(b["today"]),
        "overdue": [brief(t) for t in b["overdue"][:MAX_LIST]],
        "today": [brief(t) for t in b["today"][:MAX_LIST]],
    }


def habits_section(file_id: uuid.UUID, data: dict, now: datetime) -> dict | None:
    from app.items.kinds.habits import engine as E

    s = data.get("settings") or {}
    today = E.logical_today(now, int(s.get("day_ends_at") or 0))
    week_start = int(s.get("week_start") or 0)
    out = []
    for h in E.active(data):
        try:
            st = E.today_status(h, today, week_start)
        except Exception:  # noqa: BLE001 — one odd habit mustn't hide the rest
            logger.exception("habit today_status failed")
            continue
        if st.get("skipped") or not (st.get("due") or st.get("done")):
            continue
        out.append(
            {
                "id": h["id"],
                "name": h["name"],
                "emoji": h.get("emoji", ""),
                "color": h.get("color"),
                "type": h.get("type", "yes_no"),
                "target": h.get("target", 1),
                "unit": h.get("unit", ""),
                "done": bool(st.get("done")),
                "value": st.get("value", 0),
            }
        )
    if not out:
        return None
    return {
        "file_id": str(file_id),
        "url": item_url("habits", file_id),
        "day": today.isoformat(),
        "habits": out,
        "left": sum(1 for h in out if not h["done"]),
    }


def workout_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    d = today.isoformat()
    sessions = [s for s in data.get("planned", []) if s.get("date") == d and s.get("status") in ("planned", "done")]
    if not sessions:
        return None
    sessions.sort(key=lambda s: s.get("time") or "99:99")
    return {
        "file_id": str(file_id),
        "url": item_url("workout", file_id),
        "sessions": [
            {
                "id": s["id"],
                "name": s.get("name") or "Workout",
                "time": s.get("time"),
                "status": s.get("status", "planned"),
                "exercises": len(s.get("exercises") or []),
            }
            for s in sessions
        ],
    }


def meals_section(file_id: uuid.UUID, data: dict, today: date) -> dict | None:
    d = today.isoformat()
    recipes = {r["id"]: r for r in data.get("recipes", [])}
    entries = [e for e in data.get("plan", []) if e.get("date") == d]
    if not entries:
        return None
    entries.sort(key=lambda e: SLOT_ORDER.get(e.get("slot", "dinner"), 9))
    out = []
    for e in entries:
        r = recipes.get(e.get("recipe_id") or "")
        out.append(
            {
                "id": e["id"],
                "slot": e.get("slot", "dinner"),
                "title": e.get("title") or (r["title"] if r else "") or "Meal",
                "cooked": bool(e.get("cooked")),
                "leftovers": bool(e.get("leftovers_of")),
            }
        )
    return {"file_id": str(file_id), "url": item_url("mealplan", file_id), "meals": out}


async def _primary(db: AsyncSession, user: User, kind: str):  # noqa: ANN202
    from app.items import service

    try:
        found = await service.primary_file(db, user, kind)
    except Exception:  # noqa: BLE001
        logger.exception("reading %s for today failed", kind)
        return None
    if found is None:
        return None
    _row, doc = found
    await service.upgrade(db, doc)
    return found


# ------------------------------------------------------------------ rooms


async def rooms_unread(db: AsyncSession, user: User, limit: int = 8) -> dict | None:
    """Rooms with unread messages — names and counts only, never what was
    said. Muted rooms (and spaces) and hidden DMs are left out, the same
    rule as the app badge."""
    from app.rooms.models import Room, RoomMember, RoomSpace, RoomSpaceMember

    levels = {
        sm.space_id: sm.notify
        for sm in (await db.execute(select(RoomSpaceMember).where(RoomSpaceMember.user_id == user.id))).scalars()
    }
    states = {m.room_id: m for m in (await db.execute(select(RoomMember).where(RoomMember.user_id == user.id))).scalars()}
    dm_ids = [rid for rid, m in states.items() if not m.hidden]
    if not levels and not dm_ids:
        return None
    q = select(Room).where(Room.space_id.in_(list(levels)) | (Room.space_id.is_(None) & Room.id.in_(dm_ids)))
    hits: list[tuple[Room, int]] = []
    for r in (await db.execute(q)).scalars():
        st = states.get(r.id)
        level = (st.notify if st and st.notify else None) or (levels.get(r.space_id) if r.space_id else None) or "all"
        if level == "none":
            continue
        n = max(0, r.last_seq - (st.last_read_seq if st else 0))
        if n:
            hits.append((r, n))
    if not hits:
        return {"total": 0, "rooms": [], "url": "/rooms"}
    hits.sort(key=lambda x: x[0].last_message_at or datetime.min.replace(tzinfo=UTC), reverse=True)
    shown = hits[:limit]
    space_ids = {r.space_id for r, _ in shown if r.space_id}
    spaces = (
        {s.id: s.name for s in (await db.execute(select(RoomSpace).where(RoomSpace.id.in_(space_ids)))).scalars()}
        if space_ids
        else {}
    )
    # DMs and unnamed groups are named for the other people in them.
    nameless = [r.id for r, _ in shown if r.space_id is None]
    others: dict[uuid.UUID, list[str]] = {}
    if nameless:
        rows = (
            await db.execute(
                select(RoomMember.room_id, User.username)
                .join(User, User.id == RoomMember.user_id)
                .where(RoomMember.room_id.in_(nameless), RoomMember.user_id != user.id)
            )
        ).all()
        for rid, uname in rows:
            others.setdefault(rid, []).append(uname)
    out = []
    for r, n in shown:
        if r.space_id:
            name, where = r.name or "Room", spaces.get(r.space_id, "")
        else:
            people = sorted(others.get(r.id, []))
            name = r.name or (", ".join(people[:3]) + (f" +{len(people) - 3}" if len(people) > 3 else "")) or "Direct message"
            where = "Direct message" if r.kind == "dm" else "Group"
        out.append({"id": str(r.id), "name": name, "where": where, "dm": r.space_id is None, "unread": n, "url": f"/rooms/r/{r.id}"})
    return {"total": sum(n for _, n in hits), "rooms": out, "url": "/rooms"}


# ------------------------------------------------------------------ workspaces


async def work_section(db: AsyncSession, user: User, today: date, tz: ZoneInfo) -> dict | None:
    """Your open workspace cards (overdue, then due soonest, then undated),
    today's shifts and the week's coming ones — what the My work page held."""
    from app.workspaces.router import _my_shifts, my_work

    try:
        cards = (await my_work(db=db, user=user)).cards
        week = await _my_shifts(db, user, days=8)
    except Exception:  # noqa: BLE001
        logger.exception("my work for today failed")
        return None
    shifts = [s for s in week if s.date == today.isoformat()]
    upcoming = [s for s in week if s.date > today.isoformat()][:5]
    if not cards and not shifts and not upcoming:
        return None

    def due_day(c) -> date | None:  # noqa: ANN001
        if c.due_at is None:
            return None
        d = c.due_at if c.due_at.tzinfo else c.due_at.replace(tzinfo=UTC)
        return d.astimezone(tz).date()

    due = [c for c in cards if (due_day(c) or date.max) <= today]
    cards = sorted(cards, key=lambda c: due_day(c) or date.max)

    def shift(s) -> dict:  # noqa: ANN001
        return {
            "date": s.date,
            "workspace": s.workspace_title,
            "roster": s.roster_title,
            "start": s.start,
            "end": s.end,
            "hours": s.hours,
            "note": s.note,
            "url": f"/workspaces/{s.workspace_id}?item={s.roster_item_id}",
        }

    return {
        "open_count": len(cards),
        "due_count": len(due),
        "url": "/workspaces",
        "cards": [
            {
                "id": str(c.id),
                "title": c.title,
                "workspace": c.workspace_title,
                "board": c.board_title,
                "due": due_day(c).isoformat() if due_day(c) else None,
                "overdue": (due_day(c) or date.max) < today,
                "url": f"/workspaces/{c.workspace_id}?item={c.board_item_id}&card={c.id}" if c.board_item_id else f"/workspaces/{c.workspace_id}",
            }
            for c in cards[:30]
        ],
        "shifts": [shift(s) for s in shifts],
        "upcoming": [shift(s) for s in upcoming],
    }


# ------------------------------------------------------------------ the page


async def build(db: AsyncSession, user: User, now: datetime | None = None, *, photos: bool = True) -> dict[str, Any]:
    """Everything for the Today page. ``now`` defaults to the person's own
    "now"; sections they don't use are absent."""
    tz = zone_of(user)
    now = (now or datetime.now(UTC)).astimezone(tz)
    today = now.date()
    out: dict[str, Any] = {
        "date": today.isoformat(),
        "tz": str(tz),
        "now": now.isoformat(),
        "greeting": greeting(now, user),
        "sections": {},
    }
    sec = out["sections"]

    events = await events_on(db, user, today, tz)
    if events or await has_calendar(db, user):
        sec["events"] = {"events": events, "url": "/calendar"}

    found = await _primary(db, user, "tasks")
    if found:
        sec["tasks"] = tasks_section(found[0].id, found[1].data, today)
    found = await _primary(db, user, "habits")
    if found:
        h = habits_section(found[0].id, found[1].data, now)
        if h:
            sec["habits"] = h
    found = await _primary(db, user, "workout")
    if found:
        w = workout_section(found[0].id, found[1].data, today)
        if w:
            sec["workout"] = w
    found = await _primary(db, user, "mealplan")
    if found:
        m = meals_section(found[0].id, found[1].data, today)
        if m:
            sec["meals"] = m

    if photos:
        try:
            p = await on_this_day(db, user, today)
        except Exception:  # noqa: BLE001
            logger.exception("on this day for today failed")
            p = None
        if p:
            sec["photos"] = p

    r = await rooms_unread(db, user)
    if r and r["total"]:
        sec["rooms"] = r
    w = await work_section(db, user, today, tz)
    if w:
        sec["work"] = w
    return out


__all__ = [
    "build", "day_bounds", "events_on", "greeting", "local_clock", "on_this_day", "photos_taken_on",
    "rooms_unread", "tasks_section", "habits_section", "workout_section", "meals_section", "zone_of",
]
