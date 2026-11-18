"""Who looks after a home.

A home's owner and its co-owners run it: its brands, rooms, boxes, music and
automations. Everyone else in it uses it. One place says who that is, for
every part of Home (``manage.py`` and the routers read it from here).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from .models import HomeMember

OWNER, COOWNER, MEMBER = "owner", "coowner", "member"
# The roles (``home_members.role``) that set a home up and change its automations.
RUNS_IT = (OWNER, COOWNER)
MANAGER_ROLES: frozenset[str] = frozenset(RUNS_IT)
ONLY_MANAGER = "Only the home's owner or a co-owner can do that."


def manages(role: str | None) -> bool:
    return role in MANAGER_ROLES


async def role_in(db: AsyncSession, user_id: uuid.UUID, home_id: uuid.UUID) -> str | None:
    """This person's role in this home, or None when they aren't in it."""
    row = await db.get(HomeMember, (home_id, user_id))
    return row.role if row is not None else None
