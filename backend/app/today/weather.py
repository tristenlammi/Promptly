"""One line of weather for "Read me my day" (Talk phase 2, WP-T12).

From the Open-Meteo forecast API (open-meteo.com): no key, free for
non-commercial use under 10,000 calls a day, data under CC BY 4.0 (credited on
the Today page). The only thing sent is your Home place **rounded to 0.1°**
(about 10 km); the answer is cached for :data:`CACHE_S` in Redis per rounded
place, so a household shares one call. Admins can turn it off
(``app_settings.weather_enabled``, Admin -> Talk). No Home place, the switch
off, or no answer: no weather line, nothing else changes.

"Sunny, 31 degrees. A storm likely after three."
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.today")

URL = "https://api.open-meteo.com/v1/forecast"
CACHE_S = 30 * 60
TIMEOUT_S = 4.0
LIKELY = 50  # % chance of rain or storm that's worth saying

_HOURS = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"]


def sky(code: int) -> str:
    """A WMO weather code, as people say it."""
    if code == 0:
        return "Sunny"
    if code in (1, 2):
        return "Mostly sunny"
    if code == 3:
        return "Cloudy"
    if code in (45, 48):
        return "Foggy"
    if 51 <= code <= 57:
        return "Drizzly"
    if 61 <= code <= 67 or 80 <= code <= 82:
        return "Rainy"
    if 71 <= code <= 77 or code in (85, 86):
        return "Snowy"
    if code >= 95:
        return "Stormy"
    return "Mixed"


def hour_words(hour: int) -> str:
    return _HOURS[hour % 12]


def describe(data: dict[str, Any], now: datetime) -> str | None:
    """The forecast as one or two short sentences."""
    daily = data.get("daily") or {}
    try:
        code = int((daily.get("weather_code") or [None])[0])
        high = round(float((daily.get("temperature_2m_max") or [None])[0]))
    except (TypeError, ValueError, IndexError):
        return None
    line = f"{sky(code)}, {high} degrees."
    hourly = data.get("hourly") or {}
    times, codes, chances = hourly.get("time") or [], hourly.get("weather_code") or [], hourly.get("precipitation_probability") or []
    storm = rain = None
    for t, c, p in zip(times, codes, chances):
        try:
            at = datetime.fromisoformat(str(t))
        except ValueError:
            continue
        if at.date() != now.date() or at.hour < now.hour or p is None or p < LIKELY:
            continue
        if c is not None and c >= 95 and storm is None:
            storm = at.hour
        elif c is not None and (51 <= c <= 67 or 80 <= c <= 82) and rain is None:
            rain = at.hour
    if storm is not None:
        line += f" A storm likely after {hour_words(storm)}."
    elif rain is not None and code < 51:
        line += f" Rain likely after {hour_words(rain)}."
    return line


async def _fetch(lat: float, lon: float) -> dict[str, Any] | None:
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "weather_code,temperature_2m_max,temperature_2m_min",
        "hourly": "weather_code,precipitation_probability",
        "timezone": "auto",
        "forecast_days": 1,
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.get(URL, params=params)
            if r.status_code != 200:
                logger.info("weather: Open-Meteo said %s", r.status_code)
                return None
            return r.json()
    except (httpx.HTTPError, ValueError):
        logger.info("weather: Open-Meteo unreachable")
        return None


async def enabled(db: AsyncSession) -> bool:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return True if row is None else bool(getattr(row, "weather_enabled", True))


async def home(db: AsyncSession, user: User) -> tuple[float, float] | None:
    from app.maps.models import MapPlace

    place = (await db.execute(select(MapPlace).where(MapPlace.user_id == user.id, MapPlace.kind == "home"))).scalars().first()
    if place is None:
        return None
    # About 10 km: all that leaves this server.
    return round(place.lat, 1), round(place.lon, 1)


async def line(db: AsyncSession, user: User, now: datetime) -> str | None:
    if not await enabled(db):
        return None
    where = await home(db, user)
    if where is None:
        return None
    from app.redis_client import redis

    key = f"weather:{where[0]:.1f},{where[1]:.1f}"
    data: dict[str, Any] | None = None
    try:
        held = await redis.get(key)
        if held:
            data = json.loads(held)
    except Exception:  # noqa: BLE001 - without the cache it's just one more call
        data = None
    if data is None:
        data = await _fetch(*where)
        if data is None:
            return None
        try:
            await redis.set(key, json.dumps(data), ex=CACHE_S)
        except Exception:  # noqa: BLE001
            pass
    return describe(data, now)
