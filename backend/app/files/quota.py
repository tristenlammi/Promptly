"""Per-user storage cap helpers (Phase 3.1).

The cap is a billing-style "total bytes you can occupy in your private
file pool". Shared-pool blobs (``UserFile.user_id IS NULL``) don't
count — those are admin-managed and uncapped.

Resolution order, picked at every check:

1. ``users.storage_cap_bytes`` if non-NULL → that wins, including
   ``0`` ("user gets nothing", useful for offboarding).
2. ``app_settings.default_storage_cap_bytes`` if non-NULL → org default.
3. ``None`` → unlimited. We default-deploy to unlimited so an upgrade
   from a pre-Phase-3 instance doesn't suddenly start rejecting
   uploads from users who were previously fine.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.files.models import UserFile


@dataclass(frozen=True, slots=True)
class StorageQuota:
    """Effective cap + current usage for one user.

    ``cap_bytes is None`` means unlimited. ``used_bytes`` is always
    a real number, even when the cap is None — the admin UI surfaces
    it so an operator can spot heavy users before they hit a wall.
    """

    cap_bytes: int | None
    used_bytes: int

    @property
    def remaining_bytes(self) -> int | None:
        if self.cap_bytes is None:
            return None
        return max(0, self.cap_bytes - self.used_bytes)

    def can_fit(self, additional_bytes: int) -> bool:
        if self.cap_bytes is None:
            return True
        # ``additional_bytes`` is what we're about to write; ``used``
        # is what's already on disk for this user. Exact equality is
        # accepted (filling the cap to the byte is fine).
        return self.used_bytes + max(0, additional_bytes) <= self.cap_bytes


async def _effective_cap(db: AsyncSession, user: User) -> int | None:
    """Resolve the cap that applies to ``user`` right now."""
    if user.storage_cap_bytes is not None:
        return user.storage_cap_bytes
    settings_row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings_row is None:
        return None
    return settings_row.default_storage_cap_bytes


async def _current_usage_bytes(db: AsyncSession, user_id: uuid.UUID) -> int:
    """SUM(``size_bytes``) over the user's private files. 0 if none."""
    stmt = select(func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
        UserFile.user_id == user_id
    )
    result = await db.execute(stmt)
    return int(result.scalar_one() or 0)


async def get_quota(db: AsyncSession, user: User) -> StorageQuota:
    """One-shot quota snapshot — used both at upload time and by the API."""
    cap = await _effective_cap(db, user)
    used = await _current_usage_bytes(db, user.id)
    return StorageQuota(cap_bytes=cap, used_bytes=used)


__all__ = ["StorageQuota", "get_quota"]
