"""Who can see a note — the one definition (``docs/notes-plan.md`` §5, §8).

* :func:`can_open` — the user is the note's owner or one of its members,
  and the note isn't trashed (a trashed note is the owner's alone, in
  Trash).
* :func:`visible_predicate` — its SQL twin, for listings and search.

Every reader goes through these: the API, search, tags, links, the live
stream, push. Anything else — a removed member, a stranger, a guessed id —
gets **404**, never 403, so a note's existence can't be probed.

Sharing is only with named people on this server; there's no link table
and no public route. :func:`sharing_refused` is the single place that says
whether two people may share (blocks).
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.people import blocks

from .models import Note, NoteMember


def not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That note isn't here.")


def visible_predicate(user_id: uuid.UUID):  # noqa: ANN201 — a SQL expression
    """Notes ``user_id`` can open (owner or member, not trashed)."""
    member = exists().where(NoteMember.note_id == Note.id, NoteMember.user_id == user_id)
    return (Note.trashed_at.is_(None)) & or_(Note.owner_id == user_id, member)


async def is_member(db: AsyncSession, note_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return await db.get(NoteMember, (note_id, user_id)) is not None


async def can_open(db: AsyncSession, user: User | uuid.UUID, note: Note | uuid.UUID | None) -> bool:
    uid = user.id if isinstance(user, User) else user
    if isinstance(note, uuid.UUID):
        note = await db.get(Note, note)
    if note is None or note.trashed_at is not None:
        return False
    return note.owner_id == uid or await is_member(db, note.id, uid)


async def load(db: AsyncSession, user: User, note_id: uuid.UUID, *, lock: bool = False, trashed: bool = False) -> Note:
    """The note, if ``user`` can open it, else 404. ``trashed`` instead
    finds one of the owner's own notes in Trash (and only that)."""
    stmt = select(Note).where(Note.id == note_id)
    if lock:
        stmt = stmt.with_for_update()
    note = (await db.execute(stmt)).scalar_one_or_none()
    if note is None:
        raise not_found()
    if trashed:
        if note.trashed_at is None or note.owner_id != user.id:
            raise not_found()
        return note
    if not await can_open(db, user, note):
        raise not_found()
    return note


async def participants(db: AsyncSession, note: Note) -> list[uuid.UUID]:
    """The owner and every member."""
    rows = (await db.execute(select(NoteMember.user_id).where(NoteMember.note_id == note.id))).scalars().all()
    return [note.owner_id, *rows]


async def sharing_refused(db: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> bool:
    """True when ``a`` and ``b`` mustn't share a note: either has blocked the
    other. **The single hook** for sharing rules between two people.

    Blocks are the shared ``user_blocks`` (``app/people/blocks.py``, 0321).
    """
    return await blocks.either(db, a, b)


async def refusal(db: AsyncSession, owner_id: uuid.UUID, other: User) -> str:
    """What the owner is told when :func:`sharing_refused` says no. Kind,
    and it never tells anyone they've been blocked: only the person who
    did the blocking hears about it (and how to undo it)."""
    if await blocks.has_blocked(db, owner_id, other.id):
        return (
            f"You've blocked {other.username}, so you can't share notes with them. "
            "You can unblock them in Account → Security → Blocked people."
        )
    return f"{other.username} can't be added to this note."


__all__ = ["can_open", "is_member", "load", "not_found", "participants", "refusal", "sharing_refused", "visible_predicate"]
