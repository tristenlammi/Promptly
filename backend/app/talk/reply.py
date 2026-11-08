"""Talk's way into the chat pipeline (WP-T2).

A spoken turn is a chat turn: the user's words are saved as a message, the
reply comes from the same generator a typed send runs (``chat/router.py``,
``voice=True``: the voice prompt, the admin's voice model, the token cap), and
Talk follows its :class:`StreamSession` instead of an SSE response. So the
reply lands in the chat, typed and spoken turns share one history, and
whatever the generator does (memory rules, temporary chats, usage, the
shutdown flush) holds for voice too.

Every function opens its own short DB session: nothing holds a connection
for the life of a conversation (the 2026-11-03 pool crash).

**Where conversations live.** On the web, Talk continues the chat it was
opened in, or starts a new one (temporary when the person chose that in
Account → Voice). On the phone the owner decided conversations are **not
saved**: Talk keeps one hidden throwaway chat (``temporary_mode
="ephemeral"``, never listed, never in memory or search) for the length of the
conversation, because the reply, tool and approval machinery all work on chat
rows, and deletes it the moment the conversation ends. If the server dies
first, the temporary-chat sweeper removes it within the hour.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select

from app.auth.models import User
from app.chat.models import Conversation, Message
from app.database import SessionLocal

logger = logging.getLogger("promptly.talk")

# A phone conversation's throwaway chat, if the server dies before deleting it.
EPHEMERAL_TTL = timedelta(hours=1)
PHONE_TITLE = "Spoken conversation"
NO_MODEL = "No AI model is set up yet. An admin can add one in Admin, Models."


class TurnRefused(Exception):
    """A turn that can't go ahead; ``say`` is the reason, in words."""

    def __init__(self, say: str) -> None:
        super().__init__(say)
        self.say = say


@dataclass
class ConvInfo:
    id: uuid.UUID
    ephemeral: bool
    title: str | None


async def pick_model(db, user: User) -> tuple[uuid.UUID, str] | None:
    """The model a new spoken chat is set to: yours, then the server's, then
    whatever you've used lately (``maps/assistant.py`` uses the same order).
    Voice turns then swap in the admin's voice model, if one is set."""
    from app.app_settings.defaults import load_effective_defaults
    from app.files.editor_ai import resolve_model

    defaults = await load_effective_defaults(db)
    mine = user.settings or {}
    try:
        my_provider = uuid.UUID(str(mine.get("default_provider_id"))) if mine.get("default_provider_id") else None
    except ValueError:
        my_provider = None
    candidates: list[tuple[Any, Any]] = [
        (my_provider, mine.get("default_model_id")),
        (defaults.default_chat_provider_id, defaults.default_chat_model_id),
        (defaults.voice_provider_id, defaults.voice_model_id),
    ]
    recent = await db.execute(
        select(Conversation.provider_id, Conversation.model_id)
        .where(
            Conversation.user_id == user.id,
            Conversation.provider_id.is_not(None),
            Conversation.model_id.is_not(None),
        )
        .order_by(Conversation.updated_at.desc())
        .limit(10)
    )
    candidates.extend(dict.fromkeys(recent.all()))
    for provider_id, model_id in candidates:
        if not provider_id or not model_id:
            continue
        try:
            await resolve_model(db, user, provider_id, model_id)
        except HTTPException:
            continue
        return provider_id, model_id
    return None


