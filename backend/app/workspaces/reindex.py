"""Coalesced re-indexing of a workspace item (R-170, R-176).

Every board edit (each drag, each comment) used to queue its own
whole-board re-embed, and those ran concurrently and raced; every
discussion post re-embedded the whole transcript *inside* the request.
``schedule`` collapses a burst into one run per item: the first call
starts a short debounce, later calls during the debounce or the run just
mark the item dirty, and a dirty item runs once more when the current run
finishes. In-process state is fine — the backend is a single worker.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

logger = logging.getLogger("promptly.workspaces.reindex")

DEBOUNCE_SECONDS = 2.0
# A note re-indexes after this long without a new snapshot (R-233): the
# collab server posts one every few seconds of typing, and each used to
# re-embed the whole note — real cost with a cloud embedder.
NOTE_DEBOUNCE_SECONDS = 45.0

# key -> dirty since the current run started
_pending: dict[tuple[str, uuid.UUID], bool] = {}
# key -> the task running it (so drain() can tell a live run from a stale one)
_tasks: dict[tuple[str, uuid.UUID], asyncio.Task] = {}


async def _run(key, fn: Callable[..., Awaitable], args: tuple, delay: float | None = None) -> None:
    try:
        while True:
            await asyncio.sleep(DEBOUNCE_SECONDS if delay is None else delay)
            _pending[key] = False
            try:
                await fn(*args)
            except Exception:  # noqa: BLE001 — indexing is best-effort
                logger.warning("re-index %s failed", key, exc_info=True)
            if not _pending.get(key):
                return
    finally:
        _pending.pop(key, None)
        _tasks.pop(key, None)


def schedule(
    fn: Callable[..., Awaitable],
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    delay: float | None = None,
) -> None:
    """Re-index ``item_id`` soon, once, however many times this is called.
    ``delay`` overrides the quiet period (notes use a longer one)."""
    key = (getattr(fn, "__name__", str(fn)), item_id)
    if key in _pending:
        t = _tasks.get(key)
        try:
            live = t is not None and not t.done() and t.get_loop() is asyncio.get_running_loop()
        except RuntimeError:
            live = False
        if live:
            _pending[key] = True
            return
        # A run that died with its event loop — start afresh.
        _pending.pop(key, None)
        _tasks.pop(key, None)
    _pending[key] = False
    from app.background import spawn

    task = spawn(_run(key, fn, (workspace_id, item_id), delay), name=f"reindex-{key[0]}-{item_id}")
    if task is not None:
        _tasks[key] = task


async def drain(timeout: float = 30.0) -> None:
    """Wait for every scheduled re-index to finish (tests).

    An entry whose task is gone, done, or on another (closed) event loop —
    one test's leftover in the next — is dropped instead of waited on
    forever; that hung the test suite."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while _pending and loop.time() < deadline:
        for key in list(_pending):
            t = _tasks.get(key)
            if t is None or t.done() or t.get_loop() is not loop:
                _pending.pop(key, None)
                _tasks.pop(key, None)
        if _pending:
            await asyncio.sleep(0.05)
