"""Facts and the people they're about, joined by name.

Your Contacts and Photos already know that Sam is your brother and Alex is your wife, so
"what should I get my wife?" can find a fact that only says "Alex". Worked out when it's
needed rather than stored, so renaming someone in Contacts just works.
"""
from __future__ import annotations

import logging
import re
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.memory.models import UserMemory
from app.memory.service import in_use

logger = logging.getLogger("promptly.memory.people")


def what_they_go_by(person) -> set[str]:
    """Everything this person is called, in lowercase. Too-short names match too much."""
    names: set[str] = set()
    for name in (person.name, person.person_name, person.label):
        if name:
            names.add(name.strip().lower())
    contact = person.contact or {}
    for key in ("first", "nickname"):
        if contact.get(key):
            names.add(str(contact[key]).strip().lower())
    return {n for n in names if len(n) >= 2 and n != "someone"}


def _says(text_: str, name: str) -> bool:
    return re.search(rf"(?<![^\W_]){re.escape(name)}(?![^\W_])", text_, re.UNICODE) is not None


async def everyone(db: AsyncSession, user: User) -> list:
    """Never gets in the way of a chat: without it, facts are still found by their words."""
    from app.people.directory import directory

    try:
        async with db.begin_nested():
            return await directory(db, user)
    except Exception as e:  # noqa: BLE001
        logger.info("Couldn't read the people directory (%s)", type(e).__name__)
        return []


async def widen_query(db: AsyncSession, user: User, query: str) -> str:
    """"my wife" also looks for Alex, and "Alex" also looks for what she is to you."""
    lowered = (query or "").lower()
    if not lowered:
        return query
    extra: set[str] = set()
    for person in await everyone(db, user):
        names = what_they_go_by(person)
        if any(_says(lowered, n) for n in names):
            extra |= {n for n in names if not _says(lowered, n)}
    return f"{query}\n{' '.join(sorted(extra))}" if extra else query


async def facts_about(db: AsyncSession, user: User, person, *, limit: int = 12) -> list[str]:
    names = what_they_go_by(person)
    rows = (await db.execute(select(UserMemory.content).where(*in_use(user.id, None)).order_by(UserMemory.created_at.desc()))).scalars()
    return [c for c in rows if any(_says(c.lower(), n) for n in names)][:limit]


async def links_for_panel(db: AsyncSession, user: User) -> dict[uuid.UUID, list[str]]:
    """Who each fact is about, for showing beside it."""
    people = [(p.name, what_they_go_by(p)) for p in await everyone(db, user)]
    if not people:
        return {}
    rows = (await db.execute(select(UserMemory.id, UserMemory.content).where(*in_use(user.id)))).all()
    out: dict[uuid.UUID, list[str]] = {}
    for fact_id, content in rows:
        lowered = content.lower()
        about = [name for name, names in people if any(_says(lowered, n) for n in names)]
        if about:
            out[fact_id] = about[:3]
    return out
