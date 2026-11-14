"""Rooms: who has a message (Sent → Delivered → Seen), muting for a while,
and taking a read conversation's notification off your phone.

**Seen** is the read position every room already keeps (``last_read_seq``),
shown to the other people in a conversation (a DM or a group conversation).
Space rooms show none of this: nothing about who read what in a busy room.

**Delivered** (``delivered_seq``) is what the server can honestly know:

* one of their open pages said it has the message (``POST …/delivered``, sent
  by the page when the message arrives on its live feed, or when it loads the
  conversation list, which carries the latest message), or
* a push service (Google's, Apple's, Mozilla's) accepted a notification for it
  for at least one of their devices. That is "handed to their phone's
  delivery service", not "the phone lit up": a phone that is switched off
  still counts once the service has it.

Reading something means it was delivered.

**Muting for a while** (``muted_until`` on your room row, or on your space
membership for the whole space) is "nothing" until that time, then your level
is what it was. "Until I turn it back on" is the level "none", as before.
A mute covers messages. Calls still ring: a call is someone trying to reach
you now, and quiet hours, blocking and the per-device switch are what stop
those.

**Clearing** (:func:`clear_elsewhere`): when you've read a conversation to
its end anywhere, the Promptly Android app on your phones is sent a silent
push that takes that conversation's notification down. Browsers aren't sent
one: a push that shows nothing makes Chrome put up its own "this site has
been updated in the background" notice.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import core
from .models import Room, RoomMember, RoomSpaceMember

logger = logging.getLogger("promptly.rooms.receipts")

MUTE_MAX = timedelta(days=7)


# ------------------------------------------------------------------ levels


def is_muted(until: datetime | None, now: datetime | None = None) -> bool:
    return until is not None and until > (now or datetime.now(timezone.utc))


def level(room_state: RoomMember | None, space_member: RoomSpaceMember | None, now: datetime | None = None) -> str:
    """What you hear from a room: muted for a while (the room, or its whole
    space) is "none"; then your setting for the room; then the space's; then
    "all"."""
    if room_state is not None and is_muted(room_state.muted_until, now):
        return "none"
    if space_member is not None and is_muted(space_member.muted_until, now):
        return "none"
    return (room_state.notify if room_state and room_state.notify else None) or (space_member.notify if space_member else None) or "all"


def mute_until(value: datetime | None) -> datetime | None:
    """A mute's end as the page asked for it: in the future, a week at most.
    None (or a time already past) is "not muted"."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if value <= now:
        return None
    return min(value, now + MUTE_MAX)


def iso(until: datetime | None) -> str | None:
    return until.isoformat() if is_muted(until) else None


# ------------------------------------------------------------------ receipts


def shows_receipts(room: Room) -> bool:
    return room.space_id is None


def receipts_out(members: list[RoomMember], me: uuid.UUID) -> dict[str, dict[str, int]]:
    """The others' positions in a conversation, for its members only."""
    return {
        str(m.user_id): {"read": m.last_read_seq, "delivered": max(m.delivered_seq or 0, m.last_read_seq)}
        for m in members
        if m.user_id != me
    }


async def _tell(db: AsyncSession, room: Room, user_id: uuid.UUID) -> None:
    if not (await server(db))[0]:
        return
    st = await db.get(RoomMember, (room.id, user_id))
    if st is None:
        return
    await db.refresh(st)
    others = [u for u in await core.member_ids(db, room) if u != user_id]
    await core.publish(
        others,
        {
            "type": "receipt",
            "room_id": str(room.id),
            "user_id": str(user_id),
            "read": st.last_read_seq,
            "delivered": max(st.delivered_seq or 0, st.last_read_seq),
        },
    )


async def after_read(db: AsyncSession, room: Room, user_id: uuid.UUID, seq: int) -> None:
    """``user_id`` has just read ``room`` up to ``seq`` (already saved): the
    others in a conversation see it, and its notification comes off their own
    phones. Never fails the read."""
    try:
        if shows_receipts(room):
            # What you've read has reached you.
            await db.execute(
                update(RoomMember)
                .where(RoomMember.room_id == room.id, RoomMember.user_id == user_id, RoomMember.delivered_seq < RoomMember.last_read_seq)
                .values(delivered_seq=RoomMember.last_read_seq)
            )
            await db.commit()
            await _tell(db, room, user_id)
        if seq >= room.last_seq:
            from app.background import spawn

            spawn(clear_elsewhere(user_id, room.id, seq), name=f"rooms-clear-{room.id}-{user_id}")
    except Exception:  # noqa: BLE001
        logger.debug("rooms receipt failed", exc_info=True)


