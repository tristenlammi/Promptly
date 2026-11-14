"""The phone's own GPS for the P Maps page inside the Android app
(``/api/maps/phone-location``).

A page in the app's launcher is Chrome, and Chrome only passes a page's
location request to the app once Google has verified the app against the
server. Where that check can't be made (a country block, a home-only server),
the page's "my location" fails for good. So the app hands over its own
position instead:

* The app makes a random key, once, and gives it to the pages it opens in
  the address's fragment (never sent to a server, so in nobody's logs).
* The page, signed in, **asks** with that key about once a second while the
  map is in front. That binds the key to the person and keeps a short lease.
* The app posts **fixes** with the key. They're taken only while a lease is
  alive, held in memory, and read back only by the person the key is bound
  to. When the page stops asking, the app is told so and turns its GPS off.

Nothing is stored: no table, no file, gone on a restart. The timeline is a
separate thing with its own switch. A key belongs to the first person who
asks with it; nobody else can bind it, so knowing someone's key gets you
nothing but the chance to post a position they would see as theirs.

In-process memory, like the chat streams: one uvicorn worker (see CLAUDE.md).
"""
from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.auth.deps import get_current_user
from app.auth.models import User

router = APIRouter()

# The page asks every second or so; missing this long means it's gone
# (hidden tab, closed, signal lost).
LEASE_S = 20.0
# A fix older than this isn't "where you are" any more.
FRESH_S = 15.0
# A key stays its first person's for this long after they last asked.
BOUND_S = 30 * 24 * 3600.0
MAX_KEYS = 20_000


@dataclass
class _Slot:
    user_id: uuid.UUID
    asked: float  # monotonic seconds, the page's last ask
    fix: dict[str, Any] | None = None
    fix_at: float = 0.0


_slots: dict[str, _Slot] = {}


def _now() -> float:
    return time.monotonic()


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _prune(now: float) -> None:
    if len(_slots) < MAX_KEYS:
        return
    for k in [k for k, s in _slots.items() if now - s.asked > BOUND_S]:
        _slots.pop(k, None)
    if len(_slots) >= MAX_KEYS:  # still full: the longest-idle half goes
        for k, _s in sorted(_slots.items(), key=lambda kv: kv[1].asked)[: MAX_KEYS // 2]:
            _slots.pop(k, None)


def reset() -> None:
    """Tests."""
    _slots.clear()


Key = Field(min_length=32, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class AskBody(BaseModel):
    key: str = Key


class FixBody(BaseModel):
    key: str = Key
    # No position: the app only asking whether a page wants one.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0, le=100_000)
    heading: float | None = Field(default=None, ge=0, le=360)
    speed: float | None = Field(default=None, ge=0, le=200)


async def _ask_limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("600/minute"), bucket="maps_phone_ask")(request)


async def _fix_limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("600/minute"), bucket="maps_phone_fix")(request)


@router.post("/phone-location/ask", dependencies=[Depends(_ask_limit)])
async def ask(body: AskBody, user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The page wants the phone's position (and gets the latest, if fresh).
    Session only: an app password can't read a position this way."""
    now = _now()
    h = _hash(body.key)
    slot = _slots.get(h)
    if slot is not None and slot.user_id != user.id:
        if now - slot.asked <= BOUND_S:
            # Somebody else's phone. Say nothing about whose.
            raise HTTPException(status.HTTP_409_CONFLICT, "This phone's location belongs to another account.")
        slot = None
    if slot is None:
        _prune(now)
        slot = _slots[h] = _Slot(user_id=user.id, asked=now)
    slot.asked = now
    fresh = slot.fix is not None and now - slot.fix_at <= FRESH_S
    return {"fix": {**slot.fix, "age": round(now - slot.fix_at, 1)} if fresh and slot.fix else None}


@router.post("/phone-location/fix", dependencies=[Depends(_fix_limit)])
async def fix(body: FixBody) -> dict[str, bool]:
    """From the app: a position, or just "does a page want one?". No sign-in:
    the key is the proof, and all it can do is this. ``wanted`` is false for
    an unknown key and for a known one nobody is asking with, alike."""
    now = _now()
    slot = _slots.get(_hash(body.key))
    if slot is None or now - slot.asked > LEASE_S:
        if slot is not None:
            slot.fix = None  # nobody's looking: don't keep where they were
        return {"wanted": False}
    if body.lat is not None and body.lon is not None:
        slot.fix = {
            "lat": body.lat,
            "lon": body.lon,
            "accuracy": body.accuracy,
            "heading": body.heading,
            "speed": body.speed,
        }
        slot.fix_at = now
    return {"wanted": True}
