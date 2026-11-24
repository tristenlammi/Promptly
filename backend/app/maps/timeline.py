"""Your timeline and live location sharing (``/api/maps``).

The phone sends positions; a day's stays and journeys are worked out from them
when you look, so deleting points really does delete the history. A timeline
is only ever its owner's. Live location goes only to the people you chose, for
as long as you chose, and its row is removed when nobody's left to see it.

"Share this trip" is the same thing for one drive: the people you pick are
told, see where you are and when you'll arrive, and stop seeing it when the
trip ends (or a while after its arrival time, if the phone never says so).

Silence is never silent. The phone checks in (``/phone/checkin``, and every
upload counts), so the server knows when it last heard from it and says so:
the timeline panel when recording is on but nothing has come, the person
sharing when their phone stopped sending, and everyone watching sees how old
a position is. What the phone said about itself (times, a problem's name, a
count) is kept in ``users.settings.maps.phone``; never a position."""
from __future__ import annotations

import math
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.notifications import notify_user
from app.people import blocks

from . import data, engine
from .models import MapLiveLocation, MapPlace, MapShare, MapTrackPoint
from .router import maps_user

router = APIRouter()

STAY_METRES = 120.0
STAY_MINUTES = 5
MAX_BATCH = 5000
# Rows per INSERT: seven values each, and Postgres takes 32,767 in one statement.
INSERT_ROWS = 2000

# A live position: fresh for five minutes, "last seen" up to half an hour, then stale.
LIVE_FRESH_S = 5 * 60
LIVE_STALE_S = 30 * 60
# Someone sharing whose phone has sent nothing for this long is told.
LIVE_STALLED = timedelta(minutes=10)
# Recording is on and the phone hasn't been heard from for this long: say so.
PHONE_QUIET = timedelta(hours=3)
# What a phone can say is wrong with it. Names only, never free text.
PROBLEMS = ("permission", "background", "location_off", "blocked", "signed_out", "no_signal", "server")


def timeline_settings(user: User) -> dict[str, Any]:
    raw = (user.settings or {}).get("maps") or {}
    return {"timeline_on": bool(raw.get("timeline_on", False)), "retention_days": raw.get("retention_days")}


def _zone(user: User, name: str | None = None) -> ZoneInfo:
    """The person's time zone: the one they saved, else the one the page
    they're looking at is in (``name``), else UTC."""
    for zone in ((user.settings or {}).get("timezone"), name):
        if not zone:
            continue
        try:
            return ZoneInfo(str(zone))
        except Exception:  # noqa: BLE001 — a bad zone isn't worth a failed page
            continue
    return ZoneInfo("UTC")


# ---- What the phone last said -------------------------------------------------


def _when(raw: Any) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(raw)) if raw else None
    except ValueError:
        return None
    return at if at is None or at.tzinfo else at.replace(tzinfo=timezone.utc)


def phone_state(user: User) -> dict[str, Any]:
    """What this person's phone last said about itself (never a position)."""
    raw = ((user.settings or {}).get("maps") or {}).get("phone") or {}
    return raw if isinstance(raw, dict) else {}


async def note_phone(db: AsyncSession, user_id: uuid.UUID, **fields: Any) -> None:
    """Remember what the phone said. One statement that touches only
    ``settings.maps.phone``, so it can't undo a setting saved at the same
    moment by something else. The caller commits."""
    import json

    patch = {k: v.isoformat() if isinstance(v, datetime) else v for k, v in fields.items()}
    await db.execute(
        text(
            "UPDATE users SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{maps}', "
            "coalesce(settings->'maps', '{}'::jsonb) || jsonb_build_object('phone', "
            "coalesce(settings->'maps'->'phone', '{}'::jsonb) || CAST(:patch AS jsonb))) WHERE id = :id"
        ),
        {"patch": json.dumps(patch), "id": user_id},
    )


