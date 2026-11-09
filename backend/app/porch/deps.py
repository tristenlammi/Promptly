"""Who may use Porch at all: the admin's switch and user-group list.

``require_porch`` runs before every Porch route; for someone Porch isn't on
for, Porch doesn't exist (404). Everyone who passes it is in the Everyone
group, which is why Everyone needs no member rows.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import Depends, HTTPException, status
from sqlalchemy import and_, exists, false, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

OFF_DETAIL = "Porch isn't turned on for you"


async def settings(db: AsyncSession) -> Any:
    """The app settings row, or None (a fresh test database): defaults."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    return await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)


def _group_ids(s: Any) -> list[uuid.UUID] | None:
    raw = getattr(s, "porch_user_group_ids", None) if s is not None else None
    if raw is None:
        return None
    out = []
    for v in raw:
        try:
            out.append(uuid.UUID(str(v)))
        except ValueError:
            continue
    return out


def allowed_clause(s: Any, user_col=None):  # noqa: ANN001, ANN201 — SQL
    """SQL: the user in ``user_col`` (default ``users.id``) may use Porch.
    Disabled accounts never may."""
    from app.groups.models import UserGroupMember

    col = user_col if user_col is not None else User.id
    if s is not None and not s.porch_enabled:
        return false()
    ids = _group_ids(s)
    u = aliased(User)
    base = exists().where(u.id == col, u.disabled.is_(False))
    if ids is None:
        return base
    return and_(base, exists().where(UserGroupMember.user_id == col, UserGroupMember.group_id.in_(ids)))


async def allowed(db: AsyncSession, user: User | uuid.UUID) -> bool:
    """May this person use Porch?"""
    s = await settings(db)
    if s is not None and not s.porch_enabled:
        return False
    if isinstance(user, uuid.UUID):
        row = await db.get(User, user)
        if row is None:
            return False
        user = row
    if user.disabled:
        return False
    ids = _group_ids(s)
    if ids is None:
        return True
    if not ids:
        return False
    from app.groups.models import UserGroupMember

    q = select(exists().where(UserGroupMember.user_id == user.id, UserGroupMember.group_id.in_(ids)))
    return bool((await db.execute(q)).scalar())


async def require_porch(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> User:
    if not await allowed(db, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=OFF_DETAIL)
    return user


__all__ = ["OFF_DETAIL", "allowed", "allowed_clause", "require_porch", "settings"]
