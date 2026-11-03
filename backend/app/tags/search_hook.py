"""Tags in the everyday search box (``/api/today/search``, Ctrl+K)."""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User


async def everyday(
    db: AsyncSession, user: User, term: str, limit: int, skip_events: set[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(tags matching ``term``, events carrying a tag named exactly ``term``
    that the plain search didn't already find). Never raises."""
    from app.tags import items_sync, service

    try:
        await items_sync.ensure_backfill(db, user)
        tags = await service.search(db, user, term, limit)
        events = await _tagged_events(db, user, items_sync.norm(term), limit, skip_events)
    except Exception:  # noqa: BLE001 — the rest of search still answers
        import logging

        logging.getLogger("promptly.tags").exception("tag search failed")
        await db.rollback()
        return [], []
    return tags, events


async def _tagged_events(db: AsyncSession, user: User, name: str, limit: int, skip: set[str]) -> list[dict[str, Any]]:
    import uuid

    from app.calendars.models import CalEvent
    from app.tags.models import Tag, TagAssignment
    from app.tags.service import visible_event_ids

    if not name:
        return []
    raw = (
        await db.execute(
            select(TagAssignment.entity_id)
            .join(Tag, Tag.id == TagAssignment.tag_id)
            .where(Tag.user_id == user.id, func.lower(Tag.name) == name.lower(), TagAssignment.entity_kind == "event")
            .limit(limit * 4)
        )
    ).scalars().all()
    ids = []
    for e in raw:
        if e in skip:
            continue
        try:
            ids.append(uuid.UUID(e))
        except ValueError:
            continue
    ok = await visible_event_ids(db, user, ids)
    if not ok:
        return []
    evs = (await db.execute(select(CalEvent).where(CalEvent.id.in_(ok)).order_by(CalEvent.start_at.desc()).limit(limit))).scalars()
    return [
        {"id": str(ev.id), "event_id": str(ev.id), "title": ev.title,
         "start": ev.start_at.date().isoformat() if ev.all_day else ev.start_at.isoformat(),
         "all_day": ev.all_day, "location": ev.location or "", "url": f"/calendar?event={ev.id}"}
        for ev in evs
    ]
