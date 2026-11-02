"""``/api/items/k/journal/…`` — the journal knows your day (#U7).

  ``GET /{file_id}/day?date=YYYY-MM-DD``
      → that day's events from your calendar and the photos you took, for
        the editor's "Your day" strip ("Add to entry"). Always the caller's
        own: events they can see (not free/busy-only ones, not hidden or
        declined), photos from their own library (not shared or family).
        Nothing is written; the client adds a line or a photo reference to
        the entry itself.

Needs edit access to the journal (it's where the chips get added).
"""
from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.items import service

router = APIRouter()


@router.get("/{file_id}/day")
async def day_context(
    file_id: uuid.UUID,
    day: date = Query(alias="date"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from app.today import core

    try:
        _row, doc, _ = await service.load(db, user, file_id, need="edit")
    except service.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Journal not found")
    if doc.kind != "journal":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Journal not found")
    tz = core.zone_of(user)
    events = await core.events_on(db, user, day, tz, limit=30)
    for e in events:
        e["time"] = "" if e["all_day"] else core.local_clock(e["start"], tz)
        e["end_time"] = "" if e["all_day"] else core.local_clock(e["end"], tz)
    try:
        count, photos = await core.photos_taken_on(db, user, day, limit=24)
    except Exception:  # noqa: BLE001 — no Photos set up: just events
        count, photos = 0, []
    return {"date": day.isoformat(), "events": events, "photos": photos, "photo_count": count}
