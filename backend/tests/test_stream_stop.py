"""Stopping an in-flight reply from the composer's Stop button.

Stop used to be a client-side illusion. The button aborted the browser's
``fetch`` and nothing else — but generation doesn't live on that connection,
it runs as a background task filling an in-process buffer (which is what
lets a user navigate away and reattach). So the model kept going, the tokens
were still billed, and the *whole* reply was persisted; reload the page and
the finished answer was sitting there.

``stop_session`` is the server-side half. Its ordering is the part worth
pinning down: mark, close the stream cleanly, cancel, then persist — get it
wrong and the user either sees an error card for an action they chose, or
gets two copies of the same reply.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.chat.stream_runner import StreamSession, _sessions, stop_session


@pytest.fixture(autouse=True)
def _clean_registry():
    """The session registry is module-level global state."""
    _sessions.clear()
    yield
    _sessions.clear()


def _session(*, flush=None) -> StreamSession:
    s = StreamSession(
        stream_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
    )
    s.flush_partial = flush
    _sessions[s.stream_id] = s
    return s


DONE = 'data: {"done": true}\n\n'


async def test_persists_the_partial_and_reports_it():
    seen: list[str] = []

    async def flush(reason: str) -> bool:
        seen.append(reason)
        return True

    s = _session(flush=flush)

    assert await stop_session(s, done_event=DONE) is True
    # The reason reaches the callback so the note appended to the saved text
    # says "Stopped" rather than blaming a server restart.
    assert seen == ["stopped"]


async def test_cancels_the_generator_task():
    """This is the bit that actually stops the tokens (and the billing)."""
    started = asyncio.Event()

    async def forever() -> None:
        started.set()
        await asyncio.sleep(3600)

    s = _session(flush=None)
    s.task = asyncio.create_task(forever())
    await started.wait()

    await stop_session(s, done_event=DONE)
    await asyncio.sleep(0)  # let the cancellation be delivered

    assert s.task.cancelled() or s.task.done()


async def test_closes_the_stream_cleanly_for_live_subscribers():
    """A subscriber still attached must see a normal end of stream. The
    runner wrapper turns cancellation into ``finish(error=...)``, so the
    clean finish has to land first — otherwise stopping your own reply
    renders an error card."""
    s = _session(flush=None)

    await stop_session(s, done_event=DONE)

    assert s.done is True
    assert s.error is None
    assert s.events[-1] == DONE

    # Whatever the cancelled runner does afterwards can't downgrade it.
    s.finish(error="cancelled")
    assert s.error is None


async def test_marks_flushed_before_awaiting_so_no_second_row():
    """``flushed`` is what the generator's own persist path checks. If the
    generation happens to complete during the stop, the guard is what stops
    the reply being written twice."""
    seen_during_call = None

    async def flush(reason: str) -> bool:
        nonlocal seen_during_call
        seen_during_call = s.flushed
        return True

    s = _session(flush=flush)
    await stop_session(s, done_event=DONE)

    assert seen_during_call is True
    assert s.flushed is True


async def test_no_callback_still_stops_generation():
    """The generator registers its callback partway through setup. Stopping
    before that point has nothing to save, but must still halt the stream."""
    s = _session(flush=None)

    assert await stop_session(s, done_event=DONE) is False
    assert s.done is True


async def test_empty_reply_reports_nothing_saved():
    """Stopped before the first token — there's no partial to show."""

    async def flush(reason: str) -> bool:
        return False

    s = _session(flush=flush)
    assert await stop_session(s, done_event=DONE) is False


async def test_failed_save_does_not_fail_the_stop():
    """Losing the partial text is bad; leaving the model running because
    saving it failed is worse."""

    async def boom(reason: str) -> bool:
        raise RuntimeError("db exploded")

    s = _session(flush=boom)

    assert await stop_session(s, done_event=DONE) is False
    assert s.done is True


async def test_already_finished_session_is_a_noop():
    """Stop raced the reply finishing on its own. The persisted message is
    the real one — don't append a truncated duplicate on top of it."""
    calls = 0

    async def flush(reason: str) -> bool:
        nonlocal calls
        calls += 1
        return True

    s = _session(flush=flush)
    s.finish()

    assert await stop_session(s, done_event=DONE) is False
    assert calls == 0
    assert s.events == []
