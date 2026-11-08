"""What a DM call says to people: the ringing push, the push that stops it
ringing on your other devices, the missed-call push, and the line it leaves
in the conversation ("Call · 12 min", "Missed call").

**Ringing** goes two ways at once:

* a Web Push in the ``call`` category: ``Urgency: high`` (wakes a dozing
  phone) and ``TTL: 45`` (a ring that can't arrive in 45 s is pointless).
  Dispatch never holds it (``dispatch.RULES["call"]`` is ``Rule(False)``);
  during your quiet hours it doesn't ring at all unless you let calls ring
  through (``rings_quietly``), and the missed call is held until they end.
  A block either way drops it (``actor_user_id``). The service worker shows
  it to every open tab with a ringtone; on Android, the app's
  ``Delegation`` turns a ``call:`` notification into a full-screen ring;
* a ``call_ring`` event on the Rooms stream, for pages already open.

Every push about one call has the tag ``call:<id>``, so each replaces the
last on a device: the ring, then "Answered on another device" (``kind:
call_stop``, which the worker closes at once) or "Missed call".

The push's buttons: **Decline** carries a signed action token
(``notifications/actions.py``, works with no page open); **Answer** opens
the conversation (``answer_url``), and the Android incoming-call screen
redeems ``answer_token`` at ``POST /api/calls/answer``.
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.calls.models import Call, CallParticipant
from app.rooms import core as rooms_core
from app.rooms.models import Room, RoomMember, RoomMessage

logger = logging.getLogger("promptly.calls.ring")

RING_TTL = 45  # seconds: Web Push TTL of a ring, and how long it rings
ANSWER_TOKEN_TTL = 2 * 60
MISSED_TTL = 24 * 3600
ICON = "/item-icons/rooms-192.png"


async def rings_quietly(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """It's this person's quiet hours and they haven't let calls ring
    through (Account → Notifications): a call doesn't ring them; the
    missed call is told when quiet hours end (Calls WP-D5)."""
    from app.notifications import quiet
    from app.notifications.models import PushPreferences

    prefs = await db.get(PushPreferences, user_id)
    if prefs is None or not prefs.quiet_enabled or prefs.call_ring_through:
        return False
    user = await db.get(User, user_id)
    return quiet.is_quiet(prefs, quiet._now(), quiet.zone_of(user.settings if user is not None else None))


async def _notify(**kw: Any) -> None:
    """``notify_user`` (tests swap this to see what would be pushed)."""
    from app.notifications.dispatch import notify_user

    await notify_user(**kw)


def _ring_until(call: Call, parts: dict[uuid.UUID, CallParticipant], user_id: uuid.UUID) -> str | None:
    p = parts.get(user_id)
    if p is None or p.rung_at is None:
        return None
    return (p.rung_at + timedelta(seconds=RING_TTL)).isoformat()


async def conversation_name(db: AsyncSession, room: Room, viewer: uuid.UUID | None = None) -> str:
    """A group's name, or its members' names (not the viewer's)."""
    if room.name:
        return room.name
    ids = [u for u in await rooms_core.member_ids(db, room) if u != viewer]
    names = (await db.execute(select(User.username).where(User.id.in_(ids)).order_by(User.username))).scalars().all() if ids else []
    return ", ".join(names)[:80] or "Group"


def _kind_word(call: Call) -> str:
    return "video call" if call.media == "video" else "call"


async def ring(
    db: AsyncSession,
    call: Call,
    room: Room,
    caller: User,
    targets: list[User],
    *,
    busy: set[uuid.UUID],
    parts: dict[uuid.UUID, CallParticipant],
) -> None:
    """Ring ``targets``: a push to each of their devices and an event to
    their open pages."""
    from app.notifications import actions

    group = room.kind == "group"
    url = f"/rooms/r/{room.id}?call={call.id}"
    icon = caller.avatar_url or ICON
    for t in targets:
        if await rings_quietly(db, t.id):
            # Quiet hours: no ring anywhere (it rings out to a missed call).
            continue
        conv = await conversation_name(db, room, t.id) if group else ""
        title = conv if group else caller.username
        body = f"{caller.username} is starting a {_kind_word(call)}" if group else f"Incoming {_kind_word(call)}"
        info = {
            "call_id": str(call.id),
            "room_id": str(room.id),
            "media": call.media or "audio",
            "group": group,
            "conversation": conv,
            "caller": rooms_core.user_out(caller),
            "ring_until": _ring_until(call, parts, t.id),
            "busy": t.id in busy,
        }
        extra = {
            "kind": "call_ring",
            **info,
            "icon": icon,
            "require_interaction": True,
            "answer_url": f"{url}&answer=1",
            "answer_token": actions.sign(t, "call_answer", str(call.id), ttl_s=ANSWER_TOKEN_TTL),
            "actions": [
                # No token: the worker opens the page to answer (media needs one).
                {"action": "call_answer", "title": "Answer", "token": ""},
                {"action": "call_decline", "title": "Decline", "token": actions.sign(t, "call_decline", str(call.id), ttl_s=ANSWER_TOKEN_TTL)},
            ],
        }
        await _notify(
            user_id=t.id,
            category="call",
            title=title[:120],
            body=body,
            url=url,
            tag=f"call:{call.id}",
            actor_user_id=caller.id,
            inbox=False,
            extra=extra,
            ttl=RING_TTL,
            urgency="high",
        )
        await rooms_core.publish([t.id], {"type": "call_ring", **info})


async def stop(user: User, call: Call, *, reason: str) -> None:
    """Stop the ringing on all of ``user``'s devices (they answered or
    declined on one of them)."""
    words = {"answered": "Answered on another device", "declined": "Declined"}
    await _notify(
        user_id=user.id,
        category="call",
        title="Promptly",
        body=words.get(reason, "Call ended"),
        url=f"/rooms/r/{call.room_id}",
        tag=f"call:{call.id}",
        inbox=False,
        extra={"kind": "call_stop", "call_id": str(call.id), "reason": reason, "silent": True},
        ttl=RING_TTL,
        urgency="high",
    )
    await rooms_core.publish([user.id], {"type": "call_ring_stop", "call_id": str(call.id), "reason": reason})


async def missed(db: AsyncSession, call: Call, room: Room, user_ids: list[uuid.UUID]) -> None:
    """A missed call: replaces the ring on their devices with "Missed call"."""
    if not user_ids:
        return
    caller = await db.get(User, call.started_by) if call.started_by else None
    who = caller.username if caller is not None else "Someone"
    group = room.kind == "group"
    title = "Missed video call" if call.media == "video" else "Missed call"
    for uid in user_ids:
        if group:
            body = f"{who} called {await conversation_name(db, room, uid)}"
        else:
            body = f"{who} tried to call you"
        push = {
            "user_id": uid,
            "category": "call",
            "title": title,
            "body": body,
            # The Calls tab's details for this call (call back, message,
            # every call with them), as Messenger's missed call opens it.
            "url": missed_url(call),
            "tag": f"call:{call.id}",
            "actor_user_id": call.started_by,
            "inbox": False,
            "extra": {
                "kind": "call_missed",
                "call_id": str(call.id),
                "room_id": str(room.id),
                "media": call.media or "audio",
                "caller": rooms_core.user_out(caller) if caller is not None else None,
                "icon": (caller.avatar_url if caller is not None else None) or ICON,
            },
            "ttl": MISSED_TTL,
        }
        if await rings_quietly(db, uid):
            await _hold_missed(db, push)
        else:
            await _notify(**push)
        await rooms_core.publish([uid], {"type": "call_ring_stop", "call_id": str(call.id), "reason": "missed"})
        # The Calls tab's badge on their open pages.
        from app.calls.dm import publish_missed

        await publish_missed(db, uid)


def missed_url(call: Call) -> str:
    """Where a missed call's notification opens: that call in the Calls tab."""
    return f"/rooms/calls/{call.id}"


async def _hold_missed(db: AsyncSession, push: dict) -> None:
    """A call missed during quiet hours: kept, and sent when they end (the
    ``call`` rule never lets dispatch hold a push, since a ring can't wait)."""
    from app.notifications import quiet
    from app.notifications.dispatch import PushPayload
    from app.notifications.models import PushPreferences

    prefs = await db.get(PushPreferences, push["user_id"])
    if prefs is None or not prefs.enabled or not prefs.call:
        return
    payload = PushPayload(title=push["title"], body=push["body"], url=push["url"], tag=push["tag"], category="call", extra=push["extra"])
    await quiet.hold(db, user_id=push["user_id"], category="call", payload=payload, actor_user_id=push["actor_user_id"], reason="quiet")
    await db.commit()


# ---------------------------------------------------------------- the line in the conversation


def length_words(seconds: int) -> str:
    """12 min, 45 sec, 1 h 5 min."""
    if seconds < 60:
        return f"{max(1, seconds)} sec"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h} h {m} min" if m else f"{h} h"


