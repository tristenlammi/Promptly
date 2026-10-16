"""Where a photo was taken, offline (PH-2, WP-PH2.1).

A GeoNames gazetteer (CC BY 4.0 — credited where places are shown) in
Postgres: every populated place with 500+ people or that is a seat of
local government (``cities500``, ~185k), plus English names of states and
countries. The media worker loads it the first time a photo with a
location needs it — one ~10 MB download from ``GEONAMES_URL`` (default
GeoNames' own dump), or the same three files dropped into
``UPLOAD_ROOT/.geonames/`` on a box with no internet.

A photo's place is the nearest one: a band of latitude (indexed), then a
box, then the closest by an equirectangular distance — no extensions,
well under a millisecond. Nothing within ~300 km (the open sea) is no
place at all.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import math
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.places")

DEFAULT_URL = "https://download.geonames.org/export/dump/"
FILES = ("cities500.zip", "admin1CodesASCII.txt", "countryInfo.txt")
ATTRIBUTION = "Place names from GeoNames (CC BY 4.0)"
# Historical, abandoned or destroyed places aren't where anyone took a photo.
_SKIP_CODES = frozenset({"PPLH", "PPLQ", "PPLW", "PPLCH"})
# Search radii, in degrees of latitude (~28 km, ~110 km, ~330 km).
_RADII = (0.25, 1.0, 3.0)
_FAILED_KEY = "promptly:gazetteer:failed"
_LOCK_KEY = "promptly:gazetteer:loading"


def local_dir() -> Path:
    from app.files import storage

    return storage.UPLOAD_ROOT / ".geonames"


def source_url() -> str:
    url = (os.environ.get("GEONAMES_URL") or DEFAULT_URL).strip()
    return url if url.endswith("/") else url + "/"


# ------------------------------------------------------------------ loading


def parse_places(raw_zip: bytes) -> list[tuple]:
    """``cities500.zip`` → rows for ``geo_places``."""
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".txt"))
        with zf.open(name) as fh:
            for line in io.TextIOWrapper(fh, encoding="utf-8"):
                f = line.rstrip("\n").split("\t")
                if len(f) < 19 or f[7] in _SKIP_CODES:
                    continue
                try:
                    rows.append((
                        int(f[0]), f[1][:200], (f[2] or f[1])[:200], float(f[4]), float(f[5]),
                        f[7][:10], f[8][:2], f[10][:20], int(f[14] or 0), (f[17] or None) and f[17][:40],
                    ))
                except ValueError:
                    continue
    return rows


def parse_admin1(raw: bytes) -> list[tuple[str, str]]:
    out = []
    for line in raw.decode("utf-8").splitlines():
        f = line.split("\t")
        if len(f) >= 2 and f[0] and not f[0].startswith("#"):
            out.append((f[0][:30], f[1][:200]))
    return out


def parse_countries(raw: bytes) -> list[tuple[str, str]]:
    out = []
    for row in csv.reader(io.StringIO(raw.decode("utf-8")), delimiter="\t"):
        if len(row) >= 5 and row[0] and not row[0].startswith("#") and len(row[0]) == 2:
            out.append((row[0], row[4][:200]))
    return out


async def _fetch(name: str) -> bytes:
    local = local_dir() / name
    if await asyncio.to_thread(local.is_file):
        return await asyncio.to_thread(local.read_bytes)
    import httpx

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0), follow_redirects=True) as client:
        r = await client.get(source_url() + name)
        r.raise_for_status()
        return r.content


async def loaded(db: AsyncSession) -> bool:
    return bool(await db.scalar(text("SELECT EXISTS (SELECT 1 FROM geo_places)")))


async def load(db: AsyncSession) -> int:
    """Download (or read) and load the gazetteer, replacing what's there.
    Returns the number of places. Committed."""
    raw_places, raw_admin1, raw_countries = [await _fetch(n) for n in FILES]
    places = await asyncio.to_thread(parse_places, raw_places)
    if len(places) < 1:
        raise ValueError("The place list was empty.")
    admin1 = parse_admin1(raw_admin1)
    countries = parse_countries(raw_countries)
    conn = await db.connection()
    raw = (await conn.get_raw_connection()).driver_connection
    # Never wait forever behind someone reading the old rows.
    await db.execute(text("SET LOCAL lock_timeout = '30s'"))
    await db.execute(text("TRUNCATE geo_places, geo_admin1, geo_countries"))
    await raw.copy_records_to_table(
        "geo_places", records=places,
        columns=["geonameid", "name", "ascii_name", "lat", "lon", "feature_code", "country", "admin1", "population", "timezone"],
    )
    await raw.copy_records_to_table("geo_admin1", records=admin1, columns=["code", "name"])
    await raw.copy_records_to_table("geo_countries", records=countries, columns=["code", "name"])
    await db.commit()
    logger.info("gazetteer loaded: %d places, %d states, %d countries", len(places), len(admin1), len(countries))
    return len(places)


async def ensure_loaded(db: AsyncSession) -> bool:
    """Load it once, when it's needed; after a failure, try again in six
    hours (the admin page says why)."""
    if await loaded(db):
        return True
    from app.redis_client import redis

    if await redis.get(_FAILED_KEY):
        return False
    if not await redis.set(_LOCK_KEY, "1", nx=True, ex=900):
        return False
    try:
        await load(db)
        return True
    except Exception as exc:  # noqa: BLE001 — told to the admin, tried again later
        await db.rollback()
        logger.warning("gazetteer load failed", exc_info=True)
        await redis.set(_FAILED_KEY, f"{exc.__class__.__name__}: {exc}"[:300], ex=6 * 3600)
        return False
    finally:
        await redis.delete(_LOCK_KEY)


async def status(db: AsyncSession) -> dict[str, Any]:
    from app.redis_client import redis

    count = await db.scalar(select(func.count()).select_from(text("geo_places")))
    err = await redis.get(_FAILED_KEY)
    return {
        "places": int(count or 0),
        "error": (err.decode() if isinstance(err, bytes) else err) if err else None,
        "source": source_url(), "attribution": ATTRIBUTION,
    }


async def reset_failure() -> None:
    from app.redis_client import redis

    await redis.delete(_FAILED_KEY)


# ------------------------------------------------------------------ lookup


async def nearest(db: AsyncSession, lat: float, lon: float) -> int | None:
    """The nearest place's id, or None out at sea."""
    k = max(math.cos(math.radians(lat)), 0.05)
    for r in _RADII:
        rl = min(r / k, 180.0)
        row = (
            await db.execute(
                text(
                    "SELECT geonameid FROM geo_places "
                    "WHERE lat BETWEEN :lat0 AND :lat1 AND lon BETWEEN :lon0 AND :lon1 "
                    "ORDER BY (lat - CAST(:lat AS float8)) ^ 2 + ((lon - CAST(:lon AS float8)) * CAST(:k AS float8)) ^ 2 LIMIT 1"
                ),
                {"lat": lat, "lon": lon, "k": k, "lat0": lat - r, "lat1": lat + r, "lon0": lon - rl, "lon1": lon + rl},
            )
        ).first()
        if row is not None:
            return int(row[0])
    return None


@dataclass(frozen=True)
class Place:
    id: int
    name: str
    admin1: str | None
    country: str | None
    country_code: str
    lat: float
    lon: float

    @property
    def label(self) -> str:
        parts = [self.name]
        if self.admin1 and self.admin1 != self.name:
            parts.append(self.admin1)
        if self.country:
            parts.append(self.country)
        return ", ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "admin1": self.admin1, "country": self.country,
            "country_code": self.country_code, "label": self.label,
        }


async def describe(db: AsyncSession, place_id: int | None) -> Place | None:
    if place_id is None:
        return None
    row = (
        await db.execute(
            text(
                "SELECT p.geonameid, p.name, a.name, c.name, p.country, p.lat, p.lon FROM geo_places p "
                "LEFT JOIN geo_admin1 a ON a.code = p.country || '.' || p.admin1 "
                "LEFT JOIN geo_countries c ON c.code = p.country WHERE p.geonameid = :id"
            ),
            {"id": place_id},
        )
    ).first()
    if row is None:
        return None
    return Place(int(row[0]), row[1], row[2], row[3], row[4], float(row[5]), float(row[6]))


__all__ = ["ATTRIBUTION", "Place", "describe", "ensure_loaded", "load", "loaded", "nearest", "status"]
