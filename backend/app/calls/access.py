"""Who may use voice: the one definition every Calls route asks.

Voice off for the server, or for you (``calls_group_ids``), makes every
voice route a 404, the same answer as for something you can't see. Calls
borrow access from Rooms for channels (``rooms/core.py::load_room``); they
never widen it:

* See a voice channel and who's in it: members of the space.
* Join: members, unless the channel says admins only; not when it's full
  (owners and admins may go over the channel's user limit, never over the
  server's ``calls_max_participants``).
* Talk, camera, Go Live: per the channel's talk role and video switch, and
  not while server-muted (that part is enforced by the LiveKit token and
  ``UpdateParticipant``, see ``app.calls.voice``).
* Moderate (server-mute/deafen, move, disconnect): the space's owner and
  admins; an admin can't moderate the owner or another admin.

Blocks (``app.people.blocks``, decision D7) don't apply inside voice
channels in spaces: a block closes 1:1 conversations, not shared spaces, so
two people who blocked each other can still be in the same channel. (Muting
someone for yourself is the client's per-person "Mute for me".)
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


# ---------------------------------------------------------------- voice channels


def is_space_admin(sm) -> bool:  # noqa: ANN001 — RoomSpaceMember | None
    return sm is not None and sm.role in ("owner", "admin")


def can_join(voice, sm) -> bool:  # noqa: ANN001 — RoomVoice, RoomSpaceMember
    """May this space member join the channel at all (fullness aside)?"""
    if sm is None:
        return False
    return voice.join_role != "admin" or is_space_admin(sm)


def can_talk(voice, sm) -> bool:  # noqa: ANN001
    """May they publish their microphone (server-mute aside)?"""
    if sm is None:
        return False
    return voice.talk_role != "admin" or is_space_admin(sm)


def can_video(voice, sm) -> bool:  # noqa: ANN001
    """Camera and Go Live: the channel allows video and they may talk."""
    return bool(voice.video) and can_talk(voice, sm)


def can_moderate(sm, target_sm=None) -> bool:  # noqa: ANN001
    """Server-mute/deafen, move, disconnect. With ``target_sm``: may this
    admin act on that person (the owner on anyone; admins on members and
    themselves)."""
    if not is_space_admin(sm):
        return False
    if target_sm is None or target_sm.user_id == sm.user_id:
        return True
    return sm.role == "owner" or target_sm.role == "member"


def over_limit(voice, sm, count_others: int, max_participants: int) -> bool:  # noqa: ANN001
    """Would one more person make the channel too full for this person?
    ``count_others``: people in it now, not counting them."""
    if count_others + 1 > max_participants:
        return True
    if voice.user_limit and count_others + 1 > voice.user_limit:
        return not is_space_admin(sm)
    return False


async def voice_user_ids(db: AsyncSession, user_ids: list[uuid.UUID], settings: CallsSettings | None = None) -> set[uuid.UUID]:
    """Which of these people have voice (the SQL twin of
    :func:`voice_allowed`, for fan-out): everyone, or admins and the
    chosen groups' members. Empty when voice is off for the server."""
    if not user_ids or not rtc_config.configured():
        return set()
    s = settings or await load_settings(db)
    if not s.enabled:
        return set()
    if s.group_ids is None:
        return set(user_ids)
    admins = set((await db.execute(select(User.id).where(User.id.in_(user_ids), User.role == "admin"))).scalars().all())
    if not s.group_ids:
        return admins
    from app.groups.models import UserGroupMember

    grouped = set(
        (
            await db.execute(
                select(UserGroupMember.user_id).where(UserGroupMember.user_id.in_(user_ids), UserGroupMember.group_id.in_(s.group_ids))
            )
        ).scalars().all()
    )
    return admins | grouped
