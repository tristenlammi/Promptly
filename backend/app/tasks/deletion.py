"""Hard-delete a user + all their content — used by the admin delete-user path.

DB-level ``ON DELETE CASCADE`` removes almost everything a user owns
(conversations, messages, file rows, workspaces, study data, tasks, custom
models, knowledge/vector chunks, providers, MFA, push, usage rollups). The ONE
thing that doesn't cascade is the file BYTES on disk — removed explicitly here.
"""
from __future__ import annotations

import logging
import shutil
import uuid

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import UserFile
from app.files.storage import absolute_path

logger = logging.getLogger("promptly.deletion")


def _protected(user: User) -> bool:
    """Never purge an admin — a backstop so the instance owner can't be erased."""
    return user.role == "admin"


async def _remove_user_blobs(user_id: uuid.UUID) -> None:
    """Delete every uploaded byte for a user. All of a user's blobs live under
    the ``u_<id>`` bucket (see ``storage.storage_path_for``), so a single
    ``rmtree`` is complete and safe — ``absolute_path`` refuses any path outside
    the upload root. Runs off-loop because it's blocking disk I/O."""
    try:
        bucket = absolute_path(f"u_{user_id}")
    except ValueError:
        return
    await run_in_threadpool(shutil.rmtree, str(bucket), ignore_errors=True)


async def purge_user(db: AsyncSession, user: User) -> bool:
    """Irreversibly hard-delete a user + all their content. Returns ``True`` if
    purged, ``False`` if refused (admin account). Blobs are removed AFTER the DB
    commit so the two views can't diverge if the process dies mid-way (a
    leftover blob is harmless; a row pointing at a deleted blob is not)."""
    if _protected(user):
        logger.warning(
            "refusing to purge admin account %s (%s)", user.id, user.email
        )
        return False
    uid = user.id
    email = user.email
    file_count = (
        await db.execute(
            select(func.count(UserFile.id)).where(UserFile.user_id == uid)
        )
    ).scalar_one()
    await db.delete(user)  # cascades every DB-side belonging
    await db.commit()
    await _remove_user_blobs(uid)  # bytes on disk don't cascade
    logger.info("purged user %s (%s): %d files", uid, email, file_count)
    return True


__all__ = ["purge_user"]
