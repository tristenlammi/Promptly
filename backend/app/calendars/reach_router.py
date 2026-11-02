"""Calendar API, part two (mounted at ``/api/calendar`` too): photos from an
event, the rooms' "starting soon" posts, and guests invited by email —
with the public page they answer from. See ``reach.py``."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from limits import parse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.rate_limit import rate_limit

from . import core, reach

router = APIRouter()


# ------------------------------------------------------------------ photos


@router.get("/events/{event_id}/photos")
async def event_photos(
    event_id: uuid.UUID,
    occurrence: str | None = Query(default=None, max_length=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Your own photos taken during the event (that occurrence, else the
    latest one that has started)."""
    return await reach.event_photos(db, user, event_id, occurrence)


class AlbumIn(BaseModel):
    occurrence: str | None = Field(default=None, max_length=40)


@router.post("/events/{event_id}/album", status_code=201)
async def make_album(event_id: uuid.UUID, body: AlbumIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """An album of those photos, named after the event."""
    return {"album": await reach.make_album(db, user, event_id, body.occurrence)}


# ------------------------------------------------------------------ rooms


class RoomReminderIn(BaseModel):
    # Minutes before; null = no post in the room.
    remind_minutes: int | None = None


@router.patch("/events/{event_id}/rooms/{room_id}")
async def room_reminder(
    event_id: uuid.UUID, room_id: uuid.UUID, body: RoomReminderIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Turn the room's "Starting in 1 hour" post on or off (or change when)."""
    return await reach.set_room_reminder(db, user, event_id, room_id, body.remind_minutes)


# ------------------------------------------------------------------ email guests


@router.get("/email-check")
async def email_check(email: str = Query(..., max_length=320), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """For the guests box: someone on Promptly, or invite by email (and can
    this server send email)?"""
    return await reach.email_check(db, email)


class EmailGuestsIn(BaseModel):
    emails: list[str] = Field(min_length=1, max_length=20)


@router.get("/events/{event_id}/email-guests")
async def email_guests(event_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    ev, m, att = await core.load_event(db, event_id, user)
    if core.busy_only(m, att):
        raise core.not_found()
    show = core.can_edit(ev, m, att, user)
    return {"guests": [reach.guest_out(g, show) for g in await reach.guests_of(db, ev.id)], "can_email": await reach.smtp_ready(db)}


@router.post(
    "/events/{event_id}/email-guests",
    status_code=201,
    dependencies=[Depends(rate_limit(parse("40/hour"), bucket="calendar_email_invite"))],
)
async def invite_by_email(
    event_id: uuid.UUID, body: EmailGuestsIn, request: Request,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Invite people who aren't on Promptly: each gets an email with the
    event, an invite for their calendar, and links to answer."""
    await reach.invite_by_email(db, user, event_id, body.emails, request.headers.get("origin"))
    return {"guests": [reach.guest_out(g, True) for g in await reach.guests_of(db, event_id)]}


@router.delete("/events/{event_id}/email-guests/{guest_id}", status_code=204)
async def remove_email_guest(event_id: uuid.UUID, guest_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    """Uninvite them (they get a cancellation)."""
    await reach.remove_email_guest(db, user, event_id, guest_id)


# ------------------------------------------------------------------ public answer

# No login: the token in the email's link is the key. It answers for that
# one guest and shows the event — never anyone else's details.
public_router = APIRouter()
_public_limit = Depends(rate_limit(parse("60/minute"), bucket="calendar_answer"))


@public_router.get("/answer/{token}", dependencies=[_public_limit])
async def answer_page(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    g, ev = await reach.by_token(db, token)
    return await reach.answer_out(db, g, ev)


class AnswerIn(BaseModel):
    status: Literal["going", "maybe", "declined"]


@public_router.post("/answer/{token}", dependencies=[_public_limit])
async def answer(token: str, body: AnswerIn, db: AsyncSession = Depends(get_db)) -> dict:
    return await reach.answer(db, token, body.status)
