"""Memories (PH-5, Part E §E2.6): "On this day", trips, "Max's first year",
"You & Sarah" — stories made from what understanding already knows (dates,
places, people, pets), never sent anywhere, shown only to their owner.

:func:`generate` remakes a user's memories from their library; each has a
``key`` naming what it is about, so a remake updates a story (a trip that
gained photos) instead of adding another, a dismissed one stays dismissed,
and one that no longer holds (the photos went) goes. The Photos home asks
for them; they're remade there at most hourly (:func:`ensure_fresh`).

- **On this day** — photos taken on today's date in earlier years, one
  memory per year ("3 years ago").
- **Trips** — home is the place you're photographed most days; a trip is a
  run of photos more than ``TRIP_KM`` from it, over two days or more and at
  least ``TRIP_MIN_PHOTOS`` photos (with the un-geotagged ones taken
  meanwhile), named for the country abroad or the town at home.
- **First year** — a named pet's (or child's) first year in your photos,
  once that year is over.
- **Together** — you and someone named, when there are enough photos of
  you both.
"""
from __future__ import annotations

import asyncio
import logging
import math
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.memories")

TRIP_KM = 50.0
TRIP_MIN_PHOTOS = 10
TRIP_GAP = timedelta(days=2)  # away photos further apart than this are two trips
FIRST_YEAR_MIN = 10
TOGETHER_MIN = 8
TOGETHER_MAX = 5  # stories of you and someone, the most-photographed first
MAX_PHOTOS = 500
FRESH_FOR = 3600  # seconds

KINDS = ("on_this_day", "trip", "first_year", "together")


@dataclass
class Shot:
    file_id: uuid.UUID
    taken: datetime  # local wall clock
    quality: float | None
    place_id: int | None
    lat: float | None
    lon: float | None
    screenshot: bool


@dataclass
class Memory:
    kind: str
    key: str
    title: str
    subtitle: str
    start: date
    end: date
    shots: list[Shot]
    person_id: uuid.UUID | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _span(start: date, end: date) -> str:
    """12–18 March 2024 · 30 March – 2 April 2024 · 28 Dec 2023 – 3 Jan 2024."""
    if start == end:
        return f"{start.day} {start:%B %Y}"
    if start.year != end.year:
        return f"{start.day} {start:%b %Y} – {end.day} {end:%b %Y}"
    if start.month != end.month:
        return f"{start.day} {start:%B} – {end.day} {end:%B %Y}"
    return f"{start.day}–{end.day} {end:%B %Y}"


def _years(start: date, end: date) -> str:
    return str(start.year) if start.year == end.year else f"{start.year}–{end.year}"


def _cover(shots: list[Shot]) -> uuid.UUID | None:
    good = [s for s in shots if not s.screenshot] or shots
    return max(good, key=lambda s: (s.quality or 0.0, s.taken)).file_id if good else None


def _possessive(name: str) -> str:
    return f"{name}'" if name.endswith("s") else f"{name}'s"


async def _library(db: AsyncSession, user_id: uuid.UUID) -> list[Shot]:
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    rows = (
        await db.execute(
            select(
                PhotoAsset.file_id, PhotoAsset.taken_local, PhotoAsset.quality, PhotoAsset.place_id,
                FileMedia.lat, FileMedia.lon, FileMedia.lat_override, FileMedia.lon_override, FileMedia.location_hidden,
                FileMedia.make, UserFile.mime_type,
            )
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(and_(in_library(user_id), PhotoAsset.archived_at.is_(None)))
            .order_by(PhotoAsset.taken_local)
        )
    ).all()
    out = []
    for r in rows:
        lat, lon = (r.lat_override, r.lon_override) if r.lat_override is not None else (r.lat, r.lon)
        if r.location_hidden:
            lat = lon = None
        out.append(Shot(r.file_id, r.taken_local, r.quality, r.place_id, lat, lon,
                        screenshot=(r.mime_type == "image/png" and not r.make)))
    return out


async def _places(db: AsyncSession, ids: set[int]) -> dict[int, dict[str, Any]]:
    if not ids:
        return {}
    rows = (
        await db.execute(
            text(
                "SELECT p.geonameid, p.name, p.lat, p.lon, p.country, c.name AS country_name, a.name AS admin1_name, "
                "p.country || '.' || p.admin1 AS admin1 FROM geo_places p "
                "LEFT JOIN geo_countries c ON c.code = p.country "
                "LEFT JOIN geo_admin1 a ON a.code = p.country || '.' || p.admin1 "
                "WHERE p.geonameid = ANY(CAST(:ids AS int[]))"
            ),
            {"ids": list(ids)},
        )
    ).mappings().all()
    return {r["geonameid"]: dict(r) for r in rows}


