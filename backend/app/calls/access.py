"""Who may use voice: the one definition every Calls route asks.

Voice off for the server, or for you (``calls_group_ids``), makes every
voice route a 404, the same answer as for something you can't see. Calls
borrow access from Rooms for channels (WP-V2 adds ``can_join`` etc. here);
they never widen it.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.rtc import config as rtc_config

STREAM_CHOICES = ("720p30", "1080p30", "1080p60")
MAX_PARTICIPANTS_RANGE = (2, 99)


@dataclass
class CallsSettings:
    enabled: bool
    group_ids: list[uuid.UUID] | None
    max_participants: int
    max_stream: str


async def load_settings(db: AsyncSession) -> CallsSettings:
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        return CallsSettings(False, None, 30, "1080p60")
    groups = None
    if row.calls_group_ids is not None:
        groups = []
        for g in row.calls_group_ids:
            try:
                groups.append(uuid.UUID(str(g)))
            except ValueError:
                continue
    return CallsSettings(
        enabled=bool(row.calls_enabled),
        group_ids=groups,
        max_participants=int(row.calls_max_participants or 30),
        max_stream=row.calls_max_stream if row.calls_max_stream in STREAM_CHOICES else "1080p60",
    )


async def voice_allowed(db: AsyncSession, user: User, settings: CallsSettings | None = None) -> bool:
    """Calls are set up, on for the server, and on for this person."""
    if not rtc_config.configured():
        return False
    s = settings or await load_settings(db)
    if not s.enabled:
        return False
    if s.group_ids is None or user.role == "admin":
        return True
    if not s.group_ids:
        return False
    from app.groups.models import UserGroupMember

    hit = await db.execute(
        select(UserGroupMember.user_id)
        .where(UserGroupMember.user_id == user.id, UserGroupMember.group_id.in_(s.group_ids))
        .limit(1)
    )
    return hit.first() is not None


def not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


async def require_voice(db: AsyncSession, user: User) -> CallsSettings:
    s = await load_settings(db)
    if not await voice_allowed(db, user, s):
        raise not_found()
    return s


async def can_test(db: AsyncSession, user: User) -> bool:
    """Test calls: anyone who may use voice, and admins before it's on
    (the checklist sends them there to prove it works first)."""
    if not rtc_config.configured():
        return False
    return user.role == "admin" or await voice_allowed(db, user)
