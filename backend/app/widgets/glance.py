"""What the phone's at-a-glance widgets show (``GET /api/widgets/glance``).

One call for every widget that isn't Agenda, Tasks, Notes or Photo: the app
panel's counts, Today, Meals & Macros, Rooms and Porch, P Maps, who's on
their way, Health and Mail. Built from what the Today page and the sidebar's
count badges already work out, so the numbers match what Promptly shows.

Only the caller's own things, as everywhere: no other person's data beyond
what Today already shows them (a Rooms name, a Porch author, someone sharing
a trip with them). Nothing from the Passwords vault. Each section is worked
out on its own: one that fails is left out, it never fails the others.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.widgets")

SECTIONS = ("counts", "today", "macros", "social", "maps", "trips", "health", "mail")
#: Sections that come from the Today page's own sections.
_FROM_TODAY = {"counts", "today", "macros", "social", "maps", "health", "mail"}
HOME_WORK_CACHE_S = 600
#: Closer than this to Home or Work: "You're here" rather than a drive time.
HERE_KM = 0.3


def _clock(dt: datetime, tz: Any) -> str:
    return dt.astimezone(tz).strftime("%I:%M %p").lstrip("0").lower()


async def _day(db: AsyncSession, user: User, now: datetime) -> dict[str, Any]:
    from app.today import core, hub

    day = await core.build(db, user, now, photos=False)
    try:
        await hub.extend(db, user, day)
    except Exception:  # noqa: BLE001 — what core made still fills most widgets
        logger.exception("widgets glance: the hub's sections failed")
    return day


def _events_left(sec: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    out = []
    for e in (sec.get("events") or {}).get("events") or []:
        if e.get("all_day"):
            continue
        try:
            end = datetime.fromisoformat(str(e.get("end") or e.get("start")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if end > now:
            out.append(e)
    return out


async def counts(db: AsyncSession, user: User, sec: dict[str, Any], now: datetime) -> dict[str, int]:
    """The app panel's badges: the sidebar's own numbers, plus events still
    to come today on P Calendar."""
    from app.badges import collect

    out = await collect(db, user)
    if "events" in sec:
        out["calendar"] = len(_events_left(sec, now))
    return out


def today(sec: dict[str, Any], day: dict[str, Any], now: datetime, tz: Any, weather: str | None) -> dict[str, Any]:
    nxt = None
    left = _events_left(sec, now)
    upcoming = []
    for e in left:
        try:
            start = datetime.fromisoformat(str(e["start"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        upcoming.append((start, e))
    if upcoming:
        start, e = min(upcoming, key=lambda x: x[0])
        nxt = {"title": e.get("title") or "Event", "time": _clock(start, tz), "now": start <= now, "url": "/calendar"}
        going = (sec.get("maps") or {}).get("next")
        if going and going.get("title") == nxt["title"]:
            nxt["leave_by"] = going.get("leave_by_label")
            nxt["minutes"] = going.get("minutes")
    tasks = sec.get("tasks") or {}
    births = [str(x.get("name"))[:40] for x in (sec.get("people") or {}).get("dates") or [] if x.get("kind") == "birthday" and x.get("in_days") == 0]
    for b in (sec.get("porch") or {}).get("birthdays") or []:
        name = ((b.get("user") or {}).get("name") or (b.get("user") or {}).get("username") or "")[:40]
        if name and name not in births:
            births.append(name)
    return {
        "greeting": day.get("greeting") or "",
        "date": day.get("date"),
        "weather": weather,
        "next": nxt,
        "events_left": len(left),
        "tasks_due": int(tasks.get("today_count") or 0),
        "tasks_overdue": int(tasks.get("overdue_count") or 0),
        "birthdays": births[:4],
        "url": "/today",
    }


def macros(sec: dict[str, Any]) -> dict[str, Any] | None:
    n = sec.get("nutrition")
    if not n:
        return None
    protein = next((m for m in n.get("macros") or [] if m.get("key") == "protein"), {})
    return {
        "kcal": n.get("kcal") or 0,
        "kcal_target": n.get("kcal_target"),
        "protein": protein.get("value") or 0,
        "protein_target": protein.get("target"),
        "entries": n.get("entries") or 0,
        "url": n.get("url"),
        "ask_url": f"{n.get('url')}?tab=ask" if n.get("url") else None,
    }


def social(sec: dict[str, Any]) -> dict[str, Any]:
    rooms = sec.get("rooms") or {}
    porch = (sec.get("porch") or {}).get("new_posts") or {}
    thumbs = porch.get("thumbs") or []
    return {
        "rooms": {
            "unread": int(rooms.get("total") or 0),
            "items": [
                {"name": r.get("name"), "where": r.get("where"), "unread": r.get("unread"), "url": r.get("url")}
                for r in (rooms.get("rooms") or [])[:4]
            ],
        },
        "porch": {
            "new": int(porch.get("count") or 0),
            "from": porch.get("from") or [],
            "thumb": thumbs[0]["thumb"] if thumbs else None,
            "url": thumbs[0]["url"] if thumbs else "/porch",
        },
    }


async def _drive_minutes(db: AsyncSession, user: User, start: dict[str, float], place: Any) -> dict[str, Any] | None:
    """Minutes to a saved place in current traffic, kept for a while (the
    widget asks every half hour; the road doesn't need asking that often)."""
    from app.maps import traffic
    from app.maps.planning import plan
    from app.redis_client import redis

    key = f"widgets:drive:{user.id}:{place.id}:{round(start['lat'], 2)},{round(start['lon'], 2)}"
    try:
        held = await redis.get(key)
        if held:
            return json.loads(held) or None
    except Exception:  # noqa: BLE001 — without the cache it's just slower
        pass
    try:
        route = (await plan(db, user, [start, {"lat": place.lat, "lon": place.lon, "name": place.name}], "drive", pins=False, warnings=False, alternates=0))["routes"][0]
        out = {"minutes": max(1, round(traffic.travel_seconds(route) / 60)), "km": round(route["km"], 1), "traffic": bool(route.get("traffic"))}
    except Exception:  # noqa: BLE001 — the map isn't running, or no road there
        logger.info("widgets glance: no drive time to %s", place.kind)
        out = None
    try:
        await redis.set(key, json.dumps(out or {}), ex=HOME_WORK_CACHE_S)
    except Exception:  # noqa: BLE001
        pass
    return out


def _km(a: dict[str, float], lat: float, lon: float) -> float:
    from math import asin, cos, radians, sin, sqrt

    dlat, dlon = radians(lat - a["lat"]), radians(lon - a["lon"])
    h = sin(dlat / 2) ** 2 + cos(radians(a["lat"])) * cos(radians(lat)) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


async def maps(db: AsyncSession, user: User, sec: dict[str, Any], now: datetime) -> dict[str, Any]:
    from app.maps.models import MapPlace
    from app.maps.today import origin

    places = {p.kind: p for p in (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id, MapPlace.kind.in_(("home", "work"))))).scalars()}
    start = await origin(db, user, now)
    out: dict[str, Any] = {"places": [], "next": None}
    for kind in ("home", "work"):
        p = places.get(kind)
        if p is None:
            continue
        row: dict[str, Any] = {"kind": kind, "name": "Home" if kind == "home" else "Work", "url": f"/maps?to={p.lat:.5f},{p.lon:.5f},{'Home' if kind == 'home' else 'Work'}"}
        if start is None:
            row["minutes"] = None
        elif _km(start, p.lat, p.lon) < HERE_KM:
            row["here"] = True
        else:
            row.update(await _drive_minutes(db, user, start, p) or {"minutes": None})
        out["places"].append(row)
    going = (sec.get("maps") or {}).get("next")
    if going:
        out["next"] = {k: going.get(k) for k in ("title", "minutes", "leave_by_label", "soon", "traffic", "url")}
    return out


