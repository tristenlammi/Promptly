"""The Android app's own camera for Rooms.

On a phone with the Promptly app, the camera button in a conversation opens
the app's camera (``android/app/.../roomscam``): a real camera, not a web
page's. The page can't hand the app its sign-in, so it asks for a **camera
ticket** and passes that instead (``promptly://rooms/camera?...``).

A ticket is small on purpose. It lets its holder do one thing: send photos
and videos, as the person who asked for it, to the one conversation it was
asked for (as a reply to the one message, if they were replying). It lasts
:data:`TTL` and at most :data:`MAX_SENDS` sends. It reads nothing: no
messages, no files, no names. Membership is checked again on every send, so
leaving or being removed ends it at once.

A send is one request, picture and words together, so nothing is left
half-sent: there is never an uploaded file waiting for a message.
"""
from __future__ import annotations

import time
import uuid
from datetime import timedelta

import jwt

from app.config import get_settings

TTL = timedelta(hours=6)
MAX_SENDS = 40
TYP = "rooms-camera"
# The most the camera sends in pieces: a minute of 1080p at a phone camera's
# own bit rate is about 90 MB.
BIG_MAX_BYTES = 150 * 1024 * 1024

# What a camera makes. Anything else isn't from the camera screen.
KINDS = ("image/", "video/")


def is_media(mime: str | None) -> bool:
    kind = (mime or "").lower()
    return kind.startswith(KINDS) and kind != "image/svg+xml"


def mint(user_id: uuid.UUID, room_id: uuid.UUID, reply_to_id: uuid.UUID | None) -> tuple[str, int]:
    """``(ticket, expires_at)``; ``expires_at`` in epoch seconds."""
    now = int(time.time())
    exp = now + int(TTL.total_seconds())
    claims = {"typ": TYP, "sub": str(user_id), "room": str(room_id), "jti": uuid.uuid4().hex, "iat": now, "exp": exp}
    if reply_to_id is not None:
        claims["reply"] = str(reply_to_id)
    return jwt.encode(claims, get_settings().SECRET_KEY, algorithm="HS256"), exp


def read(ticket: str | None) -> dict | None:
    """The ticket's claims, or None when it's not one, forged or run out."""
    if not ticket or len(ticket) > 2000:
        return None
    try:
        claims = jwt.decode(ticket, get_settings().SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("typ") != TYP:
        return None
    try:
        uuid.UUID(claims["sub"])
        uuid.UUID(claims["room"])
        if claims.get("reply"):
            uuid.UUID(claims["reply"])
    except (KeyError, ValueError, TypeError):
        return None
    if not isinstance(claims.get("jti"), str):
        return None
    return claims


def _key(jti: str) -> str:
    return f"promptly:rooms-camera:{jti}"


async def count_send(claims: dict) -> bool:
    """One more send on this ticket; False when it has had its share."""
    from app.redis_client import redis

    key = _key(claims["jti"])
    n = await redis.incr(key)
    if n == 1:
        await redis.expire(key, int(TTL.total_seconds()) + 60)
    return n <= MAX_SENDS


async def uncount_send(claims: dict) -> None:
    """A send that didn't happen doesn't use one up."""
    from app.redis_client import redis

    try:
        await redis.decr(_key(claims["jti"]))
    except Exception:  # noqa: BLE001 - a lost count only makes the ticket stricter
        pass
