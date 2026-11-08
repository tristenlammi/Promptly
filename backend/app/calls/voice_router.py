"""Voice channel routes, mounted at ``/api/rooms`` next to Rooms' own
(``rooms/router.py``). The engine is ``app.calls.voice``.

Anything you can't see is a 404, never a 403: voice off for the server or
for you, a room you're not in the space of, a room that isn't a voice
channel. A 403 only ever says why you can't do something to a channel you
can see ("Only admins can join Lounge"); a full channel is a 409.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.calls import access, voice
from app.calls.models import ALONE_CHOICES
from app.database import get_db
from app.rooms import core as rooms_core
from app.rooms.models import Room, RoomSpaceMember

router = APIRouter()


def _err(e: voice.VoiceError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.detail)


async def _channel(db: AsyncSession, room_id: uuid.UUID, user: User) -> tuple[Room, RoomSpaceMember, access.CallsSettings]:
    """A voice channel you can see, with voice on for you; else 404."""
    cs = await access.require_voice(db, user)
    room, sm = await rooms_core.load_room(db, room_id, user)
    if room.kind != "voice" or room.space_id is None or sm is None:
        raise rooms_core.not_found()
    return room, sm, cs


# ---------------------------------------------------------------- settings


class VoicePatch(BaseModel):
    user_limit: int | None = Field(default=None, ge=0, le=access.MAX_PARTICIPANTS_RANGE[1])
    quality: Literal["standard", "good", "high", "music"] | None = None
    join_role: Literal["member", "admin"] | None = None
    talk_role: Literal["member", "admin"] | None = None
    video: bool | None = None
    # null = never; omit for no change.
    alone_minutes: int | None = None

    @field_validator("user_limit")
    @classmethod
    def _limit(cls, v: int | None) -> int | None:
        if v == 1:
            raise ValueError("a user limit is 0 (none) or at least 2")
        return v

    @field_validator("alone_minutes")
    @classmethod
    def _alone(cls, v: int | None) -> int | None:
        if v is not None and v not in ALONE_CHOICES:
            raise ValueError(f"alone_minutes is one of {list(ALONE_CHOICES)} or null (never)")
        return v


@router.patch("/rooms/{room_id}/voice")
async def patch_voice(room_id: uuid.UUID, body: VoicePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """A voice channel's settings (the space's admins)."""
    room, sm, cs = await _channel(db, room_id, user)
    if not access.is_space_admin(sm):
        raise rooms_core.forbidden("Only the space's admins can change voice channels")
    rv = await voice.voice_settings(db, room)
    data = body.model_dump(exclude_unset=True)
    if data.get("user_limit") and data["user_limit"] > cs.max_participants:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This server allows up to {cs.max_participants} people in a channel",
        )
    for k in ("user_limit", "quality", "join_role", "talk_role", "video"):
        if data.get(k) is not None:
            setattr(rv, k, data[k])
    if "alone_minutes" in data:
        rv.alone_minutes = data["alone_minutes"]
    await db.commit()
    await voice.settings_changed(db, room, rv)
    # Everyone sees the channel's new settings (rooms_out carries them).
    for uid in await rooms_core.member_ids(db, room):
        u = await db.get(User, uid)
        if u is not None:
            await rooms_core.publish([uid], {"type": "room", "room": await rooms_core.room_out(db, room, u)})
    return voice.settings_out(rv)


# ---------------------------------------------------------------- join / leave


class JoinIn(BaseModel):
    device: Literal["web", "android"] = "web"


@router.post("/rooms/{room_id}/voice/join")
async def join(room_id: uuid.UUID, body: JoinIn | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Join a voice channel (moving you from any other, and off another
    device). Returns what the client connects with."""
    room, sm, cs = await _channel(db, room_id, user)
    try:
        return await voice.join(db, user, room, sm, cs, (body or JoinIn()).device)
    except voice.VoiceError as e:
        raise _err(e) from None