def line_text(call: Call, seconds: int) -> str:
    video = call.media == "video"
    if call.ended_reason == "completed" and call.answered_at is not None:
        return f"{'Video call' if video else 'Call'} · {length_words(seconds)}"
    return "Missed video call" if video else "Missed call"


async def post_line(db: AsyncSession, call: Call, room: Room, parts: dict[uuid.UUID, CallParticipant]) -> RoomMessage:
    """The call's line in the conversation, once it's over: "Call · 12 min"
    or "Missed call", with what each person's view needs in ``meta.call``
    (outcome, who started it, who joined). Read already by everyone who
    was in it; unread (so it shows) for anyone who missed it."""
    from app.calls.dm import duration
    from app.rooms import service as rooms_service

    seconds = duration(call)
    locked = await db.get(Room, room.id, with_for_update=True, populate_existing=True)
    seq = rooms_service.next_seq(locked)
    joined = [str(p.user_id) for p in parts.values() if p.first_joined_at is not None and p.user_id]
    meta = {
        "call": {
            "id": str(call.id),
            "media": call.media or "audio",
            "outcome": call.ended_reason,
            "seconds": seconds,
            "started_by": str(call.started_by) if call.started_by else None,
            "joined": joined,
            "missed": [str(p.user_id) for p in parts.values() if p.ring == "missed" and p.user_id],
            "declined": [str(p.user_id) for p in parts.values() if p.ring == "declined" and p.user_id],
        }
    }
    msg = RoomMessage(room_id=room.id, seq=seq, author_id=None, kind="system", body=line_text(call, seconds), meta=meta)
    db.add(msg)
    await db.flush()
    seen = {uuid.UUID(u) for u in joined}
    for m in (await db.execute(select(RoomMember).where(RoomMember.room_id == room.id))).scalars():
        if m.user_id in seen and m.last_read_seq < seq:
            m.last_read_seq = seq
        m.hidden = False
    await db.commit()
    await rooms_core.publish(await rooms_core.member_ids(db, room), {"type": "message", "message": await rooms_core.message_out(db, msg)})
    return msg
