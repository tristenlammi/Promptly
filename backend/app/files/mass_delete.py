"""A guard against one device deleting everything (WP-7.2, Part C §5.4).

A stolen session, a sync client gone wrong or a mis-click on a big
selection can send thousands of files to the trash in minutes. Every trash
records who and which credential did it (``trashed_by`` /
``trashed_credential`` — :func:`stamp`). When one credential trashes more
than ``MAX_FILES`` files or ``MAX_BYTES`` within ``WINDOW``, the owner is
told at once and offered :func:`restore_credential` — "restore everything
this device deleted" — from the link in the alert.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileFolder, UserFile

logger = logging.getLogger("promptly.files.mass_delete")

WINDOW = timedelta(minutes=10)
MAX_FILES = 500
MAX_BYTES = 5 * 1024**3
# How far back "restore everything" reaches.
RESTORE_WINDOW = timedelta(hours=48)


def credential_or_user(user) -> str:  # noqa: ANN001 — User
    from app.auth.credential import current_credential

    return current_credential() or f"user:{user.id}"


def stamp(user) -> dict[str, Any]:  # noqa: ANN001
    """The columns to set alongside ``trashed_at``."""
    return {"trashed_by": user.id, "trashed_credential": credential_or_user(user)}


def apply(row, user) -> None:  # noqa: ANN001 — UserFile / FileFolder
    for k, v in stamp(user).items():
        setattr(row, k, v)


async def check(db: AsyncSession, user) -> bool:  # noqa: ANN001
    """After a trash: has this credential gone over the limit? Tells the
    owner (once an hour per credential). Returns whether it alerted."""
    cred = credential_or_user(user)
    since = datetime.now(timezone.utc) - WINDOW
    n, size = (
        await db.execute(
            select(func.count(UserFile.id), func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
                UserFile.trashed_by == user.id,
                UserFile.trashed_credential == cred,
                UserFile.trashed_at >= since,
            )
        )
    ).one()
    if n <= MAX_FILES and size <= MAX_BYTES:
        return False
    if not await _first_this_hour(user.id, cred):
        return False
    try:
        from app.notifications.dispatch import notify_user

        gb = size / 1024**3
        amount = f"{n} files ({gb:.1f} GB)" if gb >= 0.1 else f"{n} files"
        minutes = int(WINDOW.total_seconds() // 60)
        device = await _device_name(db, cred)
        if device:
            # A sync client (WP-8.4): usually a folder deleted on the device.
            body = (
                f"{amount} went to the trash from “{device}” in the last {minutes} minutes. "
                "If that wasn't meant to happen, restore them all — and revoke the device in "
                "Account → Devices if you don't recognise it."
            )
        else:
            body = (
                f"{amount} went to the trash from one device in the last {minutes} "
                "minutes. If that wasn't you, restore them all and change your password."
            )
        await notify_user(
            user_id=user.id,
            category="system_alert",
            title="A lot of your files were just deleted",
            body=body,
            url=f"/files/trash?restore={cred}",
        )
    except Exception:  # noqa: BLE001 — the alert must never break the delete
        logger.warning("mass-delete alert for %s failed", user.id, exc_info=True)
    logger.warning("mass delete: user %s credential %s trashed %d files / %d bytes", user.id, cred, n, size)
    return True


async def _device_name(db: AsyncSession, cred: str) -> str | None:
    """The device behind an app-password credential (WP-8.3)."""
    if not cred.startswith("app_password:"):
        return None
    from app.auth.app_passwords import AppPassword

    try:
        row = await db.get(AppPassword, uuid.UUID(cred.split(":", 1)[1]))
    except ValueError:
        return None
    return row.name if row is not None else None


async def _first_this_hour(user_id: uuid.UUID, cred: str) -> bool:
    try:
        from app.redis_client import redis

        return bool(await redis.set(f"mass_delete:{user_id}:{cred}", "1", nx=True, ex=3600))
    except Exception:  # noqa: BLE001
        return True


async def summary(db: AsyncSession, user, cred: str) -> dict[str, int]:  # noqa: ANN001
    since = datetime.now(timezone.utc) - RESTORE_WINDOW
    files = (
        await db.execute(
            select(func.count(UserFile.id), func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
                UserFile.trashed_by == user.id, UserFile.trashed_credential == cred,
                UserFile.trashed_at >= since, UserFile.user_id == user.id,
            )
        )
    ).one()
    folders = (
        await db.execute(
            select(func.count(FileFolder.id)).where(
                FileFolder.trashed_by == user.id, FileFolder.trashed_credential == cred,
                FileFolder.trashed_at >= since, FileFolder.user_id == user.id,
            )
        )
    ).scalar_one()
    return {"files": int(files[0]), "bytes": int(files[1]), "folders": int(folders)}


async def restore_credential(db: AsyncSession, user, cred: str) -> dict[str, int]:  # noqa: ANN001
    """Put back everything of ``user``'s that ``cred`` trashed in the last
    48 hours. Commits."""
    since = datetime.now(timezone.utc) - RESTORE_WINDOW
    clear = {"trashed_at": None, "trashed_by": None, "trashed_credential": None}
    folders = await db.execute(
        update(FileFolder)
        .where(
            FileFolder.user_id == user.id, FileFolder.trashed_credential == cred,
            FileFolder.trashed_at >= since,
        )
        .values(**clear)
    )
    files = await db.execute(
        update(UserFile)
        .where(
            UserFile.user_id == user.id, UserFile.trashed_credential == cred,
            UserFile.trashed_at >= since,
        )
        .values(**clear)
    )
    await db.commit()
    return {"files": int(files.rowcount or 0), "folders": int(folders.rowcount or 0)}


__all__ = ["MAX_BYTES", "MAX_FILES", "WINDOW", "apply", "check", "restore_credential", "stamp", "summary"]
