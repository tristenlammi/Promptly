"""Events in Rooms: plan an event in a room, or share one to it.

Planning in a room invites everyone in it (they all get it on their
calendar) and posts a card; sharing an existing event just posts the card.
Either way, anyone in the room — people who join later too — can answer
from the card, which adds them as a guest. Nothing else of the calendar is
shown to the room.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import core, notify
from .models import CalEvent, CalEventRoom


async def share_to_room(db: AsyncSession, user: User, ev: CalEvent, room_id: uuid.UUID, *, invite_all: bool) -> tuple[uuid.UUID, uuid.UUID]:
    """Post ``ev``'s card in the room (and, ``invite_all``, add everyone in it
    as a guest). Returns (room id, message id); the caller commits, then
    calls :func:`publish_card`."""
    from app.rooms import core as rooms_core
    from app.rooms import service as rooms_service

    from .models import CalAttendee

    room, _sm = await rooms_core.load_room(db, room_id, user, lock=True)
    if invite_all:
        have = {a for a in (await db.execute(select(CalAttendee.user_id).where(CalAttendee.event_id == ev.id))).scalars()}
        for uid in await rooms_core.member_ids(db, room):
            if uid != ev.created_by and uid not in have:
                db.add(CalAttendee(event_id=ev.id, user_id=uid, invited_by=user.id))
    tz = core.user_tz(user)
    body = f"📅 {ev.title} · {notify.when_text(ev.start_at, ev.end_at, ev.all_day, tz)}"
    msg = await rooms_service.post_message(db, room, user, body)
    msg.meta = {**(msg.meta or {}), "event_id": str(ev.id)}
    link = await db.get(CalEventRoom, (ev.id, room.id))
    if link is None:
        db.add(CalEventRoom(event_id=ev.id, room_id=room.id, message_id=msg.id, shared_by=user.id))
    else:
        link.message_id = msg.id
    await db.flush()
    return room.id, msg.id


async def publish_card(db: AsyncSession, room_id: uuid.UUID, message_id: uuid.UUID) -> None:
    """After commit: show the card live and send the room's usual pushes."""
    from app.background import spawn
    from app.rooms import core as rooms_core
    from app.rooms.models import Room, RoomMessage
    from app.rooms.push import fan_out

    room = await db.get(Room, room_id)
    msg = await db.get(RoomMessage, message_id)
    if room is None or msg is None:
        return
    await rooms_core.publish(await rooms_core.member_ids(db, room), {"type": "message", "message": await rooms_core.message_out(db, msg)})
    spawn(fan_out(msg.id), name=f"rooms-push-{msg.id}")


async def rooms_out(db: AsyncSession, ev: CalEvent, user: User) -> list[dict]:
    """The rooms you're in that this event was shared to — "Planned in #general"."""
    from app.rooms.models import Room, RoomSpace

    ids = await core.shared_rooms(db, ev.id, user)
    if not ids:
        return []
    out = []
    rows = (await db.execute(select(Room, RoomSpace).outerjoin(RoomSpace, RoomSpace.id == Room.space_id).where(Room.id.in_(ids)))).all()
    for room, space in rows:
        if room.space_id is None:
            name = room.name or "Messages"
        else:
            name = f"#{room.name}" + (f" · {space.name}" if space else "")
        out.append({"room_id": str(room.id), "name": name})
    return out


async def contact_people(db: AsyncSession, user: User) -> list[dict]:
    """Promptly people who are in your Contacts — matched by an email on the
    contact, else by name — with what they are to you when Photos knows
    ("Wife": the relationship you gave the person linked to that contact)."""
    from sqlalchemy import text

    from app.items import service as items
    from app.items.kinds.contacts.logic import display_name

    others = list((await db.execute(select(User).where(User.disabled.is_(False), User.id != user.id))).scalars())
    if not others:
        return []
    by_email = {(u.email or "").lower(): u for u in others if u.email}
    by_name = {(u.username or "").lower(): u for u in others}
    found: dict[uuid.UUID, dict] = {}
    for row, doc in await items.list_items(db, user, "contacts", archives=False):
        for c in (doc.data or {}).get("contacts", []):
            u = next((by_email[e.get("value", "").lower()] for e in c.get("emails", []) if e.get("value", "").lower() in by_email), None)
            name = display_name(c)
            if u is None:
                u = by_name.get(name.lower()) or by_name.get((c.get("first") or "").lower()) or by_name.get((c.get("nickname") or "").lower())
            if u is None or u.id in found:
                continue
            found[u.id] = {"user": core.user_out(u), "contact_name": name, "label": None, "file_id": str(row.id), "contact_id": c["id"]}
    if not found:
        return []
    # What Photos calls them: the person linked to that contact (or to that
    # Promptly account), and the relationship you gave them.
    rows = (
        await db.execute(
            text(
                "SELECT p.contact_file_id, p.contact_id, p.linked_user_id, r.label FROM photo_people p "
                "JOIN photo_relationships r ON r.person_id = p.id AND r.viewer_user_id = :u "
                "WHERE p.user_id = :u AND r.label IS NOT NULL AND r.label <> ''"
            ),
            {"u": user.id},
        )
    ).all()
    for r in rows:
        for f in found.values():
            if (str(r.contact_file_id), r.contact_id) == (f["file_id"], f["contact_id"]) or (r.linked_user_id and str(r.linked_user_id) == f["user"]["id"]):
                f["label"] = r.label
    out = sorted(found.values(), key=lambda f: (f["label"] is None, f["contact_name"].lower()))
    for f in out:
        f.pop("file_id"), f.pop("contact_id")
    return out[:30]
