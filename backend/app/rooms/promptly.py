"""``@promptly`` — the only AI in Rooms.

A message that mentions it gets an answer posted in the room (kind
``promptly``, a reply to the ask), made with the *asking* person's model.

What it sees, and nothing else:
* the asking message, and the message it replies to; or
* in an **AI-context room** (a room admin's switch, shown to everyone) or a
  DM where **every** member has switched it on: that room's recent
  history.

No tools: it can't reach anyone's files, photos, memories or other rooms.
"""
from __future__ import annotations

from app.net.send_links import strip_send_keys

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.database import SessionLocal

from . import core
from .models import Room, RoomMember, RoomMessage, RoomSpace

logger = logging.getLogger("promptly.rooms.promptly")

HISTORY = 40
MAX_CHARS = 24_000


async def model_for(db, user):  # noqa: ANN001, ANN201
    """The asker's provider + model, the way their chats pick one: their
    default, else the admin's, else the model they last chatted with,
    else the first chat model they can use."""
    from app.app_settings.defaults import load_effective_defaults
    from app.chat.models import Conversation
    from app.files.editor_ai import resolve_model
    from app.models_config.router import list_available_models_for

    s = user.settings or {}
    pid, mid = s.get("default_provider_id"), s.get("default_model_id")
    if not (pid and mid):
        eff = await load_effective_defaults(db)
        pid, mid = eff.default_chat_provider_id, eff.default_chat_model_id
    available = [m for m in await list_available_models_for(user, db) if not m.supports_image_output]
    usable = {(str(m.provider_id), m.model_id) for m in available}
    if not (pid and mid) or (str(pid), str(mid)) not in usable:
        last = (
            await db.execute(
                select(Conversation.provider_id, Conversation.model_id)
                .where(Conversation.user_id == user.id, Conversation.model_id.is_not(None))
                .order_by(Conversation.updated_at.desc())
                .limit(1)
            )
        ).first()
        if last and (str(last[0]), str(last[1])) in usable:
            pid, mid = last
        elif available:
            pid, mid = available[0].provider_id, available[0].model_id
        else:
            raise LookupError("no model")
    return await resolve_model(db, user, uuid.UUID(str(pid)), str(mid))


async def can_read_history(db, room: Room) -> bool:  # noqa: ANN001
    if room.space_id is not None:
        return room.ai_context
    members = (await db.execute(select(RoomMember).where(RoomMember.room_id == room.id))).scalars().all()
    return core.dm_ai_context(list(members))


async def build(db, room: Room, ask: RoomMessage, asker) -> tuple[str, list[dict]]:  # noqa: ANN001
    """The system prompt and messages @promptly is given."""
    from app.auth.models import User
    from app.items.service import zone_for

    space = await db.get(RoomSpace, room.space_id) if room.space_id else None
    where = (f"the voice channel {room.name}’s text chat" if room.kind == "voice" else f"the room #{room.name}") + f" in the space “{space.name}”" if space else ("a direct message" if room.kind == "dm" else "a group conversation")
    history = await can_read_history(db, room)
    if history:
        rows = list(
            (
                await db.execute(
                    select(RoomMessage)
                    .where(RoomMessage.room_id == room.id, RoomMessage.seq <= ask.seq, RoomMessage.deleted_at.is_(None))
                    .order_by(RoomMessage.seq.desc())
                    .limit(HISTORY)
                )
            ).scalars()
        )[::-1]
    else:
        rows = [ask]
        if ask.reply_to_id:
            parent = await db.get(RoomMessage, ask.reply_to_id)
            if parent is not None and parent.deleted_at is None and parent.room_id == room.id:
                rows.insert(0, parent)
    names = {
        u.id: u.username
        for u in (await db.execute(select(User).where(User.id.in_({r.author_id for r in rows if r.author_id})))).scalars()
    }
    lines: list[str] = []
    for r in rows:
        who = "Promptly" if r.kind == "promptly" else names.get(r.author_id, "someone")
        lines.append(f"{who}: {strip_send_keys(r.body)}")
    transcript = "\n".join(lines)[-MAX_CHARS:]
    now = datetime.now(timezone.utc).astimezone(zone_for(asker))
    seen = (
        "You can see this conversation's recent messages (below)."
        if history
        else "You can only see the message that mentions you (and the one it replies to). "
        "If asked about earlier messages, say you can't see them unless "
        + ("a room admin turns on “Promptly can read this room”." if space else "everyone here turns on “Promptly can read this conversation”.")
    )
    system = (
        f"You are Promptly, a helpful assistant people can @-mention in a group chat. You're in {where}. "
        f"{asker.username} just asked you something. It is {now.strftime('%A %d %B %Y, %H:%M')} ({now.tzname()}).\n"
        f"{seen}\n"
        "You can't see anyone's files, photos, notes, memories or other rooms, and you can't take actions. "
        "Reply like a person in a chat: short and direct (a few sentences; bullet points or Markdown only when they help). "
        "Don't start with a greeting or restate the question."
    )
    messages = [{"role": "user", "content": f"Conversation:\n{transcript}\n\nAnswer {asker.username}'s last message."}]
    return system, messages


