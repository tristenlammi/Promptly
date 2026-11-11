"""Labels: a person's own colour-coding for events ("Personal" green,
"Work" blue).

Everything here is private to one person. Your labels are yours; the label
you put on an event is stored per (event, you), so on a shared calendar or
an invitation each person colours the event their own way and nobody sees
anyone else's names or choices. Labels never go into a feed, an email or
anything another person reads. A label is on the event row, so it covers a
whole repeating series.
"""
from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .models import CalEventLabel, CalLabel

MAX_LABELS = 30
# Seeded the first time someone's labels are read; theirs to change after.
DEFAULTS = (("Personal", "#4E9F5B"), ("Work", "#4F7FE0"))  # the app palette's green and blue
# Marks that the defaults were made once (so deleting both doesn't bring them back).
_SEEDED = "calendar_labels_seeded"


def label_out(lb: CalLabel) -> dict:
    return {"id": str(lb.id), "name": lb.name, "color": lb.color, "position": lb.position, "hidden": lb.hidden}


async def mine(db: AsyncSession, user: User) -> list[CalLabel]:
    """Your labels in order, with the two defaults made the first time."""
    rows = list(
        (await db.execute(select(CalLabel).where(CalLabel.user_id == user.id).order_by(CalLabel.position, CalLabel.created_at))).scalars()
    )
    if rows or (user.settings or {}).get(_SEEDED):
        return rows
    for i, (name, color) in enumerate(DEFAULTS):
        db.add(CalLabel(user_id=user.id, name=name, color=color, position=i))
    user.settings = {**(user.settings or {}), _SEEDED: True}
    await db.flush()
    return list(
        (await db.execute(select(CalLabel).where(CalLabel.user_id == user.id).order_by(CalLabel.position, CalLabel.created_at))).scalars()
    )


async def own_label(db: AsyncSession, user: User, label_id: uuid.UUID) -> CalLabel | None:
    """One of your labels, else None (someone else's reads as not there)."""
    lb = await db.get(CalLabel, label_id)
    return lb if lb is not None and lb.user_id == user.id else None


async def by_name(db: AsyncSession, user: User, name: str) -> CalLabel | None:
    """Your label called ``name`` (any case), for the chat tools."""
    want = name.strip().lower()
    return next((lb for lb in await mine(db, user) if lb.name.lower() == want), None)


async def next_position(db: AsyncSession, user: User) -> int:
    top = (await db.execute(select(func.max(CalLabel.position)).where(CalLabel.user_id == user.id))).scalar()
    return (top + 1) if top is not None else 0


async def count(db: AsyncSession, user: User) -> int:
    return int((await db.execute(select(func.count()).select_from(CalLabel).where(CalLabel.user_id == user.id))).scalar() or 0)


async def set_on_event(db: AsyncSession, user: User, event_id: uuid.UUID, label_id: uuid.UUID | None) -> None:
    """Put your label on an event, or take it off (``None``)."""
    if label_id is None:
        await db.execute(delete(CalEventLabel).where(CalEventLabel.event_id == event_id, CalEventLabel.user_id == user.id))
        return
    stmt = pg_insert(CalEventLabel).values(event_id=event_id, user_id=user.id, label_id=label_id)
    await db.execute(stmt.on_conflict_do_update(index_elements=["event_id", "user_id"], set_={"label_id": label_id}))


async def of_events(db: AsyncSession, user: User, event_ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    """Your label on each of these events (only yours)."""
    if not event_ids:
        return {}
    rows = await db.execute(
        select(CalEventLabel.event_id, CalEventLabel.label_id).where(CalEventLabel.user_id == user.id, CalEventLabel.event_id.in_(event_ids))
    )
    return {eid: lid for eid, lid in rows.all()}


async def fill(db: AsyncSession, user: User, outs: list[dict]) -> None:
    """Add ``label_id`` (yours, or None) to event payloads going to ``user``."""
    ids = list({uuid.UUID(o["event_id"]) for o in outs if not o.get("busy_only")})
    have = await of_events(db, user, ids)
    for o in outs:
        lid = None if o.get("busy_only") else have.get(uuid.UUID(o["event_id"]))
        o["label_id"] = str(lid) if lid else None


async def copy_to(db: AsyncSession, src_id: uuid.UUID, dst_id: uuid.UUID) -> None:
    """A series split in two ("this" / "this and following"): everyone's own
    label follows onto the new piece."""
    for row in (await db.execute(select(CalEventLabel).where(CalEventLabel.event_id == src_id))).scalars():
        db.add(CalEventLabel(event_id=dst_id, user_id=row.user_id, label_id=row.label_id))