async def open_conversation(
    user: User, *, conversation_id: uuid.UUID | None, phone: bool, temporary: bool
) -> ConvInfo:
    """The chat this conversation talks in. Someone else's chat, or one that
    doesn't exist, raises ``LookupError`` (the socket closes 4404)."""
    async with SessionLocal() as db:
        if conversation_id is not None and not phone:
            conv = await db.get(Conversation, conversation_id)
            now = datetime.now(timezone.utc)
            if (
                conv is None
                or conv.user_id != user.id
                or (conv.expires_at is not None and conv.expires_at <= now)
            ):
                raise LookupError("conversation")
            return ConvInfo(conv.id, False, conv.title)
        picked = await pick_model(db, user)
        if picked is None:
            raise TurnRefused(NO_MODEL)
        now = datetime.now(timezone.utc)
        conv = Conversation(user_id=user.id, provider_id=picked[0], model_id=picked[1])
        if phone:
            conv.temporary_mode = "ephemeral"
            conv.expires_at = now + EPHEMERAL_TTL
            conv.memory_capture_paused = True
            # A title the titler won't spend a model call replacing.
            conv.title = PHONE_TITLE
            conv.title_manually_set = True
        elif temporary:
            conv.temporary_mode = "one_hour"
            conv.expires_at = now + timedelta(hours=1)
        db.add(conv)
        await db.commit()
        return ConvInfo(conv.id, phone, conv.title)


async def check_quotas(connection: Any, user: User) -> None:
    """The per-user send rate and the budget, like a typed send."""
    from app.chat.router import enforce_send_quotas

    async with SessionLocal() as db:
        try:
            await enforce_send_quotas(connection, user, db)
        except HTTPException as e:
            raise TurnRefused(str(e.detail)) from None


async def add_user_turn(conv: ConvInfo, user: User, text: str, voice: dict[str, Any] | None) -> uuid.UUID:
    """Save what was said as the user's message, at the end of the chat."""
    from app.chat.titler import fallback_title

    async with SessionLocal() as db:
        row = await db.get(Conversation, conv.id)
        if row is None:
            raise TurnRefused("This chat was deleted.")
        if row.provider_id is None or not row.model_id:
            picked = await pick_model(db, user)
            if picked is None:
                raise TurnRefused(NO_MODEL)
            row.provider_id, row.model_id = picked
        msg = Message(
            conversation_id=row.id,
            role="user",
            content=text,
            parent_id=row.active_leaf_message_id,
            author_user_id=user.id,
            voice=voice,
        )
        db.add(msg)
        await db.flush()
        row.active_leaf_message_id = msg.id
        if not row.title and not row.title_manually_set:
            row.title = fallback_title(text)
            conv.title = row.title
        now = datetime.now(timezone.utc)
        row.updated_at = now
        if row.temporary_mode == "one_hour":
            row.expires_at = now + timedelta(hours=1)
        elif row.temporary_mode == "ephemeral" and conv.ephemeral:
            row.expires_at = now + EPHEMERAL_TTL
        if not conv.ephemeral:
            from app.links.service import sync_text

            await sync_text(db, "chat_msg", msg.id, text, user_id=user.id)
        await db.commit()
        return msg.id


async def extend_user_turn(conv: ConvInfo, user: User, message_id: uuid.UUID, text: str, voice: dict[str, Any] | None) -> None:
    """They carried on after a pause: the turn they started now says all of it."""
    from app.chat.titler import fallback_title

    async with SessionLocal() as db:
        msg = await db.get(Message, message_id)
        if msg is None or msg.conversation_id != conv.id:
            return
        old = msg.content
        msg.content = text
        msg.voice = voice
        row = await db.get(Conversation, conv.id)
        if row is not None and not row.title_manually_set and row.title == fallback_title(old):
            row.title = fallback_title(text)
            conv.title = row.title
        if not conv.ephemeral:
            from app.links.service import sync_text

            await sync_text(db, "chat_msg", msg.id, text, user_id=user.id)
        await db.commit()


