"""Fairness gate so background indexing can't starve interactive embeds.

The bundled embedder (Ollama) serialises requests to a model, and it does
*not* meaningfully parallelise the embeddings endpoint even with
``OLLAMA_NUM_PARALLEL`` raised. A bulk re-index fires many embedding
batches back-to-back (and several files can index at once), so an
interactive workspace chat — which embeds its query here for RAG
retrieval *before* it can call the chat model — ends up queued behind the
entire backlog and the chat appears to hang.

This gate gives interactive embeds priority:

* **Interactive** calls (the default — query embedding for retrieval) run
  immediately and register themselves as "pending".
* **Background** calls (indexing; tagged via :func:`mark_background`) wait
  until no interactive embed is pending, and only one background batch is
  allowed in flight at a time. So an interactive embed ever waits for at
  most a single already-running batch instead of the whole backlog.

Scope: coordinates within one uvicorn worker (it's in-process state). The
originating index task and a chat usually share a worker; and because the
wait is bounded to a single in-flight batch, the worst case stays small
even when they don't. A cross-worker version would need a shared broker.
"""
from __future__ import annotations

import asyncio
import contextvars

# Set on the current task by indexing code so its embed calls are treated
# as low-priority background work. Defaults to interactive everywhere else.
_background: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "embedding_background", default=False
)

_interactive_count = 0
_count_lock = asyncio.Lock()
# Set whenever there are zero interactive embeds pending; background work
# waits on it so it yields the embedder to interactive requests.
_no_interactive = asyncio.Event()
_no_interactive.set()
# Only one background batch in flight at a time so bulk indexing (possibly
# several files at once) can't flood the embedder.
_background_slot = asyncio.Semaphore(1)


def mark_background() -> None:
    """Tag the current task's embed calls as background (indexing) work."""
    _background.set(True)


class _Lease:
    __slots__ = ("background",)

    def __init__(self, background: bool) -> None:
        self.background = background


async def acquire() -> _Lease:
    """Acquire an embedding lease for the current call. Background callers
    block here until interactive demand clears and a background slot frees."""
    if _background.get():
        await _no_interactive.wait()
        await _background_slot.acquire()
        return _Lease(True)

    global _interactive_count
    async with _count_lock:
        _interactive_count += 1
        _no_interactive.clear()
    return _Lease(False)


async def release(lease: _Lease) -> None:
    if lease.background:
        _background_slot.release()
        return
    global _interactive_count
    async with _count_lock:
        _interactive_count -= 1
        if _interactive_count <= 0:
            _interactive_count = 0
            _no_interactive.set()


__all__ = ["acquire", "release", "mark_background"]
