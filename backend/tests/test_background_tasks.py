"""Fire-and-forget tasks must not be garbage-collected mid-flight.

``asyncio.create_task`` returns a task the loop only *weakly* references, so
discarding the return value means the task can be collected before it
finishes. Promptly discarded it at nine call sites, on work whose
disappearance is silent: push notifications, chat re-indexing, workspace
memory refresh, automation event fan-out, and the write that persists
captured errors.

These tests pin the two properties that matter: a strong reference is held
until completion (and released afterwards, so it isn't a leak), and failures
are reported rather than swallowed.
"""
from __future__ import annotations

import asyncio
import gc

import pytest

from app import background


@pytest.fixture(autouse=True)
def _clean_registry():
    background._background_tasks.clear()
    yield
    background._background_tasks.clear()


async def test_task_is_strongly_referenced_while_running():
    started = asyncio.Event()
    release = asyncio.Event()

    async def work() -> None:
        started.set()
        await release.wait()

    background.spawn(work(), name="held")
    await started.wait()

    # The whole point: a reference exists somewhere other than the loop.
    assert background.pending_count() == 1

    # Force a collection while it's suspended — the window where an
    # unreferenced task could vanish.
    gc.collect()
    assert background.pending_count() == 1

    release.set()
    await asyncio.sleep(0)


async def test_reference_is_released_once_done():
    """Held during, released after — otherwise it's just a leak."""
    ran = asyncio.Event()

    async def work() -> None:
        ran.set()

    task = background.spawn(work(), name="transient")
    await task
    await asyncio.sleep(0)  # let the done-callback run

    assert ran.is_set()
    assert background.pending_count() == 0


async def test_survives_a_collection_mid_flight():
    """The regression itself: without a strong ref this could be collected
    before completing."""
    done = asyncio.Event()

    async def work() -> None:
        await asyncio.sleep(0.01)
        gc.collect()
        await asyncio.sleep(0.01)
        done.set()

    background.spawn(work(), name="gc-survivor")
    await asyncio.wait_for(done.wait(), timeout=2)

    assert done.is_set()


async def test_failure_is_logged_not_swallowed(caplog):
    """A fire-and-forget task that raises used to surface only as asyncio's
    'Task exception was never retrieved' during GC, attributed to nothing."""

    async def boom() -> None:
        raise ValueError("kaboom")

    task = background.spawn(boom(), name="exploding")
    with pytest.raises(ValueError):
        await task
    await asyncio.sleep(0)

    assert any(
        "exploding" in r.message or "kaboom" in str(r.exc_info)
        for r in caplog.records
        if r.levelname == "ERROR"
    ), "the failure should have been logged"
    assert background.pending_count() == 0


async def test_cancellation_is_not_logged_as_an_error(caplog):
    """Cancellation is normal at shutdown — logging it would be noise."""

    async def work() -> None:
        await asyncio.sleep(30)

    task = background.spawn(work(), name="cancelled")
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)

    assert not [r for r in caplog.records if r.levelname == "ERROR"]
    assert background.pending_count() == 0


def test_no_running_loop_returns_none_and_closes_the_coro(caplog):
    """Called from sync context: don't raise, and don't leave an un-awaited
    coroutine behind for Python to warn about."""

    async def work() -> None:  # pragma: no cover - never awaited
        pass

    coro = work()
    result = background.spawn(coro, name="loopless")

    assert result is None
    # Re-awaiting a closed coroutine raises, which is how we know it was
    # closed rather than leaked.
    with pytest.raises(RuntimeError):
        coro.send(None)


async def test_many_tasks_all_complete():
    """Concurrency sanity — the registry is a set keyed by task identity, so
    identical coroutines must not collapse into one entry."""
    counter = 0

    async def work() -> None:
        nonlocal counter
        await asyncio.sleep(0.001)
        counter += 1

    tasks = [background.spawn(work(), name="batch") for _ in range(25)]
    await asyncio.gather(*tasks)
    await asyncio.sleep(0)

    assert counter == 25
    assert background.pending_count() == 0
