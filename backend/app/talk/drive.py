"""Driving by voice (Talk phase 2, WP-T9): the trip, and the tools a spoken turn
gets while one is running.

**The trip.** Before each turn in the car (or on P Maps' driving screen) the phone
sends a ``trip`` message: where you're going, when you'll get there, how far and
how long is left, the traffic delay, the next stop, and your position and the road
ahead. The latest one wins. The model sees only :func:`context_line` ("They're
driving to Home, arriving about 5:40 PM..."): **never coordinates** (the phase 1
rule). The position and the road are used here, by the tools below, for the same
look-ups the phone assistant made (``maps/assistant.py``).

**The tools** (category ``trip``, offered only while there's a trip):

* ``trip_status`` (a read): arrival time, minutes and kilometres left, the delay,
  the next stop. "Will I make it by five?" is answered from this, not a guess.
* ``check_route`` (a read, said as it is): closures, crashes and delays ahead,
  from the live traffic feed (``assistant._check``).
* ``add_stop`` (runs at once): a kind of place ("fuel") or a named or saved one,
  the best on the way, and what it adds. One tap on the screen takes it off.
* ``end_trip`` (runs at once): the car's End button asks first; saying "stop
  navigating" is the answer.

The tools themselves are chat tools in ``chat/tools/trip.py``.
``add_stop`` and ``end_trip`` come back as an ``action`` for the phone, which
carries it out (``PhoneActions`` -> ``Nav.act``); the turn ends on what was said,
with no second model call.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, ValidationError, field_validator


logger = logging.getLogger("promptly.talk")

NOT_NAVIGATING = "You're not navigating anywhere right now."
# The tools that end the turn on what they say (no second model call).
SPOKEN = frozenset({"check_route", "add_stop", "end_trip"})
NAMES = ("trip_status", "check_route", "add_stop", "end_trip")


class Place(BaseModel):
    name: str = Field(default="", max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


class Trip(BaseModel):
    """The phone's ``trip`` message (and ``hello.trip``)."""

    to: Place | None = None
    arrive_at: str | None = Field(default=None, max_length=40)
    left_s: float | None = Field(default=None, ge=0, le=7 * 86400)
    left_m: float | None = Field(default=None, ge=0, le=20_000_000)
    delay_min: int | None = Field(default=None, ge=0, le=24 * 60)
    next_stop: str | None = Field(default=None, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    # The road ahead, as an encoded polyline (precision 6), for "is the way
    # clear?" and stops on the way.
    shape: str | None = Field(default=None, max_length=200_000)

    @field_validator("to", mode="before")
    @classmethod
    def _to(cls, v: Any) -> Any:
        return {"name": v} if isinstance(v, str) else v


def parse(raw: Any) -> dict[str, Any] | None:
    """A trip from the phone, checked, or None (no trip, or nonsense)."""
    if not isinstance(raw, dict):
        return None
    body = {k: v for k, v in raw.items() if k != "type"}
    try:
        trip = Trip.model_validate(body)
    except ValidationError:
        return None
    if trip.to is None or not (trip.to.name or trip.to.lat is not None):
        return None
    return trip.model_dump()


def _zone(tz: str | None) -> ZoneInfo | timezone:
    try:
        return ZoneInfo(tz) if tz else timezone.utc
    except (KeyError, ValueError):
        return timezone.utc


def clock(when: datetime) -> str:
    """5:40 PM, the way it's said."""
    return f"{when.hour % 12 or 12}:{when.minute:02d} {'AM' if when.hour < 12 else 'PM'}"


def arrival(trip: dict[str, Any], tz: str | None) -> str | None:
    """When they'll get there, in their own time: "5:40 PM"."""
    raw = trip.get("arrive_at")
    if raw:
        try:
            at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            return clock(at.astimezone(_zone(tz)))
        except ValueError:
            pass
    left = trip.get("left_s")
    if isinstance(left, (int, float)):
        from datetime import timedelta

        return clock((datetime.now(timezone.utc) + timedelta(seconds=float(left))).astimezone(_zone(tz)))
    return None


def minutes(seconds: float) -> str:
    m = max(1, round(seconds / 60))
    if m >= 90:
        hours, rest = divmod(m, 60)
        return f"{hours} hour{'s' if hours != 1 else ''}" + (f" {rest} minutes" if rest else "")
    return f"{m} minute{'s' if m != 1 else ''}"


def distance(metres: float) -> str:
    from app.maps.assistant import _distance

    return _distance(metres)


def where(trip: dict[str, Any]) -> str:
    return " ".join(str(((trip.get("to") or {}).get("name") or "")).split())[:120] or "where they're going"


def status(trip: dict[str, Any], tz: str | None) -> str:
    """The trip in a sentence or two, no coordinates."""
    parts = [f"Heading to {where(trip)}."]
    at = arrival(trip, tz)
    left = trip.get("left_s")
    bits = []
    if at:
        bits.append(f"arriving about {at}")
    if isinstance(left, (int, float)):
        bits.append(f"in {minutes(left)}")
    if isinstance(trip.get("left_m"), (int, float)):
        bits.append(f"with {distance(trip['left_m'])} to go")
    if bits:
        joined = ", ".join(bits)
        parts.append(joined[0].upper() + joined[1:] + ".")
    delay = trip.get("delay_min") or 0
    parts.append(f"Traffic is adding about {delay} minutes." if delay >= 2 else "Traffic isn't slowing them down.")
    if trip.get("next_stop"):
        parts.append(f"Next stop: {str(trip['next_stop'])[:120]}.")
    return " ".join(parts)


def context_line(trip: dict[str, Any] | None, tz: str | None) -> str | None:
    """What the model is told about the trip on a spoken turn (no coordinates)."""
    if not trip:
        return None
    at = arrival(trip, tz)
    line = f"They're driving right now. {status(trip, tz)}"
    if at:
        line += (
            f" If they ask you to tell someone when they'll get there, the message says they'll be there about {at} "
            "(their own words otherwise)."
        )
    return line


def state_of(trip: dict[str, Any]):  # noqa: ANN201 - maps.assistant.DriveState
    """The trip as the phone assistant's ``DriveState``, for its look-ups."""
    from app.maps.assistant import DriveState

    to = trip.get("to") or {}
    seconds = trip.get("left_s")
    metres = trip.get("left_m")
    return DriveState(
        lat=trip.get("lat"),
        lon=trip.get("lon"),
        shapes=[trip["shape"]] if trip.get("shape") else [],
        seconds=seconds,
        km=(metres / 1000.0) if isinstance(metres, (int, float)) else None,
        to={"name": to.get("name") or "Destination", "lat": to.get("lat"), "lon": to.get("lon")} if to else None,
        adds_minutes=trip.get("delay_min"),
        added_stop=trip.get("next_stop"),
    )
