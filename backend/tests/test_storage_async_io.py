"""Large file writes must not block the event loop.

Promptly runs a *single* uvicorn worker on purpose — SSE reconnect state and
the embedding-fairness gate are in-process — so there is no second worker to
absorb a stall. A synchronous write in an async handler therefore freezes the
whole backend for every user: no chat tokens, no SSE, not even the health
check. The meeting-recording upload allows 100 MB, which made that a routine
occurrence rather than a hypothetical.

The interesting property isn't "the bytes land" (the sync helper already did
that) — it's "other coroutines keep running while they land". These tests
assert that directly, by racing a heartbeat against the write.
"""
from __future__ import annotations

import asyncio
import io

import pytest

from app.files import storage


@pytest.fixture
def upload_root(tmp_path, monkeypatch):
    """Point storage at a temp dir so tests never touch the real volume."""
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path)
    return tmp_path


class _SlowStream(io.RawIOBase):
    """A stream whose reads are slow in the way a real disk/network read is:
    blocking the calling thread, not awaiting."""

    def __init__(self, total_bytes: int, chunk: int, delay: float):
        self._remaining = total_bytes
        self._chunk = chunk
        self._delay = delay

    def read(self, size: int = -1) -> bytes:  # noqa: D102
        if self._remaining <= 0:
            return b""
        import time

        time.sleep(self._delay)  # blocking on purpose
        n = min(self._chunk, self._remaining)
        self._remaining -= n
        return b"x" * n


async def _heartbeat(stop: asyncio.Event, ticks: list[int]) -> None:
    """Ticks while the loop is free. Stops ticking if the loop is blocked."""
    while not stop.is_set():
        ticks.append(1)
        await asyncio.sleep(0.005)


async def test_async_copy_keeps_the_event_loop_responsive(upload_root):
    src = _SlowStream(total_bytes=512, chunk=64, delay=0.02)  # ~8 blocking reads
    stop = asyncio.Event()
    ticks: list[int] = []
    beat = asyncio.create_task(_heartbeat(stop, ticks))

    written = await storage.copy_stream_to_disk_async(src, "async.bin")

    stop.set()
    await beat

    assert written == 512
    assert (upload_root / "async.bin").read_bytes() == b"x" * 512
    # The write blocked a worker thread for ~160ms. If it had blocked the
    # loop instead, the heartbeat could not have ticked at all.
    assert len(ticks) > 5, f"event loop was starved during the write ({len(ticks)} ticks)"


async def test_sync_copy_does_block_the_loop(upload_root):
    """The regression this guards against — kept so the contrast is explicit
    rather than folklore. Calling the sync helper from a coroutine starves
    every other task."""
    src = _SlowStream(total_bytes=512, chunk=64, delay=0.02)
    stop = asyncio.Event()
    ticks: list[int] = []
    beat = asyncio.create_task(_heartbeat(stop, ticks))
    await asyncio.sleep(0)  # let the heartbeat reach its first await

    before = len(ticks)
    storage.copy_stream_to_disk(src, "sync.bin")  # blocking, on the loop
    during = len(ticks) - before

    stop.set()
    await beat

    # The loop had no chance to run the heartbeat while this was going.
    assert during == 0


async def test_async_copy_enforces_the_size_limit(upload_root):
    src = _SlowStream(total_bytes=1024, chunk=256, delay=0)

    with pytest.raises(ValueError):
        await storage.copy_stream_to_disk_async(src, "toobig.bin", size_limit=512)

    # Partial write is cleaned up rather than left as a truncated blob.
    assert not (upload_root / "toobig.bin").exists()


async def test_async_read_text_matches_sync(upload_root):
    (upload_root / "note.txt").write_text("hello world", encoding="utf-8")

    assert await storage.read_text_async("note.txt", 1024) == "hello world"


async def test_concurrent_uploads_overlap(upload_root):
    """Two uploads should proceed together rather than serialising — the
    point of moving the write off the loop."""
    loop = asyncio.get_running_loop()
    start = loop.time()

    await asyncio.gather(
        storage.copy_stream_to_disk_async(
            _SlowStream(total_bytes=256, chunk=64, delay=0.02), "a.bin"
        ),
        storage.copy_stream_to_disk_async(
            _SlowStream(total_bytes=256, chunk=64, delay=0.02), "b.bin"
        ),
    )

    elapsed = loop.time() - start
    # Each is ~4 reads x 20ms = 80ms. Serialised would be ~160ms; overlapped
    # is ~80ms. Generous bound so a slow CI box doesn't flake it.
    assert elapsed < 0.15, f"uploads serialised ({elapsed:.3f}s)"
    assert (upload_root / "a.bin").stat().st_size == 256
    assert (upload_root / "b.bin").stat().st_size == 256
