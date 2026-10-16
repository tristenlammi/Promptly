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
from typing import Any

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
    # Sheets and whiteboards not counted yet: they count from
    # ``app_settings.office_quota_from`` (0189), 30 days after the upgrade.
    office_pending_bytes: int = 0
    # Earlier versions of office files (WP-6.2): counted in ``used_bytes``
    # from ``versions_from``; before that, free (shown, not counted).
    versions_bytes: int = 0
    versions_counted: bool = False
    versions_from: Any = None

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


async def _current_usage_bytes(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """(bytes of the user's files, of which sheets + whiteboards).

    Derived rows (``HIDDEN_KINDS``: the AI's text mirrors, a document's
    inline media) don't count — they're copies of content counted
    elsewhere. Sheet and whiteboard shells carry their real state size
    (Part C §3.3) — that content used to be free."""
    from sqlalchemy import case, or_

    from app.files.generated_kinds import HIDDEN_KINDS, GeneratedKind

    office = (GeneratedKind.SHEET.value, GeneratedKind.WHITEBOARD.value)
    # document_asset bytes stay counted: they're real uploads.
    derived = sorted(HIDDEN_KINDS - {GeneratedKind.DOCUMENT_ASSET.value})
    stmt = select(
        func.coalesce(func.sum(UserFile.size_bytes), 0),
        func.coalesce(
            func.sum(case((UserFile.source_kind.in_(office), UserFile.size_bytes), else_=0)), 0
        ),
    ).where(
        UserFile.user_id == user_id,
        or_(UserFile.source_kind.is_(None), UserFile.source_kind.not_in(derived)),
    )
    total, office_bytes = (await db.execute(stmt)).one()
    return int(total or 0), int(office_bytes or 0)


async def _versions_bytes(db: AsyncSession, user_id: uuid.UUID) -> int:
    from app.files.models import FileVersion

    return int(
        await db.scalar(
            select(func.coalesce(func.sum(FileVersion.size_bytes), 0))
            .join(UserFile, UserFile.id == FileVersion.file_id)
            .where(UserFile.user_id == user_id)
        )
        or 0
    )


async def get_quota(db: AsyncSession, user: User) -> StorageQuota:
    """One-shot quota snapshot — used both at upload time and by the API."""
    from datetime import datetime, timezone

    cap = await _effective_cap(db, user)
    used, office = await _current_usage_bytes(db, user.id)
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    now = datetime.now(timezone.utc)
    start = row.office_quota_from if row is not None else None
    pending = office if start is not None and now < start else 0
    versions = await _versions_bytes(db, user.id)
    v_from = row.versions_quota_from if row is not None else None
    v_counted = v_from is None or now >= v_from
    return StorageQuota(
        cap_bytes=cap,
        used_bytes=used - pending + (versions if v_counted else 0),
        office_pending_bytes=pending,
        versions_bytes=versions,
        versions_counted=v_counted,
        versions_from=v_from,
    )


__all__ = ["StorageQuota", "get_quota"]