def freshness(at: datetime | None, now: datetime) -> tuple[int | None, str]:
    """How old a position is, in seconds and in a word: ``fresh`` (a few
    minutes), ``late`` (last seen a while ago), ``stale`` (the phone has gone
    quiet), ``waiting`` (nothing yet)."""
    if at is None:
        return None, "waiting"
    age = max(0, int((now - at).total_seconds()))
    return age, "fresh" if age <= LIVE_FRESH_S else "late" if age <= LIVE_STALE_S else "stale"


async def _phone_report(db: AsyncSession, user: User, now: datetime) -> dict[str, Any]:
    """For the timeline panel: when the phone was last heard from, and whether
    that's too long ago for a recording that's switched on."""
    phone = phone_state(user)
    last_point = (
        await db.execute(select(func.max(MapTrackPoint.at)).where(MapTrackPoint.user_id == user.id, MapTrackPoint.source == "phone"))
    ).scalar_one_or_none()
    seen = _when(phone.get("seen_at"))
    heard = max([t for t in (seen, _when(phone.get("points_at"))) if t is not None], default=None)
    on = timeline_settings(user)["timeline_on"]
    return {
        "seen_at": seen.isoformat() if seen else None,
        "points_at": phone.get("points_at"),
        "last_point_at": last_point.isoformat() if last_point else None,
        # Nothing heard for a while (or ever) with recording on.
        "quiet": bool(on and (heard is None or now - heard > PHONE_QUIET)),
        "recording": phone.get("recording"),
        "waiting": phone.get("waiting"),
        "problem": phone.get("problem") if phone.get("problem") in PROBLEMS else None,
    }


# ---- Settings ---------------------------------------------------------------


class SettingsBody(BaseModel):
    timeline_on: bool | None = None
    # How long to keep positions; None keeps them until you delete them.
    retention_days: int | None = Field(default=None, ge=1, le=36500)


