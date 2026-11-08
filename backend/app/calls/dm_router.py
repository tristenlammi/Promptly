"""DM call routes, mounted at ``/api/calls`` after phase 1's (webhook, Test
calls, Admin > Calls). The engine is ``app.calls.dm``.

Anything you can't see is a 404, never a 403: calls off for the server or
for you, a conversation you're not in, a space room (calls in spaces are
voice channels), someone else's call. A 403 only says why you can't do
something to a call you can see (a block, "only the person who started it
can end it for everyone"); a call that's over, full or not ringing you is a
409.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.calls import access, dm
from app.database import get_db
from app.rate_limit import parse as parse_limit
from app.rate_limit import rate_limit
from app.rooms import core as rooms_core

router = APIRouter()

_start_limit = rate_limit(parse_limit("30/minute"), bucket="calls_start")


def _err(e: dm.CallError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.detail)


class StartIn(BaseModel):
    room_id: uuid.UUID
    media: Literal["audio", "video"] = "audio"
    device: Literal["web", "android"] = "web"


class StartDmIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    media: Literal["audio", "video"] = "audio"
    device: Literal["web", "android"] = "web"


class DeviceIn(BaseModel):
    device: Literal["web", "android"] = "web"


class SessionIn(BaseModel):
    # Join's ``session_id``: only that session (a device the call moved away
    # from mustn't hang up the newer one). Omit for "wherever I am".
    session: str | None = Field(default=None, max_length=64)


class RingIn(BaseModel):
    # Omit for everyone in the conversation who isn't in the call.
    user_ids: list[uuid.UUID] | None = Field(default=None, max_length=20)


class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=2000)
    device: Literal["web", "android"] = "web"


class CallSessionIn(BaseModel):
    session: str = Field(min_length=10, max_length=2000)


# ---------------------------------------------------------------- start


@router.post("", dependencies=[Depends(_start_limit)])
async def start_call(body: StartIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Call a conversation (1:1 or group): rings the others for 45 s and
    connects you. Returns what the client connects with and the call."""
    cs = await access.require_voice(db, user)
    room, _sm = await rooms_core.load_room(db, body.room_id, user)
    if not dm.is_dm_room(room):
        raise rooms_core.not_found()
    try:
        return await dm.start(db, user, room, cs, body.media, body.device)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/dm", dependencies=[Depends(_start_limit)])
