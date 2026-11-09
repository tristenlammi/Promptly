"""Live updates: one Server-Sent Events stream per person (the Rooms pattern).

An event names a note and how far it has moved — never its text:

* ``{"type": "note", "id", "revision", "change_seq"}`` — refetch it;
* ``{"type": "gone", "id"}`` — you can't open it any more (you were
  removed or left, its owner trashed or deleted it).

The client refetches through the normal, checked endpoints, so a stream
can never show anything its reader can't open. Fan-out is Redis pub/sub
per user; best effort (a dead Redis never fails a save).
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncGenerator, Iterable

from fastapi import Request

logger = logging.getLogger("promptly.notes")

# The only keys an event may carry.
EVENT_KEYS = frozenset({"type", "id", "revision", "change_seq"})


def channel(user_id: uuid.UUID | str) -> str:
    return f"notes:u:{user_id}"


def note_event(note) -> dict:  # noqa: ANN001 — a Note
    return {"type": "note", "id": str(note.id), "revision": note.revision, "change_seq": note.change_seq}


def gone_event(note_id: uuid.UUID | str) -> dict:
    return {"type": "gone", "id": str(note_id)}


async def publish(user_ids: Iterable[uuid.UUID | str], event: dict) -> None:
    """Send ``event`` to each person's stream (after the change is committed)."""
    from app.redis_client import redis

    if not set(event) <= EVENT_KEYS:
        raise ValueError("notes events carry ids and revisions only")
    data = json.dumps(event)
    for uid in {str(u) for u in user_ids}:
        try:
            await redis.publish(channel(uid), data)
        except Exception:  # noqa: BLE001
            logger.debug("notes publish failed", exc_info=True)


async def stream(user_id: uuid.UUID, request: Request) -> AsyncGenerator[str, None]:
    from app.redis_client import redis

    pubsub = redis.pubsub()
    ch = channel(user_id)
    try:
        await pubsub.subscribe(ch)
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                return
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            if message is None:
                yield ": ping\n\n"
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            if data:
                yield f"data: {data}\n\n"
    except asyncio.CancelledError:
        return
    finally:
        try:
            await pubsub.unsubscribe(ch)
            closer = getattr(pubsub, "aclose", None) or pubsub.close
            await closer()
        except Exception:  # noqa: BLE001
            pass


__all__ = ["EVENT_KEYS", "channel", "gone_event", "note_event", "publish", "stream"]
