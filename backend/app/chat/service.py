"""Chat service — DB helpers + Redis stream-context handoff."""
from __future__ import annotations

import json
import uuid
from typing import Any, TypedDict

from app.redis_client import redis

# How long a pending stream context is valid for. If the SSE client takes
# longer than this to connect, the request is discarded and the user needs
# to resend. 60s is conservative; most clients connect within a few ms.
STREAM_CONTEXT_TTL_SECONDS = 60


def _key(stream_id: uuid.UUID | str) -> str:
    return f"promptly:stream:{stream_id}"


class StreamContext(TypedDict):
    conversation_id: str
    user_message_id: str
    provider_id: str
    model_id: str
    # ``"off"`` | ``"auto"`` | ``"always"`` (Phase D1). Persisted in the
    # stream context so the SSE handler doesn't have to re-read the
    # request body to know which web-search behaviour to apply.
    web_search_mode: str
    temperature: float
    max_tokens: int | None
    # Whether to expose registered artefact tools (generate_pdf /
    # generate_image / etc.) to the model on this turn. Off by default —
    # only the chat router opts in based on the user's ``tools_enabled``
    # toggle. Note: the search tools (``web_search``, ``fetch_url``)
    # ride on ``web_search_mode``, *not* this flag, so a user can have
    # search-only or artefacts-only modes without enabling both.
    tools_enabled: bool


async def enqueue_stream(stream_id: uuid.UUID, ctx: StreamContext) -> None:
    await redis.set(_key(stream_id), json.dumps(ctx), ex=STREAM_CONTEXT_TTL_SECONDS)


async def consume_stream(stream_id: uuid.UUID) -> StreamContext | None:
    """Atomically fetch + delete a stream context.

    Using GETDEL prevents the same stream from being consumed twice (e.g. if
    the client reconnects the SSE during the same request).
    """
    raw: Any = await redis.getdel(_key(stream_id))
    if raw is None:
        return None
    return json.loads(raw)
