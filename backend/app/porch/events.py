"""Porch's live feed: ``GET /api/porch/events``, one Server-Sent Events
stream per open Porch app, on the Rooms pattern (``rooms/router.py``).

Each person has one Redis channel (``porch:u:<id>``, :func:`core.channel`);
writes publish small events there (``post``, ``post_change``, ``group``,
``invite``, ``comment``, ``activity``) that carry ids only, never content, so
the app refetches through the normal, checked endpoints. A comment ``: ping`` goes out every 20 s so
the client can tell a live stream from one a proxy is holding open.
"""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db

from . import core
from .deps import require_porch

router = APIRouter()

PING_SECONDS = 20.0


@router.get("/events")
async def events(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> StreamingResponse:
    # The stream can live for hours (a phone left open), and the request's
    # session would hold a pooled DB connection the whole time: enough open
    # clients drain the pool and take the server down (2026-11-03). Give it
    # back before streaming; nothing below touches the database.
    user_id = user.id
    await db.close()
    return StreamingResponse(
        _stream(user_id, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _stream(user_id: uuid.UUID, request: Request) -> AsyncGenerator[str, None]:
    from app.redis_client import redis

    pubsub = redis.pubsub()
    ch = core.channel(user_id)
    try:
        await pubsub.subscribe(ch)
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                return
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=PING_SECONDS)
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


__all__ = ["router"]
