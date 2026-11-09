"""Across-apps API, mounted at ``/api/crossapp``.

  POST /share                                 post a "Send to…" card in a room (optionally letting the room in)
  GET  /share/card/{message_id}               a card as you see it ({card: null} = no access)
  GET  /share/preview?kind=&id=               the card of something you're about to send (404: you can't open it)
  GET  /trip/{file_id}/{trip_id}/album        your trip album and its first photos
  POST /trip/{file_id}/{trip_id}/album        make / bring up to date your trip album
  GET  /trip/{file_id}/{trip_id}/spending     "Spent so far" from your Budget
  POST /trip/{file_id}/{trip_id}/spending/tag tag your Budget's purchases in the trip's dates
  GET  /budget/trips                          trips a Budget transaction can be tagged with
  POST /mealplan/{file_id}/to-tasks           send the grocery list to Tasks
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.background import spawn
from app.database import get_db

from . import groceries, shares, trips

router = APIRouter()


# ================================================================== share


class ShareIn(BaseModel):
    room_id: uuid.UUID
    kind: str = Field(max_length=16)
    id: str = Field(min_length=1, max_length=64)
    file_id: uuid.UUID | None = None
    note: str = Field(default="", max_length=2000)
    grant: bool = False


@router.post("/share", status_code=201)
async def share(body: ShareIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    from app.rooms import core as rooms_core
    from app.rooms import service as rooms_service
    from app.rooms.push import fan_out

    if body.kind not in shares.KINDS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That can't be shared to a room.")
    snap: dict = {"kind": body.kind, "id": body.id, "label": shares.LABELS[body.kind]}
    if body.kind in shares.IN_ITEM:
        if body.file_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file_id is needed for that kind.")
        snap["file_id"] = str(body.file_id)
    # You can only send what you can open yourself (and nothing is probeable).
    if await shares.card(db, user, snap) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    room, _sm = await rooms_core.load_room(db, body.room_id, user, lock=True)
    members = await rooms_core.member_ids(db, room)
    granted = None
    if body.grant:
        granted = await shares.grant_room(db, user, snap, members)
    note = body.note.strip()
    snap["has_note"] = bool(note)
    msg = await rooms_service.post_message(db, room, user, note or f"Shared {snap['label']}")
    msg.meta = {**(msg.meta or {}), "share": snap}
    await db.commit()
    await db.refresh(msg)
    out = await rooms_core.message_out(db, msg)
    await rooms_core.publish(members, {"type": "message", "message": out})
    if room.space_id is None:
        # A re-opened conversation shows up in the others' lists.
        for uid in members:
            if uid != user.id:
                u = await db.get(User, uid)
                if u is not None:
                    await rooms_core.publish([uid], {"type": "room", "room": await rooms_core.room_out(db, room, u)})
    spawn(fan_out(msg.id), name=f"rooms-push-{msg.id}")
    return {"message": out, "granted": granted}


@router.get("/share/preview")
async def share_preview(
    kind: str = Query(..., max_length=16),
    id: str = Query(..., min_length=1, max_length=64),  # noqa: A002 — the thing's id, as in ShareIn
    file_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The card of something you're about to send (the Rooms composer's
    attachment, e.g. ``?share=porch_post:<id>``), as you see it — 404 when
    you can't open it yourself."""
    if kind not in shares.KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    snap: dict = {"kind": kind, "id": id}
    if kind in shares.IN_ITEM:
        snap["file_id"] = str(file_id) if file_id else None
    got = await shares.card(db, user, snap)
    if got is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return {"kind": kind, "label": shares.LABELS[kind], "card": got}


@router.get("/share/card/{message_id}")
async def share_card(message_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    from app.rooms import core as rooms_core
    from app.rooms.models import RoomMessage

    msg = await db.get(RoomMessage, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    await rooms_core.load_room(db, msg.room_id, user)  # 404 unless you're in the room
    snap = (msg.meta or {}).get("share")
    if not isinstance(snap, dict):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    got = await shares.card(db, user, snap)
    can_grant = msg.author_id == user.id and got is not None and await shares.can_grant(db, user, snap)
    return {"kind": snap.get("kind"), "label": snap.get("label"), "card": got, "can_grant": can_grant}


# ================================================================== trips


@router.get("/trip/{file_id}/{trip_id}/album")
async def trip_album(file_id: uuid.UUID, trip_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return await trips.album_out(db, user, file_id, trip_id)


@router.post("/trip/{file_id}/{trip_id}/album")
async def make_trip_album(file_id: uuid.UUID, trip_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return await trips.make_album(db, user, file_id, trip_id)


@router.get("/trip/{file_id}/{trip_id}/spending")
async def trip_spending(file_id: uuid.UUID, trip_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return await trips.spending_out(db, user, file_id, trip_id)


@router.post("/trip/{file_id}/{trip_id}/spending/tag")
async def tag_trip_spending(file_id: uuid.UUID, trip_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return await trips.tag_in_dates(db, user, file_id, trip_id)


@router.get("/budget/trips")
async def budget_trips(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    return await trips.my_trips(db, user)


# ================================================================== meal plan


@router.post("/mealplan/{file_id}/to-tasks")
async def mealplan_to_tasks(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return await groceries.send_to_tasks(db, user, file_id)
