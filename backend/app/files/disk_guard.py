"""Don't fill the disk (WP-7.2, Part C §5.4).

A full disk is a data-loss event: Postgres stops, a half-written upload
corrupts, the nightly dump fails. So:

* uploads and imports are refused (507) while free space on the uploads
  disk is below max(``DISK_MIN_FREE_PERCENT`` %, ``DISK_MIN_FREE_GB`` GB) —
  5 % and 10 GB by default; either set to 0 drops that part of the floor;
* admins are told when the disk passes 85 % and 95 % full (once a day per
  level), from the worker's hourly check.
"""
from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, status

from app.files import storage

logger = logging.getLogger("promptly.files.disk_guard")

WARN_PERCENT = 85
CRITICAL_PERCENT = 95


@dataclass
class DiskUsage:
    total: int
    used: int
    free: int
    min_free: int

    @property
    def percent_used(self) -> float:
        return round(100.0 * self.used / self.total, 1) if self.total else 0.0

    @property
    def low(self) -> bool:
        return self.free < self.min_free


def _floor(total: int) -> int:
    def num(name: str, default: float) -> float:
        try:
            return max(float(os.environ.get(name, default)), 0.0)
        except ValueError:
            return default

    pct = num("DISK_MIN_FREE_PERCENT", 5)
    gb = num("DISK_MIN_FREE_GB", 10)
    return int(max(total * pct / 100.0, gb * 1_000_000_000))


def usage() -> DiskUsage:
    root = storage.UPLOAD_ROOT
    probe = root if root.exists() else root.parent
    du = shutil.disk_usage(probe)
    return DiskUsage(total=du.total, used=du.used, free=du.free, min_free=_floor(du.total))


class DiskFull(Exception):
    pass


def ensure_room(incoming: int = 0) -> None:
    """Raise :class:`DiskFull` if writing ``incoming`` more bytes would take
    the disk below the floor."""
    u = usage()
    if u.free - max(incoming, 0) < u.min_free:
        raise DiskFull(
            "The server is nearly out of disk space, so uploads are paused for now. "
            "Your admin has been told."
        )


async def require_disk_room() -> None:
    """FastAPI dependency for upload and import endpoints: 507 when the
    disk is below the floor (checked before a byte is read)."""
    try:
        ensure_room()
    except DiskFull as exc:
        await _alert_low(force_level="full")
        raise HTTPException(status_code=status.HTTP_507_INSUFFICIENT_STORAGE, detail=str(exc)) from exc


async def _notify_admins(title: str, body: str) -> None:
    from sqlalchemy import select

    from app.auth.models import User
    from app.database import SessionLocal
    from app.notifications.dispatch import notify_user

    async with SessionLocal() as db:
        admins = (await db.execute(select(User).where(User.role == "admin", User.disabled.is_(False)))).scalars().all()
    for a in admins:
        try:
            await notify_user(user_id=a.id, category="system_alert", title=title, body=body, url="/admin?tab=storage")
        except Exception:  # noqa: BLE001 — an alert must never break a request
            logger.warning("couldn't alert admin %s about disk space", a.id, exc_info=True)


async def _once_today(level: str) -> bool:
    """True the first time ``level`` is reported today (Redis; without
    Redis, always — better a repeated alert than none)."""
    try:
        from app.redis_client import redis

        key = f"disk_alert:{level}:{datetime.now(timezone.utc):%Y%m%d}"
        return bool(await redis.set(key, "1", nx=True, ex=26 * 3600))
    except Exception:  # noqa: BLE001
        return True


def _gb(n: int) -> str:
    return f"{n / 1_000_000_000:.1f} GB"


async def _alert_low(force_level: str | None = None) -> str | None:
    u = usage()
    level = force_level
    if level is None:
        if u.percent_used >= CRITICAL_PERCENT:
            level = "critical"
        elif u.percent_used >= WARN_PERCENT:
            level = "warning"
    if level is None or not await _once_today(level):
        return None
    if level == "full":
        title = "Uploads are paused — the disk is nearly full"
    elif level == "critical":
        title = f"The disk is {u.percent_used:.0f}% full"
    else:
        title = f"The disk is getting full ({u.percent_used:.0f}%)"
    body = (
        f"{_gb(u.free)} free of {_gb(u.total)} on the uploads disk. Uploads stop below {_gb(u.min_free)} free. "
        "Empty the trash, remove large files, or give Promptly more space."
    )
    await _notify_admins(title, body)
    return level


async def check_and_alert() -> str | None:
    """The worker's hourly check — returns the level it alerted at, if any."""
    try:
        return await _alert_low()
    except Exception:  # noqa: BLE001
        logger.exception("disk check failed")
        return None


__all__ = ["DiskFull", "DiskUsage", "check_and_alert", "ensure_room", "require_disk_room", "usage"]