@router.get("/timeline/settings")
async def get_settings(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    return {**timeline_settings(user), "phone": await _phone_report(db, user, datetime.now(timezone.utc))}


@router.put("/timeline/settings")
async def put_settings(body: SettingsBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    current = timeline_settings(user)
    changes = body.model_dump(exclude_unset=True)
    current.update(changes)
    # Whatever else is kept under "maps" (what the phone last said) stays.
    kept = (user.settings or {}).get("maps") or {}
    user.settings = {**(user.settings or {}), "maps": {**kept, **current}}
    await db.commit()
    return current


class CheckIn(BaseModel):
    """The phone saying it's there, and how it's going. No position."""

    # Whether its background service is running right now.
    recording: bool | None = None
    # Positions waiting on the phone to be sent.
    waiting: int | None = Field(default=None, ge=0, le=10_000_000)
    problem: str | None = Field(default=None, max_length=20)
    app: str | None = Field(default=None, max_length=20, pattern=r"^[0-9A-Za-z.\-]+$")


async def _share_ends(db: AsyncSession, user_id: uuid.UUID, now: datetime) -> tuple[bool, bool, datetime | None]:
    """(sharing, a trip among them, when the last share ends or None for "until you stop")."""
    rows = (await db.execute(select(MapShare.expires_at, MapShare.trip).where(MapShare.owner_id == user_id, _active(now)))).all()
    if not rows:
        return False, False, None
    until = None if any(e is None for e, _t in rows) else max(e for e, _t in rows)
    return True, any(t for _e, t in rows), until


@router.post("/phone/checkin")
async def phone_checkin(body: CheckIn, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """The phone asks what's wanted of it (record the timeline? send where
    it is to someone?) and says how it's going. This is how a share started
    on another device reaches the phone, and how the server knows the phone
    is still there."""
    now = datetime.now(timezone.utc)
    on = timeline_settings(user)["timeline_on"]
    await _forget_if_unshared(db, user.id)
    sharing, trip, until = await _share_ends(db, user.id, now)
    fields: dict[str, Any] = {"seen_at": now, "problem": body.problem if body.problem in PROBLEMS else None}
    for key in ("recording", "waiting", "app"):
        if getattr(body, key) is not None:
            fields[key] = getattr(body, key)
    await note_phone(db, user.id, **fields)
    await db.commit()
    return {"timeline_on": on, "sharing": sharing, "trip": trip, "until": until.isoformat() if until else None}


# ---- Recording --------------------------------------------------------------


class Point(BaseModel):
    at: datetime
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: float | None = None
    speed: float | None = None

    @field_validator("accuracy", "speed", mode="before")
    @classmethod
    def _or_nothing(cls, v: Any) -> Any:
        """An odd accuracy or speed (negative, not a number) isn't a reason to
        lose the position: it's kept without it."""
        try:
            n = float(v)
        except (TypeError, ValueError):
            return None
        return n if math.isfinite(n) and n >= 0 else None

    @field_validator("at")
    @classmethod
    def _a_real_time(cls, v: datetime) -> datetime:
        at = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        # A GPS chip with the wrong date would file the point decades away.
        if at.year < 2000 or at > datetime.now(timezone.utc) + timedelta(days=1):
            raise ValueError("not a time a phone could have been somewhere")
        return at


class PointsBody(BaseModel):
    # Looked at one by one below: a single bad row must not refuse the other
    # 999 (the phone would send the same batch for ever and never catch up).
    points: list[dict[str, Any]] = Field(max_length=MAX_BATCH)
    source: str = Field(default="phone", pattern="^(phone|google)$")


@router.post("/timeline/points")
async def add_points(body: PointsBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Positions from the phone, or a Google Timeline import in batches."""
    settings = timeline_settings(user)
    now = datetime.now(timezone.utc)
    if body.source == "phone" and not settings["timeline_on"]:
        # It was paused elsewhere: tell the phone, keep nothing.
        await note_phone(db, user.id, seen_at=now)
        await db.commit()
        return {"saved": 0, "skipped": 0, "timeline_on": False}
    rows = []
    skipped = 0
    for raw in body.points:
        try:
            p = Point.model_validate(raw)
        except ValidationError:
            skipped += 1
            continue
        rows.append({"user_id": user.id, "at": p.at, "lat": p.lat, "lon": p.lon, "accuracy": p.accuracy, "speed": p.speed, "source": body.source})
    saved = 0
    for i in range(0, len(rows), INSERT_ROWS):
        result = await db.execute(insert(MapTrackPoint).values(rows[i : i + INSERT_ROWS]).on_conflict_do_nothing(constraint="uq_map_track_user_at"))
        saved += result.rowcount or 0
    if settings["retention_days"] and body.source == "phone":
        cutoff = now - timedelta(days=settings["retention_days"])
        await db.execute(delete(MapTrackPoint).where(MapTrackPoint.user_id == user.id, MapTrackPoint.at < cutoff))
    if body.source == "phone":
        await note_phone(db, user.id, seen_at=now, points_at=now)
    await db.commit()
    return {"saved": saved, "skipped": skipped, "timeline_on": settings["timeline_on"]}


# ---- Reading a day ----------------------------------------------------------


def split_day(points: list[tuple[datetime, float, float, float | None]]) -> list[dict[str, Any]]:
    """Stays (somewhere for a while) and journeys (the bits between).
    ``points`` are (at, lat, lon, speed), oldest first."""
    out: list[dict[str, Any]] = []
    moving: list[tuple[datetime, float, float, float | None]] = []
    i, n = 0, len(points)

    def flush_move() -> None:
        if len(moving) < 2:
            moving.clear()
            return
        metres = sum(data.distance_m(a[1], a[2], b[1], b[2]) for a, b in zip(moving, moving[1:]))
        seconds = max(1.0, (moving[-1][0] - moving[0][0]).total_seconds())
        kmh = metres / seconds * 3.6
        out.append({
            "type": "move",
            "start": moving[0][0],
            "end": moving[-1][0],
            "km": round(metres / 1000, 2),
            "mode": "walk" if kmh < 7 else "cycle" if kmh < 22 else "drive",
            "line": [[p[2], p[1]] for p in moving],
        })
        moving.clear()

    while i < n:
        j = i + 1
        lat, lon = points[i][1], points[i][2]
        count = 1
        while j < n and data.distance_m(lat, lon, points[j][1], points[j][2]) <= STAY_METRES:
            # The centre settles as points come in.
            lat = (lat * count + points[j][1]) / (count + 1)
            lon = (lon * count + points[j][2]) / (count + 1)
            count += 1
            j += 1
        if (points[j - 1][0] - points[i][0]).total_seconds() >= STAY_MINUTES * 60:
            if moving:
                moving.append(points[i])
                flush_move()
            out.append({"type": "stay", "start": points[i][0], "end": points[j - 1][0], "lat": round(lat, 6), "lon": round(lon, 6)})
            i = j
            if i < n:
                moving.append(points[j - 1])
        else:
            moving.append(points[i])
            i += 1
    flush_move()
    return out


async def _name_stays(db: AsyncSession, user: User, segments: list[dict[str, Any]]) -> None:
    """A stay is named from your saved places first, then the map."""
    saved = (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id))).scalars().all()
    asked = 0
    for seg in segments:
        if seg["type"] != "stay":
            continue
        near = min(saved, key=lambda p: data.distance_m(p.lat, p.lon, seg["lat"], seg["lon"]), default=None)
        if near is not None and data.distance_m(near.lat, near.lon, seg["lat"], seg["lon"]) <= 150:
            seg["name"], seg["saved"] = near.name, True
            continue
        seg["name"] = "Somewhere"
        if asked < 20:
            asked += 1
            try:
                hits = await engine.photon("/reverse", {"lat": seg["lat"], "lon": seg["lon"], "limit": 1})
            except HTTPException:
                continue
            if hits:
                row = engine.label(hits[0])
                seg["name"], seg["address"] = row["name"], row["address"]


async def _day_photos(db: AsyncSession, user: User, day: date) -> list[dict[str, Any]]:
    from app.files import media_urls
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    rows = (
        await db.execute(
            select(PhotoAsset.file_id, FileMedia.renditions)
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .join(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(in_library(user.id), PhotoAsset.taken_local >= datetime.combine(day, time.min), PhotoAsset.taken_local < datetime.combine(day + timedelta(days=1), time.min))
            .order_by(PhotoAsset.taken_local)
            .limit(30)
        )
    ).all()
    out = []
    for file_id, renditions in rows:
        thumb = media_urls.sign_shown(file_id, user.id, user.token_version, renditions, "thumb")
        if thumb:
            out.append({"id": str(file_id), "thumb": thumb})
    return out


def clock(at: datetime) -> str:
    return at.strftime("%I:%M %p").lstrip("0").lower()


async def day_view(db: AsyncSession, user: User, day: date, *, photos: bool = True, tz_name: str | None = None) -> dict[str, Any]:
    """A day's stays and journeys, in the person's own time zone (``tz_name``:
    the zone of the page asking, for someone who never saved one; without it
    a day was cut at midnight UTC, so a morning drive in Australia showed
    under the day before). Times are datetimes here; the API sends them as text."""
    tz = _zone(user, tz_name)
    start = datetime.combine(day, time.min, tz)
    rows = (
        await db.execute(
            select(MapTrackPoint.at, MapTrackPoint.lat, MapTrackPoint.lon, MapTrackPoint.speed)
            .where(MapTrackPoint.user_id == user.id, MapTrackPoint.at >= start, MapTrackPoint.at < start + timedelta(days=1))
            .order_by(MapTrackPoint.at)
        )
    ).all()
    segments = split_day([tuple(r) for r in rows])
    await _name_stays(db, user, segments)
    for seg in segments:
        seg["start"], seg["end"] = seg["start"].astimezone(tz), seg["end"].astimezone(tz)
    pictures: list[dict[str, Any]] = []
    if photos:
        try:
            pictures = await _day_photos(db, user, day)
        except Exception:  # noqa: BLE001 — photos are a garnish on the day
            pass
    return {
        "date": day.isoformat(),
        "segments": segments,
        "points": len(rows),
        "km": round(sum(s.get("km", 0) for s in segments), 1),
        "photos": pictures,
    }


@router.get("/timeline/day")
async def timeline_day(
    day: date = Query(alias="date"), tz: str | None = Query(default=None, max_length=64),
    db: AsyncSession = Depends(get_db), user: User = Depends(maps_user),
) -> dict[str, Any]:
    view = await day_view(db, user, day, tz_name=tz)
    for seg in view["segments"]:
        seg["start"], seg["end"] = seg["start"].isoformat(), seg["end"].isoformat()
    return view


async def visits_near(
    db: AsyncSession, user: User, lat: float, lon: float, first: date | None = None, last: date | None = None, *, within_m: float = 200.0
) -> list[dict[str, datetime]]:
    """When this person was at this spot, as separate visits, newest first.
    Points more than half an hour apart are different visits."""
    tz = _zone(user)
    pad_lat = within_m / 111_000.0
    pad_lon = pad_lat / max(0.2, math.cos(math.radians(lat)))
    where = [
        MapTrackPoint.user_id == user.id,
        MapTrackPoint.lat.between(lat - pad_lat, lat + pad_lat),
        MapTrackPoint.lon.between(lon - pad_lon, lon + pad_lon),
    ]
    if first:
        where.append(MapTrackPoint.at >= datetime.combine(first, time.min, tz))
    if last:
        where.append(MapTrackPoint.at < datetime.combine(last + timedelta(days=1), time.min, tz))
    rows = (await db.execute(select(MapTrackPoint.at).where(*where).order_by(MapTrackPoint.at.desc()).limit(50_000))).scalars().all()
    visits: list[dict[str, datetime]] = []
    for at in rows:
        at = at.astimezone(tz)
        if visits and visits[-1]["start"] - at <= timedelta(minutes=30):
            visits[-1]["start"] = at
        else:
            visits.append({"start": at, "end": at})
    return visits


@router.get("/timeline/days")
async def timeline_days(
    month: str = Query(pattern=r"^\d{4}-\d{2}$"), tz: str | None = Query(default=None, max_length=64),
    db: AsyncSession = Depends(get_db), user: User = Depends(maps_user),
) -> dict[str, Any]:
    """Which days of a month have anything, for the calendar strip."""
    tz = _zone(user, tz)
    year, mon = (int(x) for x in month.split("-"))
    if not 1 <= mon <= 12 or not 1 <= year <= 9999:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That isn't a month.")
    start = datetime(year, mon, 1, tzinfo=tz)
    end = datetime(year + (mon == 12), mon % 12 + 1, 1, tzinfo=tz)
    local = func.date(func.timezone(str(tz), MapTrackPoint.at))
    rows = (
        await db.execute(select(local).where(MapTrackPoint.user_id == user.id, MapTrackPoint.at >= start, MapTrackPoint.at < end).group_by(local))
    ).scalars().all()
    return {"days": sorted(d.isoformat() for d in rows)}


@router.delete("/timeline")
async def timeline_delete(
    start: datetime | None = None,
    end: datetime | None = None,
    everything: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(maps_user),
) -> dict[str, Any]:
    """Delete a stretch of your history, or all of it. This is for good."""
    where = [MapTrackPoint.user_id == user.id]
    if not everything:
        if start is None or end is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Say what to delete.")
        where += [MapTrackPoint.at >= start, MapTrackPoint.at < end]
    result = await db.execute(delete(MapTrackPoint).where(*where))
    await db.commit()
    return {"deleted": result.rowcount or 0}


# ---- Live location ----------------------------------------------------------


def _active(now: datetime):  # noqa: ANN202
    return or_(MapShare.expires_at.is_(None), MapShare.expires_at > now)


@router.get("/share")
async def shares(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    mine = (await db.execute(select(MapShare, User).join(User, User.id == MapShare.viewer_id).where(MapShare.owner_id == user.id, _active(now)))).all()
    theirs = (
        await db.execute(
            select(MapShare, User, MapLiveLocation)
            .join(User, User.id == MapShare.owner_id)
            .outerjoin(MapLiveLocation, MapLiveLocation.user_id == MapShare.owner_id)
            .where(MapShare.viewer_id == user.id, _active(now))
        )
    ).all()
    # Someone blocked (either way) sees nothing and is shown nothing.
    hidden = await blocks.hidden_ids(db, user.id)
    mine = [(s, u) for s, u in mine if u.id not in hidden]
    theirs = [(s, u, live) for s, u, live in theirs if u.id not in hidden]

    def seen(live: MapLiveLocation) -> dict[str, Any]:
        age, state = freshness(live.at, now)
        return {
            "lat": live.lat, "lon": live.lon, "heading": live.heading, "speed": live.speed, "destination": live.destination,
            "eta": live.eta.isoformat() if live.eta else None, "at": live.at.isoformat(),
            # How old it is by this server's clock (a viewer's own clock may be off), and in a word.
            "age_s": age, "state": state,
        }

    me = None
    if mine:
        # For the person sharing: is their phone actually sending?
        sent = await db.get(MapLiveLocation, user.id)
        age, state = freshness(sent.at if sent else None, now)
        phone = phone_state(user)
        me = {
            "sent_at": sent.at.isoformat() if sent else None,
            "age_s": age,
            "state": state,
            "phone_seen_at": phone.get("seen_at"),
            "problem": phone.get("problem") if phone.get("problem") in PROBLEMS else None,
        }
    return {
        "sharing_with": [
            {"user_id": str(u.id), "name": u.username, "expires_at": s.expires_at.isoformat() if s.expires_at else None, "trip": s.trip}
            for s, u in mine
        ],
        "me": me,
        "shared_with_me": [
            {"user_id": str(u.id), "name": u.username, "trip": s.trip, "live": seen(live) if live else None}
            for s, u, live in theirs
        ],
    }


class ShareBody(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    hours: float | None = Field(default=None, gt=0, le=24 * 365)  # None: until you stop


@router.put("/share")
async def start_share(body: ShareBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    name = body.username.strip().lower()
    viewer = (
        await db.execute(select(User).where(or_(func.lower(User.username) == name, func.lower(User.email) == name), User.disabled.is_(False)))
    ).scalars().first()
    if viewer is None or viewer.id == user.id or viewer.id in await blocks.hidden_ids(db, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="There's nobody by that name on this Promptly.")
    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=body.hours) if body.hours else None
    await db.execute(
        insert(MapShare)
        .values(id=uuid.uuid4(), owner_id=user.id, viewer_id=viewer.id, expires_at=expires, trip=False, created_at=now)
        # Chosen on purpose, so it outlives a trip you were sharing with them.
        .on_conflict_do_update(constraint="uq_map_share_pair", set_={"expires_at": expires, "trip": False, "created_at": now})
    )
    # A new share: if the phone goes quiet during it, that's told afresh.
    await note_phone(db, user.id, stalled_told=None)
    until = f"until {clock(expires.astimezone(_zone(user)))}" if expires else "until you stop"
    await db.commit()
    # To your own devices: the push wakes the phone's app, which starts
    # sending. It's also the plain record that you're sharing where you are.
    await notify_user(
        user_id=user.id,
        category="maps",
        title=f"Sharing your location with {viewer.username}",
        body=f"Your phone sends where you are every couple of minutes, {until}.",
        url="/maps?panel=people",
        tag="maps-sharing",
        inbox=False,
        ttl=3600,
    )
    return {"user_id": str(viewer.id), "name": viewer.username, "expires_at": expires.isoformat() if expires else None}


async def _forget_if_unshared(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """Whether anyone can still see this person. If not, their position goes."""
    now = datetime.now(timezone.utc)
    await db.execute(delete(MapShare).where(MapShare.owner_id == user_id, and_(MapShare.expires_at.is_not(None), MapShare.expires_at <= now)))
    left = (await db.execute(select(func.count()).select_from(MapShare).where(MapShare.owner_id == user_id))).scalar_one()
    if not left:
        await db.execute(delete(MapLiveLocation).where(MapLiveLocation.user_id == user_id))
    return bool(left)


@router.delete("/share/{viewer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def stop_share(viewer_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    await db.execute(delete(MapShare).where(MapShare.owner_id == user.id, MapShare.viewer_id == viewer_id))
    await _forget_if_unshared(db, user.id)
    await db.commit()


# ---- Share this trip ---------------------------------------------------------

TRIP_GRACE = timedelta(hours=2)
TRIP_LONGEST = timedelta(hours=24)


def _trip_until(eta: datetime | None, now: datetime) -> datetime:
    """When a shared trip lapses if the phone never says it's over: a while
    after you were due, and never more than a day from now."""
    due = eta if eta is not None and eta.tzinfo is not None else now + TRIP_GRACE
    return min(max(due, now) + TRIP_GRACE, now + TRIP_LONGEST)


class TripShareBody(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    destination: str | None = Field(default=None, max_length=200)
    eta: datetime | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


async def _trip_viewers(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(User).join(MapShare, MapShare.viewer_id == User.id)
            .where(MapShare.owner_id == user_id, MapShare.trip.is_(True), _active(now)).order_by(func.lower(User.username))
        )
    ).scalars().all()
    return [{"user_id": str(u.id), "name": u.username} for u in rows]


@router.get("/trip/people")
async def trip_people(q: str = Query(default="", max_length=80), db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Who a trip can be shared with: the people picker's accounts on this
    Promptly (suggestions when blank), for the phone, which signs in with a
    maps-only password. Names only."""
    from app.people.router import search

    found = await search(q=q, details=False, db=db, viewer=user)
    hidden = await blocks.hidden_ids(db, user.id)
    people = [
        {"user_id": row["user"]["id"], "name": row["name"] or row["user"]["username"]}
        for row in found["people"]
        if row.get("user") and uuid.UUID(str(row["user"]["id"])) not in hidden
    ]
    return {"people": people}


@router.get("/trip/share")
async def trip_shared_with(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Who's watching the trip you're on."""
    return {"sharing_with": await _trip_viewers(db, user.id)}


@router.put("/trip/share")
async def share_trip(body: TripShareBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Share the trip you're driving with people on this Promptly. They're told,
    and see where you are and when you'll arrive until the trip ends. Someone
    you already share your location with keeps that as it is."""
    now = datetime.now(timezone.utc)
    hidden = await blocks.hidden_ids(db, user.id)
    wanted = [i for i in dict.fromkeys(body.user_ids) if i != user.id and i not in hidden]
    people = (await db.execute(select(User).where(User.id.in_(wanted), User.disabled.is_(False)))).scalars().all() if wanted else []
    if not people:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="There's nobody by that name on this Promptly.")
    until = _trip_until(body.eta, now)
    already = {
        row.viewer_id: row
        for row in (await db.execute(select(MapShare).where(MapShare.owner_id == user.id, MapShare.viewer_id.in_([p.id for p in people])))).scalars()
    }
    told: list[User] = []
    for person in people:
        had = already.get(person.id)
        ongoing = had is not None and not had.trip and (had.expires_at is None or had.expires_at > now)
        if not ongoing:
            await db.execute(
                insert(MapShare)
                .values(id=uuid.uuid4(), owner_id=user.id, viewer_id=person.id, expires_at=until, trip=True, created_at=now)
                .on_conflict_do_update(constraint="uq_map_share_pair", set_={"expires_at": until, "trip": True, "created_at": now})
            )
        # Told once a trip, not each time the list is sent again.
        if had is None or not had.trip or (had.expires_at is not None and had.expires_at <= now):
            told.append(person)
    if body.lat is not None and body.lon is not None:
        # Where you are now, so there's something to see before the phone's next report.
        values = {"lat": body.lat, "lon": body.lon, "heading": None, "speed": None, "destination": body.destination, "eta": body.eta, "at": now}
        await db.execute(insert(MapLiveLocation).values(user_id=user.id, **values).on_conflict_do_update(index_elements=["user_id"], set_=values))
    await db.commit()
    where = f" to {body.destination}" if body.destination else ""
    for person in told:
        await notify_user(
            user_id=person.id,
            category="maps",
            title=f"{user.username} is sharing a trip with you",
            body=f"See where they are on the way{where}, until they arrive.",
            url=f"/maps?panel=people&person={user.id}",
            tag=f"maps-trip-{user.id}",
            actor_user_id=user.id,
            ttl=3600,
        )
    return {"sharing_with": await _trip_viewers(db, user.id)}


@router.delete("/trip/share", status_code=status.HTTP_204_NO_CONTENT)
async def end_trip_share(db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> None:
    """The trip's over (arrived, ended, or you stopped sharing it): nobody it
    was shared with sees you any more. Other sharing is left alone."""
    await db.execute(delete(MapShare).where(MapShare.owner_id == user.id, MapShare.trip.is_(True)))
    await _forget_if_unshared(db, user.id)
    await db.commit()


class LiveBody(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    heading: float | None = None
    speed: float | None = None
    destination: str | None = Field(default=None, max_length=200)
    eta: datetime | None = None


@router.post("/live")
async def live(body: LiveBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Your position, for the people you're sharing with. With nobody to see
    it, it isn't kept, and the phone is told it can stop sending. A phone
    that hasn't moved sends the same place again: the fresh time is what
    tells the people watching that it's still there."""
    sharing = await _forget_if_unshared(db, user.id)
    trip = False
    now = datetime.now(timezone.utc)
    await note_phone(db, user.id, seen_at=now, stalled_told=None)
    if sharing:
        values = {**body.model_dump(), "at": now}
        await db.execute(insert(MapLiveLocation).values(user_id=user.id, **values).on_conflict_do_update(index_elements=["user_id"], set_=values))
        # A trip running late stays shared until it's over; one that's still going keeps going.
        moved = await db.execute(
            update(MapShare).where(MapShare.owner_id == user.id, MapShare.trip.is_(True)).values(expires_at=_trip_until(body.eta, now))
        )
        trip = bool(moved.rowcount)
    await db.commit()
    return {"sharing": sharing, "trip": trip}


# ---- A phone that stopped sending ---------------------------------------------


async def live_watch(db: AsyncSession, now: datetime | None = None) -> list[uuid.UUID]:
    """Tell anyone who's sharing their location and whose phone has gone
    quiet (nothing for ten minutes): once per silence, by a notification that
    also wakes the phone. Returns who was told. Run every few minutes."""
    now = now or datetime.now(timezone.utc)
    await db.execute(delete(MapShare).where(and_(MapShare.expires_at.is_not(None), MapShare.expires_at <= now)))
    owners = (await db.execute(select(MapShare.owner_id, func.min(MapShare.created_at)).group_by(MapShare.owner_id))).all()
    told: list[tuple[uuid.UUID, str]] = []
    for owner_id, since in owners:
        live = await db.get(MapLiveLocation, owner_id, populate_existing=True)
        last = live.at if live else None
        if now - (last or since) < LIVE_STALLED:
            continue
        user = await db.get(User, owner_id, populate_existing=True)
        if user is None or user.disabled or phone_state(user).get("stalled_told"):
            continue
        told.append((
            owner_id,
            f"Your phone stopped sending your location at {clock(last.astimezone(_zone(user)))}. Open Promptly on your phone to start it again."
            if last
            else "Your phone hasn't started sending your location. Open Promptly on your phone to start it.",
        ))
        await note_phone(db, owner_id, stalled_told=now)
    await db.commit()
    for owner_id, words in told:
        await notify_user(
            user_id=owner_id, category="maps", title="Your location isn't being shared", body=words,
            url="/maps?panel=people", tag="maps-sharing", ttl=3600,
        )
    return [owner_id for owner_id, _words in told]
