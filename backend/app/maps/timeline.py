"""Your timeline and live location sharing (``/api/maps``).

The phone sends positions; a day's stays and journeys are worked out from them
when you look, so deleting points really does delete the history. A timeline
is only ever its owner's. Live location goes only to the people you chose, for
as long as you chose, and its row is removed when nobody's left to see it."""
from __future__ import annotations

import math
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db

from . import data, engine
from .models import MapLiveLocation, MapPlace, MapShare, MapTrackPoint
from .router import maps_user

router = APIRouter()

STAY_METRES = 120.0
STAY_MINUTES = 5
MAX_BATCH = 5000


def timeline_settings(user: User) -> dict[str, Any]:
    raw = (user.settings or {}).get("maps") or {}
    return {"timeline_on": bool(raw.get("timeline_on", False)), "retention_days": raw.get("retention_days")}


def _zone(user: User) -> ZoneInfo:
    try:
        return ZoneInfo((user.settings or {}).get("timezone") or "UTC")
    except Exception:  # noqa: BLE001 — a bad saved zone isn't worth a failed page
        return ZoneInfo("UTC")


# ---- Settings ---------------------------------------------------------------


class SettingsBody(BaseModel):
    timeline_on: bool | None = None
    # How long to keep positions; None keeps them until you delete them.
    retention_days: int | None = Field(default=None, ge=1, le=36500)


@router.get("/timeline/settings")
async def get_settings(user: User = Depends(maps_user)) -> dict[str, Any]:
    return timeline_settings(user)


@router.put("/timeline/settings")
async def put_settings(body: SettingsBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    current = timeline_settings(user)
    changes = body.model_dump(exclude_unset=True)
    current.update(changes)
    user.settings = {**(user.settings or {}), "maps": current}
    await db.commit()
    return current


# ---- Recording --------------------------------------------------------------


class Point(BaseModel):
    at: datetime
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)
    speed: float | None = None


class PointsBody(BaseModel):
    points: list[Point] = Field(max_length=MAX_BATCH)
    source: str = Field(default="phone", pattern="^(phone|google)$")


@router.post("/timeline/points")
async def add_points(body: PointsBody, db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)) -> dict[str, Any]:
    """Positions from the phone, or a Google Timeline import in batches."""
    settings = timeline_settings(user)
    if body.source == "phone" and not settings["timeline_on"]:
        # It was paused elsewhere: tell the phone, keep nothing.
        return {"saved": 0, "timeline_on": False}
    rows = [
        {"user_id": user.id, "at": p.at if p.at.tzinfo else p.at.replace(tzinfo=timezone.utc), "lat": p.lat, "lon": p.lon, "accuracy": p.accuracy, "speed": p.speed, "source": body.source}
        for p in body.points
    ]
    saved = 0
    if rows:
        result = await db.execute(insert(MapTrackPoint).values(rows).on_conflict_do_nothing(constraint="uq_map_track_user_at"))
        saved = result.rowcount or 0
    if settings["retention_days"] and body.source == "phone":
        cutoff = datetime.now(timezone.utc) - timedelta(days=settings["retention_days"])
        await db.execute(delete(MapTrackPoint).where(MapTrackPoint.user_id == user.id, MapTrackPoint.at < cutoff))
    await db.commit()
    return {"saved": saved, "timeline_on": settings["timeline_on"]}


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


async def day_view(db: AsyncSession, user: User, day: date, *, photos: bool = True) -> dict[str, Any]:
    """A day's stays and journeys, in the person's own time zone. Times are
    datetimes here; the API sends them as text."""
    tz = _zone(user)
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
    day: date = Query(alias="date"), db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)
) -> dict[str, Any]:
    view = await day_view(db, user, day)
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
    month: str = Query(pattern=r"^\d{4}-\d{2}$"), db: AsyncSession = Depends(get_db), user: User = Depends(maps_user)
) -> dict[str, Any]:
    """Which days of a month have anything, for the calendar strip."""
    tz = _zone(user)
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
    return {
        "sharing_with": [
            {"user_id": str(u.id), "name": u.username, "expires_at": s.expires_at.isoformat() if s.expires_at else None}
            for s, u in mine
        ],
        "shared_with_me": [
            {
                "user_id": str(u.id),
                "name": u.username,
                "live": {
                    "lat": live.lat, "lon": live.lon, "heading": live.heading, "speed": live.speed, "destination": live.destination,
                    "eta": live.eta.isoformat() if live.eta else None, "at": live.at.isoformat(),
                } if live else None,
            }
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
    if viewer is None or viewer.id == user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="There's nobody by that name on this Promptly.")
    expires = datetime.now(timezone.utc) + timedelta(hours=body.hours) if body.hours else None
    await db.execute(
        insert(MapShare)
        .values(id=uuid.uuid4(), owner_id=user.id, viewer_id=viewer.id, expires_at=expires)
        .on_conflict_do_update(constraint="uq_map_share_pair", set_={"expires_at": expires})
    )
    await db.commit()
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
    it, it isn't kept, and the phone is told it can stop sending."""
    sharing = await _forget_if_unshared(db, user.id)
    if sharing:
        values = {**body.model_dump(), "at": datetime.now(timezone.utc)}
        await db.execute(insert(MapLiveLocation).values(user_id=user.id, **values).on_conflict_do_update(index_elements=["user_id"], set_=values))
    await db.commit()
    return {"sharing": sharing}
