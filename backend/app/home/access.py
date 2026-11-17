"""Who looks after a home.

The home's owner manages it: its automations, and (elsewhere) its brands,
rooms and boxes. One place decides who that is, so "owner or co-owner" is a
change to :data:`MANAGER_ROLES` and nothing else.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from .models import HomeMember

# The roles (``home_members.role``) that may change a home's automations.
MANAGER_ROLES: frozenset[str] = frozenset({"owner"})
ONLY_MANAGER = "Only the home's owner can do that."


def manages(role: str | None) -> bool:
    return role in MANAGER_ROLES


async def role_in(db: AsyncSession, user_id: uuid.UUID, home_id: uuid.UUID) -> str | None:
    """This person's role in this home, or None when they aren't in it."""
    row = await db.get(HomeMember, (home_id, user_id))
    return row.role if row is not None else None