async def start_reply(conv: ConvInfo, user: User, user_message_id: uuid.UUID, connection: Any):
    """Start the chat generator on this turn; returns its StreamSession."""
    from app.chat.router import start_spoken_reply
    from app.chat.service import enqueue_stream

    async with SessionLocal() as db:
        row = await db.get(Conversation, conv.id)
        if row is None:
            raise TurnRefused("This chat was deleted.")
        provider_id, model_id = row.provider_id, row.model_id
        reasoning = row.reasoning_effort
    if provider_id is None or not model_id:
        raise TurnRefused(NO_MODEL)
    stream_id = uuid.uuid4()
    await enqueue_stream(
        stream_id,
        {
            "conversation_id": str(conv.id),
            "user_message_id": str(user_message_id),
            "provider_id": str(provider_id),
            "model_id": model_id,
            # Voice turns skip search and tools in the generator for now;
            # WP-T3 brings back a voice allowlist with a spoken yes for writes.
            "web_search_mode": "off",
            "temperature": 0.7,
            "max_tokens": None,
            "tools_enabled": False,
            "voice": True,
            "reasoning_effort": reasoning,
        },
    )
    return await start_spoken_reply(stream_id, conv.id, user, connection)


def parse_event(chunk: str) -> dict[str, Any] | None:
    """One StreamSession chunk (``data: {...}``) as a dict; None for pings."""
    if not chunk.startswith("data: "):
        return None
    try:
        payload = json.loads(chunk[6:].strip())
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


async def discard(session, conv: ConvInfo, user_message_id: uuid.UUID) -> None:
    """Throw a reply away unheard (they carried on talking): stop the run
    without keeping anything, and take back a reply it had already saved."""
    if session is not None and not session.done:
        session.flushed = True  # neither the generator nor Stop saves it now
        session.push('data: {"done": true}\n\n')
        session.finish()
        task = session.task
        if task is not None and not task.done():
            task.cancel()
            # Let a save already under way land first, so it's deleted below
            # rather than appearing after.
            await asyncio.wait({task}, timeout=3)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv.id,
                    Message.parent_id == user_message_id,
                    Message.role == "assistant",
                )
            )
        ).scalars().all()
        for row in rows:
            await db.delete(row)
        conv_row = await db.get(Conversation, conv.id)
        if conv_row is not None:
            conv_row.active_leaf_message_id = user_message_id
        await db.commit()


async def stop(session) -> uuid.UUID | None:
    """Stop a reply still being written and keep what it wrote (the caller
    then cuts it back to what was heard). Returns the saved message's id."""
    from app.chat.stream_runner import stop_session

    saved = await stop_session(session, done_event='data: {"done": true}\n\n')
    if not saved:
        return None
    async with SessionLocal() as db:
        conv_row = await db.get(Conversation, session.conversation_id)
        if conv_row is None or conv_row.active_leaf_message_id is None:
            return None
        msg = await db.get(Message, conv_row.active_leaf_message_id)
        return msg.id if msg is not None and msg.role == "assistant" else None


async def mark_reply(message_id: uuid.UUID, *, content: str | None = None, voice: dict[str, Any]) -> None:
    """Mark a reply as spoken; with ``content``, cut it back to what was heard."""
    async with SessionLocal() as db:
        msg = await db.get(Message, message_id)
        if msg is None or msg.role != "assistant":
            return
        if content is not None:
            msg.content = content
        msg.voice = voice
        await db.commit()


async def latest_reply_for(conv: ConvInfo, user_message_id: uuid.UUID) -> uuid.UUID | None:
    async with SessionLocal() as db:
        return await db.scalar(
            select(Message.id)
            .where(
                Message.conversation_id == conv.id,
                Message.parent_id == user_message_id,
                Message.role == "assistant",
            )
            .order_by(Message.created_at.desc())
            .limit(1)
        )


async def forget_conversation(conv: ConvInfo) -> None:
    """A phone conversation is over: nothing of it stays."""
    from app.links.service import purge_sources

    async with SessionLocal() as db:
        row = await db.get(Conversation, conv.id)
        if row is None:
            return
        ids = (await db.execute(select(Message.id).where(Message.conversation_id == row.id))).scalars().all()
        await purge_sources(db, "chat_msg", ids)
        await db.delete(row)
        await db.commit()
    logger.info("talk: phone conversation removed (%d messages)", len(ids))
