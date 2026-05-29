"""Chat service — DB helpers + Redis stream-context handoff."""
from __future__ import annotations

import json
import uuid
from typing import Any, NotRequired, TypedDict

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
    # DeepSeek-only reasoning knob. ``None`` (the default for every
    # non-DeepSeek conversation, and for fresh DeepSeek chats that
    # haven't explicitly picked a value yet) means "don't attach the
    # ``thinking`` / ``reasoning_effort`` request fields and let the
    # provider's API default kick in". Non-NULL values map onto the
    # DeepSeek wire shape — see ``ChatRouter.stream_chat_events``.
    # Typed as a free-form ``str`` here (not the Literal) so the Redis
    # JSON round-trip on the stream-context handoff stays exact; the
    # router validates the value before sending it upstream.
    reasoning_effort: str | None
    # Continue-generation (Phase 3.1). When present, the stream resumes a
    # *truncated* assistant reply: the generator splices the partial text
    # into the prompt as context and **appends** the continuation to this
    # existing message id instead of creating a fresh assistant row.
    # Absent on every normal send / edit / regenerate.
    continue_from_message_id: NotRequired[str]


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


async def peek_stream(stream_id: uuid.UUID) -> StreamContext | None:
    """Read a stream context without consuming it.

    Used by the SSE handler to learn the conversation id (so the
    in-process session table can index by it) before handing the
    context off to the background runner that performs the GETDEL.
    """
    raw: Any = await redis.get(_key(stream_id))
    if raw is None:
        return None
    return json.loads(raw)
