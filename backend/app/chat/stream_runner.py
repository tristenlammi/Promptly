"""Background-task SSE session runner.

The chat router used to run the LLM generator *inside* the SSE response,
which meant closing the browser tab (or navigating away on mobile) cancelled
the underlying ASGI task and the assistant message was lost — no DB row, no
billing entry, nothing for the user to come back to.

This module decouples generation from the HTTP connection:

* The first ``GET /stream/<id>`` call spawns an asyncio task that runs the
  generator and pushes each SSE-encoded chunk into an in-memory event log
  on a ``StreamSession``.
* The HTTP handler subscribes to that log and forwards events to the wire.
  When the client disconnects, only the *handler* is cancelled — the
  background task keeps producing tokens, the assistant message still
  lands in Postgres, and the usage counter still ticks.
* If the client reconnects (refreshes the tab, opens the conversation
  again, etc.) within the retention window, ``get_session`` finds the
  live session and a fresh subscriber replays every event from the
  beginning so the rendered transcript matches what was generated.

In-process state is fine for a single-uvicorn-worker self-hosted setup —
which is what every Promptly install is. Horizontal scaling would need a
Redis-backed event log instead, but we'd cross that bridge when (if) we
ever ship a clustered deployment.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import AsyncGenerator, Awaitable, Callable

logger = logging.getLogger("promptly.chat.stream")

# How long a *finished* session lingers in memory after the generator
# completes. Long enough that a user who navigated away mid-reply can
# come back and replay the full transcript without us hammering the DB,
# but short enough that idle sessions don't accumulate forever. The
# persisted Postgres row is the source of truth past this window.
COMPLETED_SESSION_TTL_SECONDS = 180


@dataclass
class StreamSession:
    """Live (or recently-finished) generation session.

    Holds the buffered SSE payloads plus a wakeup ``Event`` that
    subscribers ``await`` to pick up new chunks. The event is recreated
    on every push so multiple subscribers each see every value once
    (the previous wait point fires; the next loop grabs a fresh event).
    """

    stream_id: uuid.UUID
    user_id: uuid.UUID
    conversation_id: uuid.UUID
    events: list[str] = field(default_factory=list)
    done: bool = False
    error: str | None = None
    task: asyncio.Task[None] | None = None
    started_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None
    # Recreated every push so previously-waiting subscribers can be
    # released without missing the new chunk. ``asyncio.Event`` is the
    # right primitive here over Condition because we don't need a lock —
    # ``events`` is only ever appended from the runner task.
    _wakeup: asyncio.Event = field(default_factory=asyncio.Event)

    def push(self, sse_chunk: str) -> None:
        """Append an event and wake every current subscriber.

        ``sse_chunk`` must be a fully-formed SSE payload (``data: ...\\n\\n``)
        so subscribers can forward it byte-for-byte. We don't re-encode
        on the read path.
        """
        self.events.append(sse_chunk)
        old = self._wakeup
        self._wakeup = asyncio.Event()
        old.set()

    def finish(self, error: str | None = None) -> None:
        """Mark the session complete and release any waiters."""
        if self.done:
            return
        self.done = True
        self.error = error
        self.finished_at = time.monotonic()
        self._wakeup.set()

    async def subscribe(
        self, from_index: int = 0
    ) -> AsyncGenerator[tuple[int, str], None]:
        """Async iterator over buffered + future events.

        Yields ``(absolute_index, sse_chunk)`` so callers can advertise a
        ``Last-Event-ID``-style resume cursor if they want. Stops once the
        runner has finished and the local cursor catches up.
        """
        i = max(0, from_index)
        while True:
            # Drain anything already buffered first so a fresh subscriber
            # gets the full backlog before blocking.
            while i < len(self.events):
                yield i, self.events[i]
                i += 1
            if self.done:
                return
            # Snapshot the current event so a push that lands while we're
            # awaiting it can't slip past us.
            wakeup = self._wakeup
            await wakeup.wait()


# Keyed by stream_id. We never share sessions across stream ids — every
# user turn enqueues a fresh stream context with a fresh uuid.
_sessions: dict[uuid.UUID, StreamSession] = {}
_lock = asyncio.Lock()


async def get_or_create_session(
    *,
    stream_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    runner: Callable[[StreamSession], Awaitable[None]],
) -> StreamSession:
    """Return an existing session or start a new background runner.

    ``runner`` is invoked *exactly once* (when the session is first
    created) and must produce SSE chunks via ``session.push``. We wrap
    it so that exceptions and cancellation always end with
    ``session.finish`` — subscribers should never deadlock on a runner
    that died silently.
    """
    async with _lock:
        existing = _sessions.get(stream_id)
        if existing is not None:
            return existing

        session = StreamSession(
            stream_id=stream_id,
            user_id=user_id,
            conversation_id=conversation_id,
        )
        _sessions[stream_id] = session

        async def _wrapper() -> None:
            try:
                await runner(session)
            except asyncio.CancelledError:
                # Process shutdown or explicit cancel — surface as an
                # error event so any live subscriber sees the abort
                # rather than hanging on a never-completing stream.
                logger.info("Background stream %s cancelled", stream_id)
                session.finish(error="cancelled")
                raise
            except Exception as exc:  # noqa: BLE001 — must never crash the worker
                logger.exception("Background stream %s crashed", stream_id)
                session.finish(error=str(exc))
            else:
                session.finish()
            finally:
                # Schedule eviction so finished sessions don't pile up.
                # Done in a fire-and-forget task so the runner's own
                # task can complete cleanly.
                asyncio.create_task(_evict_after_delay(stream_id))

        session.task = asyncio.create_task(_wrapper())
        return session


async def _evict_after_delay(stream_id: uuid.UUID) -> None:
    await asyncio.sleep(COMPLETED_SESSION_TTL_SECONDS)
    async with _lock:
        _sessions.pop(stream_id, None)


def get_session(stream_id: uuid.UUID) -> StreamSession | None:
    """Return the live (or recently-finished) session, or ``None``."""
    return _sessions.get(stream_id)


def find_active_for_conversation(
    *, conversation_id: uuid.UUID
) -> StreamSession | None:
    """Look up an *in-flight* session for a given conversation.

    Used by the frontend on conversation reload — if a stream is still
    generating for this conversation, the client reattaches to it and
    keeps watching the live tail instead of leaving the user staring at
    the persisted-but-stale transcript while the AI is still talking.

    Caller is expected to have already verified the requesting user has
    access to ``conversation_id`` (owner or accepted collaborator) so we
    don't filter by user here — collaborators on shared chats need to
    see the same live stream the sender is producing.

    Finished sessions are excluded; the persisted assistant message in
    Postgres is the canonical record once generation is done.
    """
    for session in _sessions.values():
        if session.conversation_id == conversation_id and not session.done:
            return session
    return None
