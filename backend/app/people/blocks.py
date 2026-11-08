"""Blocking people (``user_blocks``, 0321) — shared by every app.

A block is one person's private choice: the blocked person is never told.
What it does, app by app:

* **Pushes** — ``notifications/dispatch`` drops any push (and its inbox
  row) whose ``actor_user_id`` is blocked by, or has blocked, the
  recipient. Every app gets that for free by passing ``actor_user_id``.
* **Rooms** — no new 1:1 conversations between the two people and no new
  messages in an existing one, both ways (:func:`dm_refusal`). Spaces and
  group conversations are unchanged.
* Later apps (Porch, Calls, Notes, Forms) use :func:`either`,
  :func:`hidden_ids` or :func:`either_sql` the same way.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, and_, delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserBlock(Base):
    __tablename__ = "user_blocks"

    blocker_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    blocked_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.current_timestamp())


async def has_blocked(db: AsyncSession, blocker_id: uuid.UUID, blocked_id: uuid.UUID) -> bool:
    """Did ``blocker_id`` block ``blocked_id``? (One way.)"""
    return await db.get(UserBlock, (blocker_id, blocked_id)) is not None


async def either(db: AsyncSession, a: uuid.UUID | None, b: uuid.UUID | None) -> bool:
    """Is there a block between ``a`` and ``b``, whichever way round?"""
    if a is None or b is None or a == b:
        return False
    q = select(
        exists().where(
            or_(
                and_(UserBlock.blocker_id == a, UserBlock.blocked_id == b),
                and_(UserBlock.blocker_id == b, UserBlock.blocked_id == a),
            )
        )
    )
    return bool((await db.execute(q)).scalar())


async def blocked_by_me(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    """The people ``user_id`` has blocked."""
    return set((await db.execute(select(UserBlock.blocked_id).where(UserBlock.blocker_id == user_id))).scalars().all())


async def hidden_ids(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    """Everyone with a block either way with ``user_id`` — for pickers and
    lists that should leave them out."""
    a = select(UserBlock.blocked_id).where(UserBlock.blocker_id == user_id)
    b = select(UserBlock.blocker_id).where(UserBlock.blocked_id == user_id)
    return set((await db.execute(a.union(b))).scalars().all())


def either_sql(me, other):  # noqa: ANN001, ANN201 — SQL expressions
    """``EXISTS`` a block either way between two SQL expressions (a bound
    id, a column), for ``WHERE NOT …`` in queries."""
    return exists().where(
        or_(
            and_(UserBlock.blocker_id == me, UserBlock.blocked_id == other),
            and_(UserBlock.blocker_id == other, UserBlock.blocked_id == me),
        )
    )


async def block(db: AsyncSession, blocker_id: uuid.UUID, blocked_id: uuid.UUID) -> None:
    """Idempotent. The caller commits."""
    await db.execute(insert(UserBlock).values(blocker_id=blocker_id, blocked_id=blocked_id).on_conflict_do_nothing())


async def unblock(db: AsyncSession, blocker_id: uuid.UUID, blocked_id: uuid.UUID) -> bool:
    """True when there was a block to remove. The caller commits."""
    got = await db.execute(
        delete(UserBlock).where(UserBlock.blocker_id == blocker_id, UserBlock.blocked_id == blocked_id).returning(UserBlock.blocked_id)
    )
    return got.first() is not None


# ------------------------------------------------------------------ Rooms (decision D7)

#: Shown to the person who blocked: they know, and can undo it.
YOU_BLOCKED = "You've blocked this person. Unblock them to send messages."
#: Shown to the blocked person: says nothing about a block.
CANT_SEND = "Messages can't be sent in this conversation."


async def dm_refusal(db: AsyncSession, sender_id: uuid.UUID, other_id: uuid.UUID) -> str | None:
    """Why ``sender_id`` can't message ``other_id`` one-to-one, or None.
    The wording for the blocked person never mentions a block."""
    if await has_blocked(db, sender_id, other_id):
        return YOU_BLOCKED
    if await has_blocked(db, other_id, sender_id):
        return CANT_SEND
    return None
