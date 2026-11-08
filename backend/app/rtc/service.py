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
