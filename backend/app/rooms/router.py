"""Rooms API, mounted at ``/api/rooms``. See ``docs/rooms-plan.md``."""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.background import spawn
from app.database import get_db
from app.files.storage import absolute_path

from . import core, service
from .models import Room, RoomAttachment, RoomMember, RoomMessage, RoomReaction, RoomSpace, RoomSpaceMember
from .push import fan_out

router = APIRouter()

_HEX = r"^#[0-9a-fA-F]{6}$"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ================================================================== bootstrap


@router.get("/bootstrap")
async def bootstrap(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    mine = (await db.execute(select(RoomSpaceMember).where(RoomSpaceMember.user_id == user.id))).scalars().all()
    space_ids = [m.space_id for m in mine]
    spaces = {s.id: s for s in (await db.execute(select(RoomSpace).where(RoomSpace.id.in_(space_ids)))).scalars()} if space_ids else {}
    rooms = list((await db.execute(select(Room).where(Room.space_id.in_(space_ids)).order_by(Room.position, Room.created_at))).scalars()) if space_ids else []
    members_by_space: dict[uuid.UUID, list[str]] = {}
    roles_by_space: dict[uuid.UUID, dict[str, str]] = {}
    people: set[uuid.UUID] = {user.id}
    if space_ids:
        rows = await db.execute(
            select(RoomSpaceMember.space_id, RoomSpaceMember.user_id, RoomSpaceMember.role)
            .where(RoomSpaceMember.space_id.in_(space_ids))
            .order_by(RoomSpaceMember.joined_at)
        )
        for sid, uid, role in rows.all():
            members_by_space.setdefault(sid, []).append(str(uid))
            roles_by_space.setdefault(sid, {})[str(uid)] = role
            people.add(uid)
    dms = list(
        (
            await db.execute(
                select(Room)
                .join(RoomMember, RoomMember.room_id == Room.id)
                .where(Room.space_id.is_(None), RoomMember.user_id == user.id, RoomMember.hidden.is_(False))
                .order_by(Room.last_message_at.desc().nulls_last(), Room.created_at.desc())
            )
        ).scalars()
    )
    room_json = await core.rooms_out(db, rooms + dms, user)
    by_id = {r["id"]: r for r in room_json}
    for r in room_json:
        for uid in r.get("members", []):
            people.add(uuid.UUID(uid))
    out_spaces = []
    for m in sorted(mine, key=lambda x: x.joined_at):
        s = spaces.get(m.space_id)
        if s is None:
            continue
        out_spaces.append(
            {
                "id": str(s.id),
                "name": s.name,
                "emoji": s.emoji,
                "color": s.color,
                "role": m.role,
                "notify": m.notify,
                "member_ids": members_by_space.get(s.id, []),
                "member_roles": roles_by_space.get(s.id, {}),
                "rooms": [by_id[str(r.id)] for r in rooms if r.space_id == s.id],
            }
        )
    # Voice channels (Calls): who's in each right now, and where you are.
    # Voice off for the server or for you: channels show without people.
    from app.calls import access as calls_access
    from app.calls import voice as calls_voice

    calls_settings = await calls_access.load_settings(db)
    voice_on = await calls_access.voice_allowed(db, user, calls_settings)
    voice_ids = [r.id for r in rooms if r.kind == "voice"]
    voice_me = await calls_voice.where(user.id) if voice_on else None
    # DM calls (Calls phase 2): live calls in your conversations.
    from app.calls import dm as calls_dm

    calls_live = await calls_dm.live_for(db, user) if voice_on else []
    return {
        "me": core.user_out(user),
        "spaces": out_spaces,
        "dms": [by_id[str(r.id)] for r in dms],
        "users": await core.users_map(db, people),
        "voice_available": voice_on,
        "voice": await calls_voice.members_map(voice_ids) if voice_on else {},
        "voice_me": (
            {k: voice_me.get(k) for k in ("room_id", "space_id", "device", "joined_at")} | {"session_id": voice_me.get("session")}
            if voice_me
            else None
        ),
        # The server's caps, for channel settings (user limit) and Go Live.
        "voice_limits": (
            {"max_participants": calls_settings.max_participants, "max_stream": calls_settings.max_stream} if voice_on else None
        ),
        # Live DM calls in your conversations (ringing you, or on with a Join).
        "calls": calls_live,
        # The Calls tab's badge: missed calls you haven't seen (Calls WP-D4).
        "calls_missed": await calls_dm.missed_count(db, user.id) if voice_on else 0,
    }


@router.get("/people")
async def people(q: str = "", db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """The DM / add-member picker. With 2+ letters: anyone on this Promptly;
    with none: only people you already share a space or conversation with
    (the roster isn't listable — same rule as the share picker)."""
    term = q.strip()
    if len(term) >= 2:
        esc = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = (
            await db.execute(
                select(User)
                .where(User.disabled.is_(False), User.id != user.id, or_(User.username.ilike(f"%{esc}%", escape="\\"), User.email.ilike(f"%{esc}%", escape="\\")))
                .order_by(User.username)
                .limit(30)
            )
        ).scalars().all()
        return [core.user_out(u) for u in rows]
    spaces = select(RoomSpaceMember.space_id).where(RoomSpaceMember.user_id == user.id)
    dms = select(RoomMember.room_id).join(Room, Room.id == RoomMember.room_id).where(Room.space_id.is_(None), RoomMember.user_id == user.id)
    a = select(RoomSpaceMember.user_id).where(RoomSpaceMember.space_id.in_(spaces))
    b = select(RoomMember.user_id).where(RoomMember.room_id.in_(dms))
    ids = set((await db.execute(a.union(b))).scalars().all()) - {user.id}
    rows = (await db.execute(select(User).where(User.id.in_(ids), User.disabled.is_(False)).order_by(User.username))).scalars().all() if ids else []
    return [core.user_out(u) for u in rows]


# ================================================================== spaces


class SpaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field(default="", max_length=16)
    color: str = Field(default="#5B6DD9", pattern=_HEX)


class SpacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, pattern=_HEX)


async def _space_event(db: AsyncSession, space_id: uuid.UUID, extra: list[uuid.UUID] | None = None) -> None:
    await core.publish(await core.space_member_ids(db, space_id) + (extra or []), {"type": "space", "space_id": str(space_id)})


@router.post("/spaces", status_code=201)
async def create_space(body: SpaceIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    space = RoomSpace(name=body.name.strip(), emoji=body.emoji.strip(), color=body.color, created_by=user.id)
    db.add(space)
    await db.flush()
    db.add(RoomSpaceMember(space_id=space.id, user_id=user.id, role="owner"))
    room = Room(space_id=space.id, kind="text", name="general", position=0, created_by=user.id)
    db.add(room)
    await db.commit()
    await _space_event(db, space.id)
    return {
        "id": str(space.id),
        "name": space.name,
        "emoji": space.emoji,
        "color": space.color,
        "role": "owner",
        "notify": "all",
        "member_ids": [str(user.id)],
        "member_roles": {str(user.id): "owner"},
        "rooms": [await core.room_out(db, room, user)],
        "room_id": str(room.id),
    }


@router.patch("/spaces/{space_id}")
async def update_space(space_id: uuid.UUID, body: SpacePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    space, me = await core.load_space(db, space_id, user)
    if not core.is_admin(me):
        raise core.forbidden("Only the space's admins can change it")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(space, k, v.strip() if isinstance(v, str) else v)
    await db.commit()
    await _space_event(db, space.id)
    return {"ok": True}


@router.delete("/spaces/{space_id}", status_code=204)
async def delete_space(space_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    space, me = await core.load_space(db, space_id, user)
    if me.role != "owner":
        raise core.forbidden("Only the owner can delete a space")
    members = await core.space_member_ids(db, space.id)
    room_ids = list((await db.execute(select(Room.id).where(Room.space_id == space.id))).scalars())
    from app.calls import voice as calls_voice

    await calls_voice.rooms_gone(db, room_ids, space.id)
    await db.delete(space)
    await db.commit()
    for rid in room_ids:
        service.remove_room_files(rid)
    await core.publish(members, {"type": "space_delete", "space_id": str(space_id)})


class MembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


@router.post("/spaces/{space_id}/members")
async def add_members(space_id: uuid.UUID, body: MembersIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    space, me = await core.load_space(db, space_id, user)
    if not core.is_admin(me):
        raise core.forbidden("Only the space's admins can add people")
    found = (await db.execute(select(User.id).where(User.id.in_(body.user_ids), User.disabled.is_(False)))).scalars().all()
    existing = set(await core.space_member_ids(db, space.id))
    added = [u for u in found if u not in existing]
    for uid in added:
        db.add(RoomSpaceMember(space_id=space.id, user_id=uid, role="member"))
    await db.commit()
    await _space_event(db, space.id)
    return {"added": [str(u) for u in added]}


class RoleIn(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def _r(cls, v: str) -> str:
        if v not in core.ROLES:
            raise ValueError("role is owner, admin or member")
        return v


@router.patch("/spaces/{space_id}/members/{user_id}")
async def set_role(space_id: uuid.UUID, user_id: uuid.UUID, body: RoleIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    space, me = await core.load_space(db, space_id, user)
    target = await core.space_member(db, space.id, user_id)
    if target is None:
        raise core.not_found("Member")
    if body.role == "owner" or target.role == "owner":
        # Handing over ownership: only the owner, and they become an admin.
        if me.role != "owner" or body.role != "owner" or target.user_id == user.id:
            raise core.forbidden("Only the owner can hand over the space")
        me.role = "admin"
    elif not core.is_admin(me):
        raise core.forbidden("Only the space's admins can change roles")
    target.role = body.role
    await db.commit()
    from app.calls import voice as calls_voice

    await calls_voice.regrant(db, space.id, target.user_id)
    if body.role == "owner":
        await calls_voice.regrant(db, space.id, user.id)
    await _space_event(db, space.id)
    return {"ok": True}


@router.delete("/spaces/{space_id}/members/{user_id}", status_code=204)
async def remove_member(space_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    space, me = await core.load_space(db, space_id, user)
    target = await core.space_member(db, space.id, user_id)
    if target is None:
        raise core.not_found("Member")
    if target.role == "owner":
        raise core.forbidden("The owner can't leave — hand the space over or delete it")
    if user_id != user.id and not (core.is_admin(me) and (me.role == "owner" or target.role == "member")):
        raise core.forbidden("You can't remove that person")
    members = await core.space_member_ids(db, space.id)
    await db.delete(target)
    room_ids = select(Room.id).where(Room.space_id == space.id)
    await db.execute(delete(RoomMember).where(RoomMember.user_id == user_id, RoomMember.room_id.in_(room_ids)))
    await db.commit()
    from app.calls import voice as calls_voice

    await calls_voice.space_member_removed(db, space.id, user_id)
    await core.publish(members, {"type": "space", "space_id": str(space.id)})
    await core.publish([user_id], {"type": "space_delete", "space_id": str(space.id)})


class NotifyIn(BaseModel):
    notify: str

    @field_validator("notify")
    @classmethod
    def _n(cls, v: str) -> str:
        if v not in core.NOTIFY:
            raise ValueError("notify is all, mentions or none")
        return v


@router.patch("/spaces/{space_id}/me")
async def space_me(space_id: uuid.UUID, body: NotifyIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    _space, me = await core.load_space(db, space_id, user)
    me.notify = body.notify
    await db.commit()
    await core.publish([user.id], {"type": "space", "space_id": str(space_id)})
    return {"ok": True}


# ================================================================== rooms


class RoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    topic: str = Field(default="", max_length=300)
    # "voice": a voice channel (Calls). Its name keeps its spaces and capitals.
    kind: Literal["text", "voice"] = "text"


class RoomPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    topic: str | None = Field(default=None, max_length=300)
    position: int | None = Field(default=None, ge=0, le=10_000)
    ai_context: bool | None = None


def _room_name(name: str) -> str:
    return "-".join(name.strip().lstrip("#").lower().split())[:80] or "room"


def _voice_name(name: str) -> str:
    return " ".join(name.strip().split())[:80] or "Voice"


async def _room_event(db: AsyncSession, room: Room) -> None:
    """Each member gets the room as they see it (unread etc. are personal)."""
    for uid in await core.member_ids(db, room):
        u = await db.get(User, uid)
        if u is not None:
            await core.publish([uid], {"type": "room", "room": await core.room_out(db, room, u)})


@router.post("/spaces/{space_id}/rooms", status_code=201)
async def create_room(space_id: uuid.UUID, body: RoomIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    space, me = await core.load_space(db, space_id, user)
    if not core.is_admin(me):
        raise core.forbidden("Only the space's admins can add rooms")
    if body.kind == "voice":
        from app.calls import access as calls_access

        if not await calls_access.voice_allowed(db, user):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Voice isn't turned on for you on this server")
    top = (await db.execute(select(func.max(Room.position)).where(Room.space_id == space.id))).scalar() or 0
    name = _voice_name(body.name) if body.kind == "voice" else _room_name(body.name)
    room = Room(space_id=space.id, kind=body.kind, name=name, topic=body.topic.strip(), position=top + 1, created_by=user.id)
    db.add(room)
    if body.kind == "voice":
        from app.calls.models import RoomVoice

        await db.flush()
        db.add(RoomVoice(room_id=room.id))
    await db.commit()
    await _room_event(db, room)
    return await core.room_out(db, room, user)


@router.patch("/rooms/{room_id}")
async def update_room(room_id: uuid.UUID, body: RoomPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, sm = await core.load_room(db, room_id, user)
    data = body.model_dump(exclude_unset=True)
    if room.space_id is None:
        # A group conversation can be named by any member; nothing else here.
        if room.kind != "group" or set(data) - {"name"}:
            raise core.forbidden("Use your own settings for a conversation")
        room.name = (data.get("name") or "").strip()[:80]
    else:
        if not core.is_admin(sm):
            raise core.forbidden("Only the space's admins can change rooms")
        if data.get("name"):
            room.name = _voice_name(data["name"]) if room.kind == "voice" else _room_name(data["name"])
        if data.get("topic") is not None:
            room.topic = data["topic"].strip()
        if data.get("position") is not None:
            room.position = data["position"]
        if data.get("ai_context") is not None and data["ai_context"] != room.ai_context:
            room.ai_context = data["ai_context"]
            await _system(db, room, f"{user.username} {'let' if room.ai_context else 'stopped'} @promptly {'read' if room.ai_context else 'reading'} this room.")
    await db.commit()
    await _room_event(db, room)
    return await core.room_out(db, room, user)


@router.delete("/rooms/{room_id}", status_code=204)
async def delete_room(room_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    room, sm = await core.load_room(db, room_id, user)
    if room.space_id is None or not core.is_admin(sm):
        raise core.forbidden("Only the space's admins can delete rooms")
    members = await core.member_ids(db, room)
    if room.kind == "voice":
        from app.calls import voice as calls_voice

        await calls_voice.rooms_gone(db, [room.id])
    await db.delete(room)
    await db.commit()
    service.remove_room_files(room_id)
    await core.publish(members, {"type": "room_delete", "room_id": str(room_id)})


async def _system(db: AsyncSession, room: Room, text: str) -> RoomMessage:
    """A small centred line in the room ("Sam turned on …")."""
    locked = await db.get(Room, room.id, with_for_update=True)
    msg = RoomMessage(room_id=room.id, seq=service.next_seq(locked), author_id=None, kind="system", body=text)
    db.add(msg)
    await db.flush()
    spawn(_publish_later(msg.id), name=f"rooms-sys-{msg.id}")
    return msg


async def _publish_later(message_id: uuid.UUID) -> None:
    from app.database import SessionLocal

    await asyncio.sleep(0.05)
    async with SessionLocal() as db:
        msg = await db.get(RoomMessage, message_id)
        room = await db.get(Room, msg.room_id) if msg else None
        if msg is None or room is None:
            return
        await core.publish(await core.member_ids(db, room), {"type": "message", "message": await core.message_out(db, msg)})


# ================================================================== DMs


class DmIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


@router.post("/dms")
async def open_dm(body: DmIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    # The same 1:1 conversation every time; a block either way refuses a new
    # one (decision D7). The others see it once there's a message in it.
    room = await service.open_dm(db, user, body.user_ids)
    return await core.room_out(db, room, user)


class MeIn(BaseModel):
    notify: str | None = None
    hidden: bool | None = None
    ai_ok: bool | None = None

    @field_validator("notify")
    @classmethod
    def _n(cls, v: str | None) -> str | None:
        if v is not None and v not in core.NOTIFY and v != "default":
            raise ValueError("notify is all, mentions, none or default")
        return v


@router.patch("/rooms/{room_id}/me")
async def room_me(room_id: uuid.UUID, body: MeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, _sm = await core.load_room(db, room_id, user)
    st = await core.my_state(db, room.id, user.id)
    data = body.model_dump(exclude_unset=True)
    if "notify" in data:
        st.notify = None if data["notify"] in (None, "default") else data["notify"]
    if data.get("hidden") is not None:
        if room.space_id is not None:
            raise core.forbidden("Only conversations can be closed")
        st.hidden = data["hidden"]
    ai_changed = False
    if data.get("ai_ok") is not None:
        if room.space_id is not None:
            raise core.forbidden("A room's AI switch is the admins' (PATCH /rooms/{id})")
        ai_changed = st.ai_ok != data["ai_ok"]
        st.ai_ok = data["ai_ok"]
        if ai_changed:
            await _system(db, room, f"{user.username} {'is happy for' if st.ai_ok else 'no longer lets'} @promptly {'to read' if st.ai_ok else 'read'} this conversation.")
    await db.commit()
    if ai_changed:
        await _room_event(db, room)
    else:
        await core.publish([user.id], {"type": "room", "room": await core.room_out(db, room, user)})
    return await core.room_out(db, room, user)


# ================================================================== messages


@router.get("/rooms/{room_id}/messages")
async def list_messages(
    room_id: uuid.UUID,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    room, _sm = await core.load_room(db, room_id, user)
    base = select(RoomMessage).where(RoomMessage.room_id == room.id)
    if around is not None:
        half = max(1, limit // 2)
        older = list((await db.execute(base.where(RoomMessage.seq < around).order_by(RoomMessage.seq.desc()).limit(half))).scalars())
        newer = list((await db.execute(base.where(RoomMessage.seq >= around).order_by(RoomMessage.seq).limit(limit - half))).scalars())
        rows = older[::-1] + newer
    elif after is not None:
        rows = list((await db.execute(base.where(RoomMessage.seq > after).order_by(RoomMessage.seq).limit(limit))).scalars())
    else:
        q = base.where(RoomMessage.seq < before) if before is not None else base
        rows = list((await db.execute(q.order_by(RoomMessage.seq.desc()).limit(limit))).scalars())[::-1]
    first = rows[0].seq if rows else None
    last = rows[-1].seq if rows else None
    more_before = first is not None and (await db.execute(select(func.count()).select_from(base.where(RoomMessage.seq < first).subquery()))).scalar() > 0
    more_after = last is not None and last < room.last_seq
    if not rows and after is not None:
        more_after = False
    return {"messages": await core.messages_out(db, rows), "has_more_before": bool(more_before), "has_more_after": bool(more_after)}


class MessageIn(BaseModel):
    body: str = Field(default="", max_length=core.MAX_BODY)
    reply_to_id: uuid.UUID | None = None
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=service.MAX_ATTACHMENTS)
    client_id: str | None = Field(default=None, max_length=64)


@router.post("/rooms/{room_id}/messages", status_code=201)
async def send(room_id: uuid.UUID, body: MessageIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, _sm = await core.load_room(db, room_id, user, lock=True)
    msg = await service.post_message(db, room, user, body.body, reply_to_id=body.reply_to_id, attachment_ids=body.attachment_ids, client_id=body.client_id)
    await db.commit()
    await db.refresh(msg)
    out = await core.message_out(db, msg)
    await core.publish(await core.member_ids(db, room), {"type": "message", "message": out})
    if room.space_id is None:
        # A re-opened conversation shows up in the others' lists.
        for uid in await core.member_ids(db, room):
            if uid != user.id:
                u = await db.get(User, uid)
                if u is not None:
                    await core.publish([uid], {"type": "room", "room": await core.room_out(db, room, u)})
    spawn(fan_out(msg.id), name=f"rooms-push-{msg.id}")
    if "promptly" in (msg.mentions or []):
        from .promptly import answer

        spawn(answer(msg.id), name=f"rooms-promptly-{msg.id}")
    return out


class MessagePatch(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=core.MAX_BODY)
    pinned: bool | None = None


async def _load_message(db: AsyncSession, message_id: uuid.UUID, user: User) -> tuple[RoomMessage, Room, RoomSpaceMember | None]:
    msg = await db.get(RoomMessage, message_id)
    if msg is None:
        raise core.not_found("Message")
    room, sm = await core.load_room(db, msg.room_id, user)
    return msg, room, sm


@router.patch("/messages/{message_id}")
async def edit_message(message_id: uuid.UUID, body: MessagePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    msg, room, _sm = await _load_message(db, message_id, user)
    if msg.deleted_at is not None:
        raise core.not_found("Message")
    data = body.model_dump(exclude_unset=True)
    if data.get("body") is not None:
        if msg.author_id != user.id or msg.kind != "user":
            raise core.forbidden("You can only edit your own messages")
        text = data["body"].strip()
        if text != msg.body:
            msg.body = text
            msg.mentions = await core.parse_mentions(db, text, await core.member_ids(db, room))
            msg.edited_at = _now()
            from app.links.service import sync_text

            await sync_text(db, "room_msg", msg.id, text, user_id=user.id)
    if data.get("pinned") is not None:
        if msg.kind == "system":
            raise core.forbidden("That can't be pinned")
        msg.pinned_at = _now() if data["pinned"] else None
        msg.pinned_by = user.id if data["pinned"] else None
    await db.commit()
    out = await core.message_out(db, msg)
    await core.publish(await core.member_ids(db, room), {"type": "message_edit", "message": out})
    return out


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(message_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    msg, room, sm = await _load_message(db, message_id, user)
    if msg.deleted_at is not None:
        return
    mine = msg.author_id == user.id
    # Admins can remove anything in their space, and anyone can remove a
    # Promptly answer to their own question.
    asked = msg.kind == "promptly" and (msg.meta or {}).get("asked_by") == str(user.id)
    if not (mine or asked or core.is_admin(sm)):
        raise core.forbidden("You can only delete your own messages")
    msg.deleted_at = _now()
    msg.body = ""
    msg.pinned_at = None
    msg.mentions = []
    atts = (await db.execute(select(RoomAttachment).where(RoomAttachment.message_id == msg.id))).scalars().all()
    for a in atts:
        service.remove_attachment_files(a)
        await db.delete(a)
    await db.execute(delete(RoomReaction).where(RoomReaction.message_id == msg.id))
    from app.links.service import purge_sources

    await purge_sources(db, "room_msg", [msg.id])
    await db.commit()
    await core.publish(await core.member_ids(db, room), {"type": "message_delete", "room_id": str(room.id), "id": str(msg.id)})


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=32)


@router.put("/messages/{message_id}/reactions")
async def react(message_id: uuid.UUID, body: ReactionIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    msg, room, _sm = await _load_message(db, message_id, user)
    if msg.deleted_at is not None:
        raise core.not_found("Message")
    emoji = body.emoji.strip()
    if await db.get(RoomReaction, (msg.id, user.id, emoji)) is None:
        kinds = (await db.execute(select(func.count(func.distinct(RoomReaction.emoji))).where(RoomReaction.message_id == msg.id))).scalar() or 0
        known = (await db.execute(select(RoomReaction).where(RoomReaction.message_id == msg.id, RoomReaction.emoji == emoji).limit(1))).first()
        if kinds >= 20 and known is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That's enough different reactions")
        db.add(RoomReaction(message_id=msg.id, user_id=user.id, emoji=emoji))
        await db.commit()
    return await _reaction_event(db, msg, room)


@router.delete("/messages/{message_id}/reactions")
async def unreact(message_id: uuid.UUID, emoji: str = Query(..., max_length=32), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    msg, room, _sm = await _load_message(db, message_id, user)
    await db.execute(delete(RoomReaction).where(RoomReaction.message_id == msg.id, RoomReaction.user_id == user.id, RoomReaction.emoji == emoji.strip()))
    await db.commit()
    return await _reaction_event(db, msg, room)


async def _reaction_event(db: AsyncSession, msg: RoomMessage, room: Room) -> dict:
    reactions = await core.reactions_of(db, msg.id)
    await core.publish(await core.member_ids(db, room), {"type": "reaction", "room_id": str(room.id), "message_id": str(msg.id), "reactions": reactions})
    return {"reactions": reactions}


@router.get("/rooms/{room_id}/pins")
async def pins(room_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    room, _sm = await core.load_room(db, room_id, user)
    rows = (
        await db.execute(
            select(RoomMessage)
            .where(RoomMessage.room_id == room.id, RoomMessage.pinned_at.is_not(None), RoomMessage.deleted_at.is_(None))
            .order_by(RoomMessage.pinned_at.desc())
            .limit(100)
        )
    ).scalars().all()
    return await core.messages_out(db, list(rows))


class ReadIn(BaseModel):
    seq: int = Field(ge=0)


@router.post("/rooms/{room_id}/read")
async def mark_read(room_id: uuid.UUID, body: ReadIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, _sm = await core.load_room(db, room_id, user)
    st = await core.my_state(db, room.id, user.id)
    seq = min(body.seq, room.last_seq)
    if seq > st.last_read_seq:
        st.last_read_seq = seq
        await db.commit()
        await core.publish([user.id], {"type": "read", "room_id": str(room.id), "seq": seq})
    return {"last_read_seq": st.last_read_seq}


@router.post("/rooms/{room_id}/typing", status_code=204)
async def typing(room_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    room, _sm = await core.load_room(db, room_id, user)
    others = [u for u in await core.member_ids(db, room) if u != user.id]
    await core.publish(others, {"type": "typing", "room_id": str(room.id), "user_id": str(user.id)})


class PresenceIn(BaseModel):
    room_id: uuid.UUID | None = None


@router.post("/presence", status_code=204)
async def presence(body: PresenceIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    if body.room_id is not None:
        await core.load_room(db, body.room_id, user)
    await core.set_presence(user.id, body.room_id)


# ================================================================== attachments


@router.post("/rooms/{room_id}/attachments", status_code=201)
async def upload(room_id: uuid.UUID, file: UploadFile = File(...), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    room, _sm = await core.load_room(db, room_id, user)
    att = await service.store_attachment(db, room, user, file)
    await db.commit()
    return core.attachment_out(att)


_INLINE = ("image/", "video/", "audio/")


@router.get("/attachments/{att_id}")
async def get_attachment(att_id: uuid.UUID, exp: int, sig: str, thumb: int = 0, db: AsyncSession = Depends(get_db)) -> FileResponse:
    """Signed (for ``<img src>``), no bearer: the signature is the credential."""
    if not core.verify_attachment_sig(att_id, exp, sig):
        raise core.not_found("File")
    att = await db.get(RoomAttachment, att_id)
    if att is None:
        raise core.not_found("File")
    want_thumb = bool(thumb) and att.has_thumb
    path = absolute_path(service.att_path(att, want_thumb))
    if not path.exists():
        raise core.not_found("File")
    mime = "image/webp" if want_thumb else att.mime
    inline = (mime.startswith(_INLINE) and mime != "image/svg+xml") or mime == "application/pdf"
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
        "Cache-Control": "private, max-age=3600",
    }
    return FileResponse(
        path,
        media_type=mime if inline else "application/octet-stream",
        filename=att.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers=headers,
    )


# ================================================================== search


@router.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=200), room_id: uuid.UUID | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    if room_id is not None:
        await core.load_room(db, room_id, user)
        rooms = [room_id]
    else:
        rooms = await core.visible_room_ids(db, user.id)
    if not rooms:
        return []
    words = [w for w in q.split() if w][:8]
    cond = RoomMessage.room_id.in_(rooms)
    for w in words:
        esc = w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        cond = cond & RoomMessage.body.ilike(f"%{esc}%", escape="\\")
    rows = (
        await db.execute(
            select(RoomMessage).where(cond, RoomMessage.deleted_at.is_(None), RoomMessage.kind != "system").order_by(RoomMessage.created_at.desc()).limit(50)
        )
    ).scalars().all()
    return [{"message": m, "room_id": m["room_id"]} for m in await core.messages_out(db, list(rows))]


# ================================================================== live


@router.get("/events")
async def events(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> StreamingResponse:
    # The stream lives for minutes (hours, for a backgrounded phone), and the
    # request's session would hold a pooled DB connection the whole time —
    # enough open clients drained the pool and took the server down.
    await db.close()
    return StreamingResponse(
        _stream(user.id, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _stream(user_id: uuid.UUID, request: Request) -> AsyncGenerator[str, None]:
    from app.redis_client import redis

    pubsub = redis.pubsub()
    ch = core.channel(user_id)
    try:
        await pubsub.subscribe(ch)
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                return
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            if message is None:
                yield ": ping\n\n"
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            if data:
                yield f"data: {data}\n\n"
    except asyncio.CancelledError:
        return
    finally:
        try:
            await pubsub.unsubscribe(ch)
            closer = getattr(pubsub, "aclose", None) or pubsub.close
            await closer()
        except Exception:  # noqa: BLE001
            pass