async def start_dm_call(body: StartDmIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Call people from Contacts, the person page or Ctrl+K: opens (or
    reuses) the conversation with them, then calls it."""
    cs = await access.require_voice(db, user)
    from app.rooms.router import DmIn, open_dm

    room_json = await open_dm(DmIn(user_ids=body.user_ids), db, user)
    room, _sm = await rooms_core.load_room(db, uuid.UUID(room_json["id"]), user)
    try:
        return await dm.start(db, user, room, cs, body.media, body.device)
    except dm.CallError as e:
        raise _err(e) from None


# ---------------------------------------------------------------- no bearer (push token, Android session)
# Before the /{call_id} routes, so "answer" and "session" aren't read as ids.


@router.post("/answer")
async def answer_with_token(body: TokenIn, db: AsyncSession = Depends(get_db)) -> dict:
    """Answer with the ringing push's own token (the Android incoming-call
    screen). No bearer: the token is one person, this call, two minutes."""
    try:
        return await dm.answer_with_token(db, body.token, body.device)
    except dm.CallError as e:
        raise _err(e) from None


class RingTokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=2000)


@router.post("/answer/decline")
async def decline_with_token(body: RingTokenIn, db: AsyncSession = Depends(get_db)) -> dict:
    """Decline with the ringing push's answer token (the Android
    incoming-call screen)."""
    try:
        return await dm.decline_with_token(db, body.token)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/answer/state")
async def ring_state(body: RingTokenIn, db: AsyncSession = Depends(get_db)) -> dict:
    """Still ringing you? (The Android ring checks while it rings.)"""
    try:
        return await dm.ring_state_with_token(db, body.token)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/session/refresh")
async def session_refresh(body: CallSessionIn, db: AsyncSession = Depends(get_db)) -> dict:
    """A fresh LiveKit token for a call session (the Android service)."""
    try:
        return await dm.refresh(db, body.session)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/session/leave")
async def session_leave(body: CallSessionIn, db: AsyncSession = Depends(get_db)) -> dict:
    """The Android service hangs up (its notification's Hang up)."""
    try:
        return {"ok": True, "left": await dm.session_leave(db, body.session)}
    except dm.CallError as e:
        raise _err(e) from None


# ---------------------------------------------------------------- lists


@router.get("/live")
async def live(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Live calls in your conversations (ringing you, or on, with Join),
    and the one you're in."""
    await access.require_voice(db, user)
    current = await dm.current_call(db, user.id)
    return {
        "calls": await dm.live_for(db, user),
        "in_call": str(current) if current else None,
        # The missed-calls badge (Calls WP-D4).
        "missed": await dm.missed_count(db, user.id),
    }


@router.get("/history")
async def history(
    before: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Your calls, newest first (the Calls tab)."""
    await access.require_voice(db, user)
    return await dm.history(db, user, before=before, limit=limit)


@router.delete("/history", status_code=204)
async def clear_history(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    """Clear your call history (nobody else's). Live calls stay."""
    await access.require_voice(db, user)
    await dm.clear_history(db, user)


@router.get("/missed")
async def missed(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """The missed-calls badge: calls you missed and haven't seen."""
    await access.require_voice(db, user)
    return {"count": await dm.missed_count(db, user.id)}


@router.post("/missed/seen")
async def missed_seen(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """You looked at the Calls tab: the badge clears (on every device)."""
    await access.require_voice(db, user)
    return {"count": await dm.mark_seen(db, user)}


@router.get("/people")
async def people(
    q: str = Query(default="", max_length=80),
    ids: str | None = Query(default=None, max_length=40 * 37),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """People you can call (Ctrl+K "Call Mum", the Contacts buttons): by a
    name you know them by, or ``ids`` (comma-separated) to ask which of
    these you can call. Blocked people (either way) are never offered."""
    cs = await access.require_voice(db, user)
    id_list: list[uuid.UUID] | None = None
    if ids is not None:
        try:
            id_list = [uuid.UUID(x) for x in ids.split(",") if x.strip()][:40]
        except ValueError:
            raise HTTPException(status_code=422, detail="ids must be user ids") from None
    return {"people": await dm.people(db, user, q, id_list, cs)}


# ---------------------------------------------------------------- one call


@router.get("/{call_id}")
async def get_call(call_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await access.require_voice(db, user)
    try:
        call, _room = await dm.visible_call(db, user, call_id)
        return await dm.describe(db, call)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/{call_id}/join")
async def join(call_id: uuid.UUID, body: DeviceIn | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Answer a call ringing you, join a live group call, or move your call
    to this device."""
    cs = await access.require_voice(db, user)
    try:
        return await dm.join(db, user, call_id, cs, (body or DeviceIn()).device)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/{call_id}/decline")
async def decline(call_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await access.require_voice(db, user)
    try:
        return await dm.decline_by_id(db, user, call_id)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/{call_id}/leave")
async def leave(call_id: uuid.UUID, body: SessionIn | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Hang up. A 1:1 call ends for both; a group call carries on without
    you. Before anyone answered, the caller hanging up cancels it."""
    await access.require_voice(db, user)
    try:
        await dm.visible_call(db, user, call_id)
    except dm.CallError as e:
        raise _err(e) from None
    return {"ok": True, "left": await dm.leave(db, user, call_id, session=(body or SessionIn()).session)}


@router.post("/{call_id}/end")
async def end(call_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """End the call for everyone (a 1:1 call, or a group call you started)."""
    await access.require_voice(db, user)
    try:
        return await dm.end(db, user, call_id)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/{call_id}/ring")
async def ring_again(call_id: uuid.UUID, body: RingIn | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Ring people who aren't in the call (a group call's Ring button)."""
    cs = await access.require_voice(db, user)
    try:
        return await dm.ring_again(db, user, call_id, (body or RingIn()).user_ids, cs)
    except dm.CallError as e:
        raise _err(e) from None


class ControlIn(BaseModel):
    action: Literal["mute", "unmute", "speaker_on", "speaker_off", "camera_on", "camera_off", "flip"]


@router.post("/{call_id}/control")
async def control(call_id: uuid.UUID, body: ControlIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Mute, the loudspeaker or the camera for your call in the Android
    app, from the page that shows the call's video."""
    await access.require_voice(db, user)
    try:
        return await dm.control(db, user, call_id, body.action)
    except dm.CallError as e:
        raise _err(e) from None


@router.post("/{call_id}/view")
async def view(call_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """A listen-only second connection for cameras and screens, while the
    Android service holds your audio."""
    await access.require_voice(db, user)
    try:
        return await dm.view_token(db, user, call_id)
    except dm.CallError as e:
        raise _err(e) from None


@router.delete("/{call_id}/history", status_code=204)
async def hide(call_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    """Remove a call from your call history (nobody else's)."""
    await access.require_voice(db, user)
    try:
        await dm.hide(db, user, call_id)
    except dm.CallError as e:
        raise _err(e) from None
