"""The LiveKit server API (RoomService), with its failures sorted into the
two the admin checklist explains: the server isn't there, or our key pair
isn't the one it was started with.

Use ``async with room_service() as rs:`` and call ``rs.list_rooms`` etc.
(``livekit.api.room_service.RoomService``). Tests replace ``open_api``.
"""
from __future__ import annotations

import contextlib
import logging
from typing import AsyncIterator

import aiohttp
from livekit import api

from app.rtc import config

logger = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=6, connect=3)


class RtcUnavailable(RuntimeError):
    """LiveKit didn't answer (not running, or not reachable)."""


class RtcKeyMismatch(RuntimeError):
    """LiveKit answered but refused our key pair."""


class RtcNotConfigured(RuntimeError):
    """No key pair in .env."""


def open_api() -> api.LiveKitAPI:
    pair = config.keys()
    if pair is None:
        raise RtcNotConfigured("calls aren't set up")
    return api.LiveKitAPI(config.api_url(), *pair, timeout=_TIMEOUT)


def _classify(exc: BaseException) -> BaseException:
    status = getattr(exc, "status", None)
    code = str(getattr(exc, "code", "") or "")
    if status in (401, 403) or code in ("unauthenticated", "permission_denied"):
        return RtcKeyMismatch(str(exc))
    if isinstance(exc, (aiohttp.ClientError, OSError, TimeoutError)) or status in (502, 503, 504):
        return RtcUnavailable(str(exc) or type(exc).__name__)
    return exc


@contextlib.asynccontextmanager
async def room_service() -> AsyncIterator[api.room_service.RoomService]:
    lk = open_api()
    try:
        yield lk.room
    except (RtcUnavailable, RtcKeyMismatch, RtcNotConfigured):
        raise
    except Exception as exc:  # noqa: BLE001 — sorted, then re-raised
        sorted_exc = _classify(exc)
        if sorted_exc is exc:
            raise
        raise sorted_exc from exc
    finally:
        try:
            await lk.aclose()
        except Exception:  # noqa: BLE001
            pass


async def list_rooms() -> list:
    async with room_service() as rs:
        return list((await rs.list_rooms(api.ListRoomsRequest())).rooms)


async def list_participants(room: str) -> list:
    async with room_service() as rs:
        return list((await rs.list_participants(api.ListParticipantsRequest(room=room))).participants)


async def remove_participant(room: str, identity: str) -> bool:
    """True if they were there."""
    async with room_service() as rs:
        try:
            await rs.remove_participant(api.RoomParticipantIdentity(room=room, identity=identity))
            return True
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "status", None) == 404 or str(getattr(exc, "code", "")) == "not_found":
                return False
            raise


async def send_data(room: str, payload: bytes, *, identities: list[str] | None = None, topic: str | None = None) -> None:
    req = api.SendDataRequest(room=room, data=payload, kind=api.DataPacket.RELIABLE, destination_identities=identities or [])
    if topic:
        req.topic = topic
    async with room_service() as rs:
        await rs.send_data(req)


# What a token's source names are in LiveKit's permission messages.
_SOURCES = {
    "microphone": api.TrackSource.MICROPHONE,
    "camera": api.TrackSource.CAMERA,
    "screen_share": api.TrackSource.SCREEN_SHARE,
    "screen_share_audio": api.TrackSource.SCREEN_SHARE_AUDIO,
}


async def update_permissions(room: str, identity: str, *, sources: list[str], can_subscribe: bool = True) -> bool:
    """Change what a connected participant may publish and whether they
    hear anyone (server-mute / server-deafen). Tracks they may no longer
    publish are muted too. False when they aren't in the room."""
    perm = api.ParticipantPermission(
        can_subscribe=can_subscribe,
        can_publish=bool(sources),
        can_publish_data=True,
        can_publish_sources=[_SOURCES[s] for s in sources if s in _SOURCES],
    )
    async with room_service() as rs:
        try:
            info = await rs.update_participant(api.UpdateParticipantRequest(room=room, identity=identity, permission=perm))
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "status", None) == 404 or str(getattr(exc, "code", "")) == "not_found":
                return False
            raise
        allowed = {_SOURCES[s] for s in sources if s in _SOURCES}
        for t in getattr(info, "tracks", []) or []:
            if t.source not in allowed and not t.muted:
                try:
                    await rs.mute_published_track(api.MuteRoomTrackRequest(room=room, identity=identity, track_sid=t.sid, muted=True))
                except Exception:  # noqa: BLE001 — the permission change already stops it
                    logger.debug("couldn't mute %s of %s", t.sid, identity, exc_info=True)
        return True
