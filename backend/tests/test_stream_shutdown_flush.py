"""Shutdown-flush behaviour for in-flight chat streams.

Generation state lives only in process memory (see
``app/chat/stream_runner.py``), so before the flush existed every restart —
including a routine ``docker compose up -d`` — silently destroyed in-flight
replies: no message row, no billing entry, and the conversation left showing
a question with no answer and no error.

These are the first tests to cover any of the streaming path. They target
``flush_in_flight`` directly rather than standing up the whole chat router,
because the generator needs a provider, a model and a live DB; the contract
that actually matters here is "every live session with a registered callback
gets persisted exactly once, and nothing about that can block shutdown".
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.chat.stream_runner import (
    StreamSession,
    _sessions,
    flush_in_flight,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    """The session registry is module-level global state."""
    _sessions.clear()
    yield
    _sessions.clear()


def _session(*, done: bool = False, flush=None) -> StreamSession:
    s = StreamSession(
        stream_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
    )
    s.done = done
    s.flush_partial = flush
    _sessions[s.stream_id] = s
    return s


async def test_flushes_live_sessions_and_reports_count():
    calls: list[str] = []

    async def flush_a() -> bool:
        calls.append("a")
        return True

    async def flush_b() -> bool:
        calls.append("b")
        return True

    _session(flush=flush_a)
    _session(flush=flush_b)

    saved = await flush_in_flight()

    assert saved == 2
    assert sorted(calls) == ["a", "b"]


async def test_skips_finished_sessions():
    """A completed generation already persisted itself."""
    called = False

    async def flush() -> bool:
        nonlocal called
        called = True
        return True

    _session(done=True, flush=flush)

    assert await flush_in_flight() == 0
    assert called is False


async def test_skips_sessions_with_no_callback():
    """The generator registers its callback partway through setup — a stream
    that died before that point has nothing worth saving."""
    _session(flush=None)
    assert await flush_in_flight() == 0


async def test_callback_returning_false_is_not_counted():
    """No accumulated text yet → nothing written, so it mustn't be reported
    as a saved reply."""

    async def flush() -> bool:
        return False

    _session(flush=flush)
    assert await flush_in_flight() == 0


async def test_one_failure_does_not_block_the_others():
    """Sessions are flushed independently; a single bad one must not cost
    everyone else their reply."""

    async def boom() -> bool:
        raise RuntimeError("db exploded")

    async def ok() -> bool:
        return True

    _session(flush=boom)
    _session(flush=ok)

    saved = await flush_in_flight()

    assert saved == 1  # the healthy one still landed


async def test_marks_flushed_so_the_generator_cannot_double_write():
    """``flushed`` is what the generator's own persist path checks to avoid
    writing a second copy of the same reply."""

    async def flush() -> bool:
        return True

    s = _session(flush=flush)
    assert s.flushed is False

    await flush_in_flight()

    assert s.flushed is True


async def test_already_flushed_session_is_not_flushed_again():
    calls = 0

    async def flush() -> bool:
        nonlocal calls
        calls += 1
        return True

    s = _session(flush=flush)
    s.flushed = True

    assert await flush_in_flight() == 0
    assert calls == 0


async def test_marks_flushed_before_awaiting_the_callback():
    """The mark has to happen *before* the await, otherwise a generator that
    finishes mid-flush races in a duplicate row."""
    seen_during_call = None

    async def flush() -> bool:
        nonlocal seen_during_call
        seen_during_call = s.flushed
        return True

    s = _session(flush=flush)
    await flush_in_flight()

    assert seen_during_call is True


async def test_slow_flush_cannot_hang_shutdown():
    """The container's shutdown grace period is finite — losing a partial
    reply is bad, hanging the shutdown is worse."""

    async def hangs() -> bool:
        await asyncio.sleep(30)
        return True

    _session(flush=hangs)

    saved = await asyncio.wait_for(flush_in_flight(timeout=0.05), timeout=5)

    assert saved == 0


async def test_no_sessions_is_a_noop():
    assert await flush_in_flight() == 0
