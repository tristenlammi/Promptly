"""Safe fire-and-forget task spawning.

``asyncio.create_task`` returns a task the event loop only holds a **weak**
reference to. From the CPython docs:

    Save a reference to the result of this function, to avoid a task
    disappearing mid-execution. The event loop only keeps weak references to
    tasks. A task that isn't referenced elsewhere may get garbage collected
    at any time, even before it's done.

Promptly had nine call sites that discarded the returned task, on work where
vanishing is silent and hard to notice later: push notifications and inbox
rows, workspace-memory refresh, chat re-indexing, automation-event fan-out,
the Redis-unavailable fallback for task runs, stream-session eviction — and,
most awkwardly, the write that persists captured errors, so the operator's
primary diagnostic surface could drop exactly the errors that happen under
load.

``spawn`` keeps a strong reference until the task completes, and logs any
exception. Without that logging a failure surfaces only as asyncio's
"Task exception was never retrieved" during garbage collection, attributed to
nothing in particular — or not at all.

This is for genuine fire-and-forget work. If the result matters, hold the task
and await it.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Coroutine

logger = logging.getLogger("promptly.background")

# Strong references to in-flight tasks. Entries remove themselves on
# completion via the done-callback, so this stays bounded by the number of
# *currently running* background tasks rather than growing forever.
_background_tasks: set[asyncio.Task[Any]] = set()


# Note on the error-capture interaction: this module logs failures at ERROR,
# and ``observability.capture.DbErrorHandler`` turns ERROR logs into a spawned
# DB write — so a failing task logs, which spawns, which could log again. That
# doesn't recurse, because ``_persist_async`` swallows its own exceptions and
# reports to stderr rather than the logger (deliberately, for exactly this
# reason). Keep that property if you touch it.
def _on_done(task: asyncio.Task[Any]) -> None:
    _background_tasks.discard(task)
    if task.cancelled():
        # Cancellation is normal at shutdown — not worth a log line.
        return
    exc = task.exception()
    if exc is not None:
        logger.error(
            "Background task %r failed", task.get_name(), exc_info=exc
        )


def spawn(
    coro: Coroutine[Any, Any, Any], *, name: str | None = None
) -> asyncio.Task[Any] | None:
    """Schedule ``coro`` as a background task that can't be GC'd mid-flight.

    Returns the task, or ``None`` when there's no running event loop — the
    same defensive case the previous call sites handled, kept so callers that
    may run from a sync context don't have to special-case it. The coroutine
    is closed in that case so Python doesn't warn about it never being
    awaited.
    """
    try:
        task = asyncio.get_running_loop().create_task(coro, name=name)
    except RuntimeError:
        coro.close()
        logger.warning(
            "No running event loop; dropped background task %r", name or "<unnamed>"
        )
        return None
    _background_tasks.add(task)
    task.add_done_callback(_on_done)
    return task


def pending_count() -> int:
    """Number of background tasks currently in flight (used by tests)."""
    return len(_background_tasks)


__all__ = ["spawn", "pending_count"]
