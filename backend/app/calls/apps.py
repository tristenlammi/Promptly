"""Voice channels in the rest of Promptly (Calls WP-V4): the Today line
("Sam and Jo are in Lounge") and your voice sessions in "Export my
library". Both read only who was where and for how long; nothing said is
stored anywhere.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User


async def today_section(db: AsyncSession, user: User, limit: int = 4) -> dict[str, Any] | None:
    """Voice channels of your spaces with people in them right now (not
    counting a channel where you're the only one). None when nobody is
    hanging out, or voice is off for you."""
    from app.calls import access, voice
    from app.rooms.models import Room, RoomSpace, RoomSpaceMember

    if not await access.voice_allowed(db, user):
        return None
    rows = (
        await db.execute(
            select(Room.id, Room.name, RoomSpace.name)
            .join(RoomSpace, RoomSpace.id == Room.space_id)
            .join(RoomSpaceMember, (RoomSpaceMember.space_id == Room.space_id) & (RoomSpaceMember.user_id == user.id))
            .where(Room.kind == "voice")
            .order_by(RoomSpace.name, Room.position, Room.name)
        )
    ).all()
    if not rows:
        return None
    me = str(user.id)
    where = await voice.where(user.id)
    out: list[dict[str, Any]] = []
    for rid, name, space in rows:
        ids = [m["user_id"] for m in await voice.members(rid)]
        others = [u for u in ids if u != me]
        if not others:
            continue
        out.append({"room_id": str(rid), "name": name, "space": space, "user_ids": ids, "here": me in ids, "url": f"/rooms/r/{rid}"})
    if not out:
        return None
    # People with someone you know first, then the busiest.
    out.sort(key=lambda c: (not c["here"], -len(c["user_ids"])))
    out = out[:limit]
    users = {str(u.id): u.username for u in (await db.execute(select(User).where(User.id.in_([uuid.UUID(x) for c in out for x in c["user_ids"]])))).scalars()}
    for c in out:
        c["people"] = [users.get(u, "Someone") for u in c["user_ids"] if u != me]
    return {"channels": out, "in_voice": (where or {}).get("room_id")}


async def export_sessions(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    """Your own voice sessions for "Export my library": which channel, in
    which space, when you joined, when you left and how long you were in.
    Oldest first."""
    from app.calls.models import Call, CallParticipant
    from app.rooms.models import Room, RoomSpace

    rows = (
        await db.execute(
            select(CallParticipant, Call, Room.name, RoomSpace.name)
            .join(Call, Call.id == CallParticipant.call_id)
            .outerjoin(Room, Room.id == Call.room_id)
            .outerjoin(RoomSpace, RoomSpace.id == Room.space_id)
            .where(CallParticipant.user_id == user_id)
            .order_by(CallParticipant.first_joined_at)
        )
    ).all()
    out = []
    for p, call, room_name, space_name in rows:
        out.append(
            {
                "kind": call.kind,
                "channel": room_name,
                "space": space_name,
                "joined_at": p.first_joined_at.isoformat() if p.first_joined_at else None,
                "left_at": p.last_left_at.isoformat() if p.last_left_at else None,
                "minutes": round((p.seconds or 0) / 60, 1),
            }
        )
    return out
