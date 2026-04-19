"""Background sweeper for temporary chats (Phase Z1).

Hard-deletes ``conversations`` rows whose ``expires_at`` has elapsed.
Cascade-deletes their messages, attachments, shares, etc. via the
existing ``ON DELETE CASCADE`` foreign keys, so this module never has
to touch dependent tables itself.

Runs as a single ``asyncio.Task`` started from the FastAPI lifespan;
poll interval is conservative (5 minutes) because the listing endpoint
already lazy-filters expired rows, so the sweeper is purely a
bookkeeping concern. Each pass logs how many rows it reaped (or
silently does nothing on a quiet system).

Failures are caught and logged so a transient DB hiccup doesn't kill
the loop — the next tick simply tries again.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select

from app.chat.models import Conversation
from app.database import SessionLocal

logger = logging.getLogger(__name__)

# How often to sweep. Five minutes is a sensible compromise: short
# enough that "deleted" rows don't linger forever, long enough that
# the query cost is negligible even on busy instances.
SWEEP_INTERVAL_SECONDS = 5 * 60


async def _sweep_once() -> int:
    """Delete every conversation past its ``expires_at``. Returns count."""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        # SELECT first so we can log how many rows we reaped without
        # round-tripping for ``RETURNING`` (which SQLAlchemy supports
        # but adds noise to the logs for the common zero-row case).
        result = await db.execute(
            select(Conversation.id).where(
                Conversation.expires_at.is_not(None),
                Conversation.expires_at <= now,
            )
        )
        ids = [row[0] for row in result.all()]
        if not ids:
            return 0
        await db.execute(
            delete(Conversation).where(Conversation.id.in_(ids))
        )
        await db.commit()
    return len(ids)


async def _sweep_loop() -> None:
    """Sweep forever. Cancellation propagates up cleanly via lifespan."""
    while True:
        try:
            reaped = await _sweep_once()
            if reaped:
                logger.info(
                    "temporary-chat sweeper reaped %d expired conversation(s)",
                    reaped,
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            # A transient failure (DB blip, locked table) shouldn't
            # kill the loop. Log with stack and try again on the next tick.
            logger.exception("temporary-chat sweeper failed; will retry")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def start_sweeper() -> asyncio.Task[None]:
    """Spawn the sweeper as a detached task. Caller stores the handle
    and ``cancel()``s it on shutdown so we don't leak the loop in
    test runs."""
    return asyncio.create_task(_sweep_loop(), name="temporary_chat_sweeper")