@router.post("/rooms/{room_id}/voice/view")
async def view(room_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """A listen-only second connection for cameras and streams, while the
    Android service holds your audio."""
    room, _sm, _cs = await _channel(db, room_id, user)
    try:
        return await voice.view_token(db, user, room)
    except voice.VoiceError as e:
        raise _err(e) from None


class SessionIn(BaseModel):
    # Join's ``session_id``: only that session (a device that was replaced
    # mustn't end the newer one). Omit for "wherever I am".
    session: str | None = Field(default=None, max_length=64)


@router.post("/voice/leave")
async def leave(body: SessionIn | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await access.require_voice(db, user)
    left = await voice.leave(db, user, (body or SessionIn()).session)
    return {"ok": True, "left": left}


class RefreshIn(BaseModel):
    session: str = Field(min_length=10, max_length=2000)


@router.post("/voice/refresh")
async def refresh(body: RefreshIn, db: AsyncSession = Depends(get_db)) -> dict:
    """A fresh LiveKit token for a voice session. No bearer: the session
    (signed, one person, one channel, 12 hours, ends when you leave) is the
    key. Used by the Android voice service."""
    cs = await access.load_settings(db)
    if not cs.enabled:
        raise rooms_core.not_found("Voice session")
    try:
        return await voice.refresh(db, body.session)
    except voice.VoiceError as e:
        raise _err(e) from None


@router.get("/voice/me")
async def voice_me(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Where you are in voice (so a reloaded page can pick it up)."""
    await access.require_voice(db, user)
    cur = await voice.where(user.id)
    if cur is None:
        return {"room_id": None}
    return {"room_id": cur["room_id"], "space_id": cur.get("space_id"), "device": cur.get("device"), "session_id": cur.get("session"), "joined_at": cur.get("joined_at")}


# ---------------------------------------------------------------- reports


class StateIn(BaseModel):
    session: str | None = Field(default=None, max_length=64)
    muted: bool | None = None
    deafened: bool | None = None
    video: bool | None = None
    live: bool | None = None
    # The user id whose Go Live stream you're watching; "" when you stop.
    watching: str | None = Field(default=None, max_length=40)


@router.post("/voice/state")
async def state(body: StateIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await access.require_voice(db, user)
    try:
        return await voice.report_state(
            db, user, session=body.session, muted=body.muted, deafened=body.deafened, video=body.video, live=body.live, watching=body.watching
        )
    except voice.VoiceError as e:
        raise _err(e) from None


class SpeakingIn(BaseModel):
    on: bool


@router.post("/voice/speaking", status_code=204)
async def speaking(body: SpeakingIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    await access.require_voice(db, user)
    try:
        await voice.speaking(db, user, body.on)
    except voice.VoiceError as e:
        raise _err(e) from None


@router.post("/voice/still-here")
async def still_here(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await access.require_voice(db, user)
    try:
        return await voice.still_here(db, user)
    except voice.VoiceError as e:
        raise _err(e) from None


class ControlIn(BaseModel):
    action: Literal["mute", "unmute", "deafen", "undeafen", "leave"]


@router.post("/voice/control")
async def control(body: ControlIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Remote control of your own voice connection (the page driving the
    Android service). The connection applies it and reports its state."""
    await access.require_voice(db, user)
    try:
        return await voice.control(db, user, body.action)
    except voice.VoiceError as e:
        raise _err(e) from None


# ---------------------------------------------------------------- moderation


async def _moderation(db: AsyncSession, room_id: uuid.UUID, target_id: uuid.UUID, user: User) -> tuple[Room, RoomSpaceMember]:
    room, sm, _cs = await _channel(db, room_id, user)
    target = await rooms_core.space_member(db, room.space_id, target_id)
    if target is None:
        raise rooms_core.not_found("Member")
    if not access.can_moderate(sm):
        raise rooms_core.forbidden("Only the space's admins can do that")
    if not access.can_moderate(sm, target):
        raise rooms_core.forbidden("You can't do that to another admin")
    return room, target


class ModerateIn(BaseModel):
    server_mute: bool | None = None
    server_deafen: bool | None = None


@router.post("/rooms/{room_id}/voice/members/{user_id}")
async def moderate(room_id: uuid.UUID, user_id: uuid.UUID, body: ModerateIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Mute or deafen someone for everyone (space admins). They can't undo
    it; it lasts until an admin lifts it."""
    room, _t = await _moderation(db, room_id, user_id, user)
    flags = await voice.moderate(db, room, user_id, server_mute=body.server_mute, server_deafen=body.server_deafen)
    return {"user_id": str(user_id), **flags}


class MoveIn(BaseModel):
    to_room_id: uuid.UUID


@router.post("/rooms/{room_id}/voice/members/{user_id}/move")
async def move(room_id: uuid.UUID, user_id: uuid.UUID, body: MoveIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, _t = await _moderation(db, room_id, user_id, user)
    to = await db.get(Room, body.to_room_id)
    if to is None or to.kind != "voice" or to.space_id != room.space_id or to.id == room.id:
        raise rooms_core.not_found()
    try:
        return await voice.move(db, room, user_id, to, user)
    except voice.VoiceError as e:
        raise _err(e) from None


@router.delete("/rooms/{room_id}/voice/members/{user_id}", status_code=204)
async def disconnect(room_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    room, _t = await _moderation(db, room_id, user_id, user)
    try:
        await voice.disconnect(db, room, user_id, user)
    except voice.VoiceError as e:
        raise _err(e) from None
