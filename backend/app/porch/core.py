"""Porch's shared pieces: the Everyone group, people as JSON, profiles,
errors and the live channel (one Redis channel per person, ``porch:u:<id>``;
events carry ids only, never content — the client refetches through the
checked endpoints)."""
from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .models import PorchGroup, PorchGroupMember, PorchProfile

logger = logging.getLogger("promptly.porch")

EVERYONE_NAME = "Everyone"
EVERYONE_EMOJI = "\U0001F30F"
# A fixed id (the migration uses the same), so Everyone is the same group
# however and whenever it was made.
EVERYONE_ID = uuid.uuid5(uuid.NAMESPACE_URL, "promptly:porch:everyone")


def now() -> datetime:
    return datetime.now(timezone.utc)


def not_found(what: str = "Post") -> HTTPException:
    # Gone, never existed, or not shared with you: all the same.
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


# ------------------------------------------------------------------ Everyone


async def everyone(db: AsyncSession) -> PorchGroup:
    """The built-in Everyone group (made here too when it's missing, so a
    restored or fresh database can't be without it)."""
    q = select(PorchGroup).where(PorchGroup.kind == "everyone")
    row = (await db.execute(q)).scalar_one_or_none()
    if row is not None:
        return row
    from sqlalchemy.dialects.postgresql import insert

    await db.execute(
        insert(PorchGroup)
        .values(id=EVERYONE_ID, kind="everyone", visibility="public", name=EVERYONE_NAME, emoji=EVERYONE_EMOJI)
        .on_conflict_do_nothing()
    )
    return (await db.execute(q)).scalar_one()


async def everyone_settings(db: AsyncSession, group: PorchGroup, user_id: uuid.UUID) -> PorchGroupMember:
    """Your Everyone row: it only keeps your feed tick and bell."""
    from sqlalchemy.dialects.postgresql import insert

    row = await db.get(PorchGroupMember, (group.id, user_id))
    if row is None:
        await db.execute(
            insert(PorchGroupMember)
            .values(group_id=group.id, user_id=user_id, role="member", status="member", in_feed=True, notify="none")
            .on_conflict_do_nothing()
        )
        row = await db.get(PorchGroupMember, (group.id, user_id))
    return row  # type: ignore[return-value]


# ------------------------------------------------------------------ people


def display_name(u: User) -> str:
    return str((u.settings or {}).get("display_name") or "").strip() or u.username


def user_out(u: User) -> dict[str, Any]:
    from app.auth.avatars import effective_color

    return {
        "id": str(u.id),
        "username": u.username,
        "name": display_name(u),
        "avatar_url": u.avatar_url,
        "color": effective_color(u),
    }


async def users_map(db: AsyncSession, ids: Iterable[uuid.UUID | None]) -> dict[str, dict[str, Any]]:
    want = {i for i in ids if i is not None}
    if not want:
        return {}
    rows = (await db.execute(select(User).where(User.id.in_(want)))).scalars().all()
    return {str(u.id): user_out(u) for u in rows}


async def profile(db: AsyncSession, user_id: uuid.UUID) -> PorchProfile:
    """Your Porch profile row (made on first need). Flushed."""
    from sqlalchemy.dialects.postgresql import insert

    row = await db.get(PorchProfile, user_id)
    if row is None:
        await db.execute(insert(PorchProfile).values(user_id=user_id).on_conflict_do_nothing())
        row = await db.get(PorchProfile, user_id)
    return row  # type: ignore[return-value]


# ------------------------------------------------------------------ live


def channel(user_id: uuid.UUID | str) -> str:
    return f"porch:u:{user_id}"


async def publish(user_ids: Iterable[uuid.UUID | str], event: dict[str, Any]) -> None:
    """Best-effort: a dead Redis never fails a write."""
    from app.redis_client import redis

    data = json.dumps(event, default=str)
    for uid in {str(u) for u in user_ids}:
        try:
            await redis.publish(channel(uid), data)
        except Exception:  # noqa: BLE001
            logger.debug("porch publish failed", exc_info=True)


__all__ = [
    "EVERYONE_EMOJI", "EVERYONE_ID", "EVERYONE_NAME", "bad", "channel", "display_name", "everyone", "everyone_settings", "forbidden",
    "not_found", "now", "profile", "publish", "user_out", "users_map",
]