def on_this_day(shots: list[Shot], today: date, places: dict[int, dict[str, Any]]) -> list[Memory]:
    by_year: dict[int, list[Shot]] = defaultdict(list)
    for s in shots:
        if s.taken.month == today.month and s.taken.day == today.day and s.taken.year < today.year and not s.screenshot:
            by_year[s.taken.year].append(s)
    out = []
    for year, got in sorted(by_year.items(), reverse=True):
        if len(got) < 2:
            continue
        ago = today.year - year
        where = Counter(s.place_id for s in got if s.place_id in places).most_common(1)
        day = got[0].taken.date()
        sub = f"{day.day} {day:%B %Y}" + (f" · {places[where[0][0]]['name']}" if where else "")
        out.append(Memory("on_this_day", f"otd:{today.isoformat()}:{year}", f"{ago} year{'s' if ago != 1 else ''} ago", sub,
                          day, day, got))
    return out


def home_of(shots: list[Shot], places: dict[int, dict[str, Any]]) -> dict[str, Any] | None:
    """The place you're photographed on the most days."""
    days: dict[int, set[date]] = defaultdict(set)
    for s in shots:
        if s.place_id in places:
            days[s.place_id].add(s.taken.date())
    if not days:
        return None
    best = max(days, key=lambda p: len(days[p]))
    return places[best] if len(days[best]) >= 3 else None


def trips(shots: list[Shot], places: dict[int, dict[str, Any]], home: dict[str, Any] | None) -> list[Memory]:
    if home is None:
        return []
    runs: list[list[Shot]] = []
    run: list[Shot] = []
    for s in shots:
        if s.lat is None or s.lon is None:
            continue
        away = _km(home["lat"], home["lon"], s.lat, s.lon) > TRIP_KM
        if away and run and s.taken - run[-1].taken <= TRIP_GAP:
            run.append(s)
            continue
        if run:
            runs.append(run)
        run = [s] if away else []
    if run:
        runs.append(run)

    out = []
    for run in runs:
        first, last = run[0].taken, run[-1].taken
        if first.date() == last.date():
            continue
        # The photos taken meanwhile without a location are the trip's too.
        inside = [s for s in shots if first <= s.taken <= last and not s.screenshot]
        if len(inside) < TRIP_MIN_PHOTOS:
            continue
        towns = Counter(s.place_id for s in run if s.place_id in places)
        if not towns:
            continue
        top, n = towns.most_common(1)[0]
        place = places[top]
        countries = Counter(places[p]["country"] for p in towns.elements())
        abroad = countries.most_common(1)[0][0] != home["country"]
        share = n / sum(towns.values())
        if abroad:
            name = place["name"] if share >= 0.7 else (place["country_name"] or place["country"])
        else:
            admins = Counter(places[p]["admin1"] for p in towns.elements())
            name = place["name"] if share >= 0.5 or len(admins) > 1 else (place["admin1_name"] or place["name"])
        nights = (last.date() - first.date()).days + 1
        out.append(Memory("trip", f"trip:{first.date().isoformat()}", f"Trip to {name}",
                          f"{_span(first.date(), last.date())} · {nights} days", first.date(), last.date(), inside))
    return out