async def answer(ask_id: uuid.UUID) -> uuid.UUID | None:
    """Run in the background after an @promptly message commits. Returns
    the reply's id."""
    from app.auth.models import User
    from app.files.editor_ai import complete

    async with SessionLocal() as db:
        ask = await db.get(RoomMessage, ask_id)
        if ask is None or ask.author_id is None:
            return None
        room = await db.get(Room, ask.room_id)
        asker = await db.get(User, ask.author_id)
        if room is None or asker is None:
            return None
        members = await core.member_ids(db, room)
        await core.publish(members, {"type": "promptly_thinking", "room_id": str(room.id), "on": True})
        try:
            try:
                provider, model_id = await model_for(db, asker)
            except LookupError:
                text = f"@{asker.username} I can't answer yet — no AI model is set up for you. Pick a default model in Promptly's settings."
            except Exception as e:  # noqa: BLE001 — resolve_model raises HTTPException
                detail = getattr(e, "detail", None) or "your model isn't available"
                text = f"@{asker.username} I couldn't answer: {detail}"
            else:
                system, messages = await build(db, room, ask, asker)
                try:
                    text = await complete(provider, model_id, system=system, messages=messages, max_tokens=1200, temperature=0.4, timeout=90.0)
                except Exception as e:  # noqa: BLE001
                    logger.info("@promptly failed in %s: %s", room.id, e)
                    text = f"@{asker.username} Sorry — the model didn't answer ({getattr(e, 'detail', 'error')})."
                text = (text or "").strip() or "…"
            reply = await post(db, room, text[: core.MAX_BODY], reply_to=ask, asked_by=asker.id)
            return reply.id
        finally:
            await core.publish(members, {"type": "promptly_thinking", "room_id": str(room.id), "on": False})


async def post(db, room: Room, body: str, *, reply_to: RoomMessage, asked_by: uuid.UUID) -> RoomMessage:  # noqa: ANN001
    """Post Promptly's message (its own seq), publish it and push it."""
    from app.background import spawn

    from .push import fan_out
    from .service import next_seq

    locked = await db.get(Room, room.id, with_for_update=True)
    seq = next_seq(locked)
    msg = RoomMessage(
        room_id=room.id,
        seq=seq,
        author_id=None,
        kind="promptly",
        body=body,
        reply_to_id=reply_to.id,
        mentions=[],
        meta={"asked_by": str(asked_by)},
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    out = await core.message_out(db, msg)
    await core.publish(await core.member_ids(db, room), {"type": "message", "message": out})
    spawn(fan_out(msg.id), name=f"rooms-push-{msg.id}")
    return msg