async def delivered(db: AsyncSession, room: Room, user_id: uuid.UUID, seq: int) -> bool:
    """Messages up to ``seq`` reached one of ``user_id``'s devices. True when
    that's news (the others are told)."""
    if not shows_receipts(room):
        return False
    upto = min(max(seq, 0), room.last_seq)
    done = await db.execute(
        update(RoomMember)
        .where(RoomMember.room_id == room.id, RoomMember.user_id == user_id, RoomMember.delivered_seq < upto)
        .values(delivered_seq=upto)
    )
    await db.commit()
    if not done.rowcount:
        return False
    await _tell(db, room, user_id)
    return True


async def delivered_by_push(room_id: uuid.UUID, user_id: uuid.UUID, seq: int) -> None:
    """A push service took a notification for this message for one of their
    devices."""
    from app.database import SessionLocal

    try:
        async with SessionLocal() as db:
            room = await db.get(Room, room_id)
            if room is not None:
                await delivered(db, room, user_id, seq)
    except Exception:  # noqa: BLE001
        logger.debug("rooms delivered-by-push failed", exc_info=True)


async def delivered_all(db: AsyncSession, user_id: uuid.UUID) -> None:
    """The conversation list was loaded on one of their devices: it carries
    each conversation's latest message, so everything in them has arrived."""
    try:
        rows = (
            await db.execute(
                update(RoomMember)
                .where(
                    RoomMember.user_id == user_id,
                    RoomMember.room_id == Room.id,
                    Room.space_id.is_(None),
                    RoomMember.delivered_seq < Room.last_seq,
                )
                .values(delivered_seq=Room.last_seq)
                .returning(RoomMember.room_id)
            )
        ).scalars().all()
        await db.commit()
        for rid in rows:
            room = await db.get(Room, rid)
            if room is not None:
                await _tell(db, room, user_id)
    except Exception:  # noqa: BLE001
        await db.rollback()
        logger.debug("rooms delivered-all failed", exc_info=True)


# ------------------------------------------------------------------ clearing


def clear_payload(room_id: uuid.UUID, seq: int, badge: int) -> dict[str, Any]:
    """What the app reads (``PushPayload.clear``): no words, nothing to show."""
    return {"clear": True, "seq": seq, "app_badge": badge}


async def clear_elsewhere(user_id: uuid.UUID, room_id: uuid.UUID, seq: int) -> int:
    """Take ``room_id``'s notification down on the person's phones (the
    Promptly Android app). Returns how many were told. Not a notification: it
    isn't held by quiet hours or the category switches, but a device whose own
    switch is off was never sent the message, so isn't sent this either."""
    from app.database import SessionLocal
    from app.notifications import devices
    from app.notifications.dispatch import PushPayload, deliver
    from app.notifications.models import PushSubscription

    try:
        async with SessionLocal() as db:
            subs = (await db.execute(select(PushSubscription).where(PushSubscription.user_id == user_id, PushSubscription.enabled.is_(True)))).scalars().all()
            if not any(devices.takes_clears(s.user_agent) for s in subs):
                return 0
            payload = PushPayload(
                title="",
                body="",
                tag=f"room:{room_id}",
                category="room_read",
                extra=clear_payload(room_id, seq, await core.unread_total(db, user_id)),
                urgency="low",
                # One per conversation waits at the push service: a later one
                # replaces it.
                topic="rr" + room_id.hex[:30],
            )
            sent = await deliver(db, user_id, payload, only=lambda s: devices.takes_clears(s.user_agent))
            return sent.get("delivered", 0)
    except Exception:  # noqa: BLE001
        logger.debug("rooms clear push failed", exc_info=True)
        return 0


# ------------------------------------------------------------------ the server's settings


async def server(db: AsyncSession) -> tuple[bool, str]:
    """``(read receipts on, the level a person starts a space with)``: two of
    the admin's Rooms settings (Admin → Rooms; ``settings.py``
    ``read_receipts`` and ``default_notify``)."""
    from . import settings

    s = await settings.load(db)
    start = s["default_notify"] if s["default_notify"] in core.NOTIFY else "all"
    return bool(s["read_receipts"]), start