async def _people(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            text(
                "SELECT p.id, p.kind, p.name, p.linked_user_id, r.kind AS relation FROM photo_people p "
                "LEFT JOIN photo_relationships r ON r.person_id = p.id AND r.viewer_user_id = :u "
                "WHERE p.user_id = :u AND NOT p.hidden AND NOT p.memories_hidden"
            ),
            {"u": user_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def _photos_of_everyone(db: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Each person's and pet's photos, in one go."""
    out: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    rows = (await db.execute(
        text(
            "SELECT person_id, file_id FROM photo_faces WHERE user_id = :u AND person_id IS NOT NULL "
            "UNION SELECT pet_id, file_id FROM photo_animals WHERE user_id = :u AND pet_id IS NOT NULL"
        ),
        {"u": user_id},
    )).all()
    for pid, fid in rows:
        out[pid].add(fid)
    return out


def first_year(person: dict[str, Any], mine: list[Shot], today: date) -> Memory | None:
    if not mine:
        return None
    start = mine[0].taken.date()
    end = start + timedelta(days=364)
    if today <= end:
        return None  # the year isn't over yet
    year = [s for s in mine if s.taken.date() <= end]
    if len(year) < FIRST_YEAR_MIN:
        return None
    return Memory("first_year", f"first_year:{person['id']}", f"{_possessive(person['name'])} first year",
                  f"with you · {_years(start, end)}", start, end, year, person_id=person["id"])


def together(person: dict[str, Any], both: list[Shot]) -> Memory | None:
    if len(both) < TOGETHER_MIN:
        return None
    start, end = both[0].taken.date(), both[-1].taken.date()
    return Memory("together", f"together:{person['id']}", f"You & {person['name']}",
                  f"{_years(start, end)} · {len(both)} photos", start, end, both, person_id=person["id"])


def _sample(shots: list[Shot]) -> list[Shot]:
    """At most MAX_PHOTOS, spread evenly over the time it covers."""
    if len(shots) <= MAX_PHOTOS:
        return shots
    step = len(shots) / MAX_PHOTOS
    return [shots[int(i * step)] for i in range(MAX_PHOTOS)]


def _make(
    shots: list[Shot], places: dict[int, dict[str, Any]], people: list[dict[str, Any]],
    photos_of: dict[uuid.UUID, set[uuid.UUID]], user_id: uuid.UUID, today: date,
) -> list[Memory]:
    made: list[Memory] = [*on_this_day(shots, today, places), *trips(shots, places, home_of(shots, places))]
    by_id = {s.file_id: s for s in shots}
    me = next((p for p in people if p["linked_user_id"] == user_id), None)
    mine_ids = photos_of.get(me["id"], set()) if me else set()
    together_found = []
    for p in people:
        if not p["name"] or p is me:
            continue
        got = sorted((by_id[i] for i in photos_of.get(p["id"], ()) if i in by_id), key=lambda s: s.taken)
        if p["kind"] == "pet" or p["relation"] in ("child", "grandchild"):
            m = first_year(p, got, today)
            if m:
                made.append(m)
        if me and p["kind"] == "person":
            m = together(p, [s for s in got if s.file_id in mine_ids])
            if m:
                together_found.append(m)
    return made + sorted(together_found, key=lambda m: -len(m.shots))[:TOGETHER_MAX]


async def generate(db: AsyncSession, user: Any, today: date | None = None) -> int:
    """Remake this user's memories; how many there are now. Not committed."""
    from app.photos.library import user_zone

    if today is None:
        zone = user_zone(user)
        today = datetime.now(zone or timezone.utc).date()
    shots = await _library(db, user.id)
    places = await _places(db, {s.place_id for s in shots if s.place_id is not None})
    people = await _people(db, user.id)
    photos_of = await _photos_of_everyone(db, user.id)
    # A second of pure Python on a big library: off the event loop.
    made = await asyncio.to_thread(_make, shots, places, people, photos_of, user.id, today)

    keys = [m.key for m in made]
    for m in made:
        picked = _sample(m.shots)
        await db.execute(
            text(
                "INSERT INTO photo_memories (user_id, kind, key, title, subtitle, period_start, period_end, file_ids, "
                "cover_file_id, person_id) VALUES (:u, :k, :key, :t, :s, :a, :b, CAST(:ids AS uuid[]), :c, :p) "
                "ON CONFLICT (user_id, key) DO UPDATE SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, "
                "period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, file_ids = EXCLUDED.file_ids, "
                "cover_file_id = EXCLUDED.cover_file_id, updated_at = now() "
                "WHERE photo_memories.file_ids IS DISTINCT FROM EXCLUDED.file_ids OR photo_memories.title <> EXCLUDED.title "
                "OR photo_memories.subtitle <> EXCLUDED.subtitle"
            ),
            {"u": user.id, "k": m.kind, "key": m.key, "t": m.title[:200], "s": m.subtitle[:200], "a": m.start, "b": m.end,
             "ids": [str(s.file_id) for s in picked], "c": _cover(m.shots), "p": m.person_id},
        )
    # What no longer holds goes — but a dismissed story is remembered as
    # dismissed (unless it's an old day's "on this day").
    await db.execute(
        text(
            "DELETE FROM photo_memories WHERE user_id = :u AND NOT (key = ANY(CAST(:keys AS text[]))) "
            "AND (dismissed_at IS NULL OR kind = 'on_this_day')"
        ),
        {"u": user.id, "keys": keys},
    )
    return len(made)


async def ensure_fresh(db: AsyncSession, user: Any) -> None:
    """Remake them unless they were made this hour, today (in the user's
    own time zone) and with no photo new since. Commits."""
    from app.photos.library import user_zone
    from app.redis_client import redis

    today = datetime.now(user_zone(user) or timezone.utc).date().isoformat()
    key = f"promptly:memories:fresh:{user.id}"
    try:
        made = await redis.get(key)
        if (made.decode() if isinstance(made, bytes) else made) == today:
            return
    except Exception:  # noqa: BLE001 — Redis down: just make them
        pass
    await generate(db, user)
    await db.commit()
    try:
        await redis.set(key, today, ex=FRESH_FOR)
    except Exception:  # noqa: BLE001
        pass


async def forget_fresh(user_id: uuid.UUID) -> None:
    """Make them again at the next look (a new photo; someone hidden)."""
    from app.redis_client import redis

    try:
        await redis.delete(f"promptly:memories:fresh:{user_id}")
    except Exception:  # noqa: BLE001
        pass


__all__ = ["KINDS", "ensure_fresh", "forget_fresh", "generate", "home_of", "on_this_day", "trips"]