async def trips(db: AsyncSession, user: User, now: datetime) -> list[dict[str, Any]]:
    """People sharing a trip with you right now, and when they'll get there.
    The same rows as Maps → People shows you; no position, just the ETA."""
    from sqlalchemy import or_

    from app.maps.models import MapLiveLocation, MapShare
    from app.people import blocks

    hidden = await blocks.hidden_ids(db, user.id)
    rows = (
        await db.execute(
            select(MapShare, User, MapLiveLocation)
            .join(User, User.id == MapShare.owner_id)
            .outerjoin(MapLiveLocation, MapLiveLocation.user_id == MapShare.owner_id)
            .where(MapShare.viewer_id == user.id, MapShare.trip.is_(True), or_(MapShare.expires_at.is_(None), MapShare.expires_at > now))
        )
    ).all()
    out = []
    for _s, u, live in rows:
        if u.id in hidden or live is None:
            continue
        eta = live.eta if live.eta is not None and live.eta.tzinfo is not None else None
        out.append(
            {
                "user_id": str(u.id),
                "name": u.username,
                "destination": live.destination,
                "eta": eta.isoformat() if eta else None,
                "minutes": max(0, round((eta - now).total_seconds() / 60)) if eta else None,
                "seen": live.at.isoformat() if live.at else None,
                "url": "/maps",
            }
        )
    out.sort(key=lambda r: r["minutes"] if r["minutes"] is not None else 10**6)
    return out[:4]


