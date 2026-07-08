"""Background backstop for Chat Uploads orphan pruning (D4).

The primary prune trigger is synchronous — deleting a conversation
immediately trashes any of its now-unreferenced uploads (see
``delete_conversation``). This sweeper is the safety net for the paths
that don't route through a conversation delete: an in-place message edit
that drops an attachment, a partially-failed delete, or uploads left
behind by older builds before pruning existed.

It walks every user who still has live files in a Chat Uploads folder
and runs :func:`prune_orphaned_chat_uploads` for each. The interval is
deliberately long — chat uploads don't churn fast and the delete hook
already handles the common case, so this only needs to catch stragglers.

Mirrors ``temporary_sweeper``: a single lifespan-owned ``asyncio.Task``
that logs what it reaped and shrugs off transient DB errors.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import distinct, select

from app.database import SessionLocal
from app.files.chat_upload_prune import prune_orphaned_chat_uploads
from app.files.models import FileFolder, UserFile
from app.files.system_folders import SystemKind

logger = logging.getLogger(__name__)

# Six hours: the conversation-delete hook covers the common case in
# real time, so this backstop only needs to mop up the rare edit /
# failed-delete straggler. Long interval keeps the cross-user scan cheap.
SWEEP_INTERVAL_SECONDS = 6 * 60 * 60


async def _sweep_once() -> int:
    """Prune orphaned uploads for every user who has any. Returns total."""
    async with SessionLocal() as db:
        user_ids = (
            (
                await db.execute(
                    select(distinct(FileFolder.user_id))
                    .select_from(UserFile)
                    .join(FileFolder, UserFile.folder_id == FileFolder.id)
                    .where(
                        FileFolder.system_kind == SystemKind.CHAT_UPLOADS.value,
                        UserFile.trashed_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
    total = 0
    for user_id in user_ids:
        # Fresh session per user so one user's failure can't poison the
        # rest of the sweep, and long scans don't hold a single txn open.
        try:
            async with SessionLocal() as db:
                total += await prune_orphaned_chat_uploads(db, user_id)
        except Exception:  # pragma: no cover - defensive
            logger.exception(
                "chat-uploads prune failed for user %s; continuing", user_id
            )
    return total


async def _sweep_loop() -> None:
    """Sweep forever. Cancellation propagates up cleanly via lifespan."""
    while True:
        try:
            reaped = await _sweep_once()
            if reaped:
                logger.info(
                    "chat-uploads sweeper trashed %d orphan upload(s)", reaped
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            logger.exception("chat-uploads sweeper failed; will retry")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def start_chat_upload_sweeper() -> asyncio.Task[None]:
    """Spawn the sweeper as a detached task; caller cancels on shutdown."""
    return asyncio.create_task(_sweep_loop(), name="chat_upload_sweeper")