async def health(db: AsyncSession, user: User, sec: dict[str, Any], today: date) -> dict[str, Any] | None:
    from app.today.core import _primary, item_url

    h = sec.get("health")
    out: dict[str, Any] = {}
    if h:
        out.update(
            {
                "weight": h.get("weight"),
                "weight_day": h.get("weight_day"),
                "unit": h.get("weight_unit") or "kg",
                "series": h.get("weight_series") or [],
                "change": h.get("weight_change"),
                "url": h.get("url"),
            }
        )
    found = await _primary(db, user, "workout")
    if found:
        planned = sorted(
            (s for s in (found[1].data or {}).get("planned", []) if s.get("status") == "planned" and str(s.get("date") or "") >= today.isoformat()),
            key=lambda s: (s.get("date") or "", s.get("time") or "99:99"),
        )
        if planned:
            s = planned[0]
            out["workout"] = {"name": s.get("name") or "Workout", "date": s.get("date"), "time": s.get("time"), "url": item_url("workout", found[0].id)}
    return out or None


async def mail(db: AsyncSession, user: User, sec: dict[str, Any]) -> dict[str, Any] | None:
    from app.mail.router import _NOT_SNOOZED_M, _my_account_ids

    accounts = await _my_account_ids(db, user)
    if not accounts:
        return None
    m = sec.get("mail") or {}
    rows = (
        await db.execute(
            text(
                "SELECT * FROM (SELECT DISTINCT ON (m.account_id, m.thread_key) m.account_id, m.thread_key, m.from_name, m.from_addr, m.subject, m.sent_at "
                "FROM mail_messages m JOIN mail_folders f ON f.id = m.folder_id "
                f"WHERE m.account_id = ANY(:accounts) AND f.role = 'inbox' AND NOT m.seen AND {_NOT_SNOOZED_M} "
                "ORDER BY m.account_id, m.thread_key, m.sent_at DESC) t ORDER BY t.sent_at DESC LIMIT 4"
            ),
            {"accounts": accounts},
        )
    ).all()
    from app.mail.apps import inbox_unread

    unread = int(m.get("unread") if m.get("unread") is not None else await inbox_unread(db, accounts))
    return {
        "unread": unread,
        "items": [
            {"from": (r.from_name or r.from_addr or "Someone")[:60], "subject": (r.subject or "(No subject)")[:120], "url": f"/mail?open={r.account_id}/{r.thread_key}"}
            for r in rows
        ],
        "url": "/mail",
    }


async def build(db: AsyncSession, user: User, want: list[str], now: datetime | None = None) -> dict[str, Any]:
    from app.today import core, weather

    tz = core.zone_of(user)
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    out: dict[str, Any] = {"at": now.isoformat()}
    day: dict[str, Any] = {}
    if _FROM_TODAY & set(want):
        day = await _day(db, user, now)
    sec = day.get("sections") or {}

    async def part(key: str, make: Any) -> None:
        if key not in want:
            return
        try:
            async with db.begin_nested():
                value = await make()
        except Exception:  # noqa: BLE001 — one widget's trouble costs only its section
            logger.exception("widgets glance: %s failed", key)
            return
        if value is not None:
            out[key] = value

    async def _today() -> dict[str, Any]:
        try:
            line = await weather.line(db, user, now)
        except Exception:  # noqa: BLE001
            line = None
        return today(sec, day, now, tz, line)

    async def _macros() -> dict[str, Any] | None:
        return macros(sec)

    async def _social() -> dict[str, Any]:
        return social(sec)

    await part("counts", lambda: counts(db, user, sec, now))
    await part("today", _today)
    await part("macros", _macros)
    await part("social", _social)
    await part("maps", lambda: maps(db, user, sec, now))
    await part("trips", lambda: trips(db, user, now))
    await part("health", lambda: health(db, user, sec, now.date()))
    await part("mail", lambda: mail(db, user, sec))
    return out


async def people(db: AsyncSession, user: User, q: str) -> list[dict[str, Any]]:
    """Who the Favourite people widget can show: people on this Promptly from
    the people picker (your contacts first), never anyone you've blocked or
    who blocked you. Names only."""
    import uuid

    from app.people import blocks
    from app.people.router import search

    found = await search(q=q, details=False, db=db, viewer=user)
    hidden = await blocks.hidden_ids(db, user.id)
    out = []
    for row in found["people"]:
        u = row.get("user")
        if not u or uuid.UUID(str(u["id"])) in hidden or str(u["id"]) == str(user.id):
            continue
        out.append({"user_id": str(u["id"]), "name": row.get("name") or u.get("username"), "username": u.get("username")})
    return out[:30]
