"""``search_past_chats`` — what was said in earlier conversations.

Saved facts are only what somebody decided was worth keeping. Everything else you've
talked through is in your chats, and without this the model could only say it had no
idea. It's the same search as Ctrl+K: words and meaning together.

Whose chats: your own. Inside a workspace, only that workspace's chats, and outside one,
only chats outside them, so a project stays in its project, as its facts do. A temporary
chat is never searched, nor one you paused memory for, nor what was said in a chat while
it was paused: pausing promises that it doesn't leave there. The chat router
treats the result as outside content, because a past reply may repeat a web page.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.chat.models import Conversation, Message
from app.chat.tools.base import Tool, ToolContext, ToolResult

logger = logging.getLogger("promptly.tools.past_chats")

_SHOWN = 6
_FETCH = 30
_CHARS = 700
_NEIGHBOUR_CHARS = 350


def _day(value: Any, *, end: bool = False) -> datetime | None:
    try:
        day = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if day.tzinfo is None:
        day = day.replace(tzinfo=timezone.utc)
    if end and day.hour == 0 and day.minute == 0:
        day = day.replace(hour=23, minute=59, second=59)
    return day


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


class SearchPastChatsTool(Tool):
    name = "search_past_chats"
    category = "memory"
    description = (
        "Search the user's earlier conversations, by the words in them and by meaning. "
        "Saved memory only holds what was judged worth keeping; this finds everything "
        "else. Call it when they refer to something discussed before ('that recipe you "
        "gave me', 'what did we decide about…', 'like last time'), or before saying you "
        "don't remember something they say they told you. Read-only."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for: a topic or the words likely to have been used."},
            "after": {"type": "string", "description": "Optional. Only chats from this date on, YYYY-MM-DD."},
            "before": {"type": "string", "description": "Optional. Only chats up to this date, YYYY-MM-DD."},
        },
        "required": ["query"],
    }
    max_per_turn = 3
    timeout_seconds = 20.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        # Here because the search lives in the router, which imports these tools.
        from app.chat.router import search_conversations

        query = str(args.get("query") or "").strip()[:200]
        after = _day(args["after"]) if args.get("after") else None
        before = _day(args["before"], end=True) if args.get("before") else None
        if not query:
            return ToolResult(content="Say what to look for.", meta={"found": 0})

        current = await ctx.db.get(Conversation, ctx.conversation_id)
        workspace_id = current.workspace_id if current is not None else None
        hits = await search_conversations(q=query, limit=_FETCH, workspace_id=workspace_id, start=after, end=before, db=ctx.db, user=ctx.user)
        chats = {
            c.id: c
            for c in (await ctx.db.execute(select(Conversation).where(Conversation.id.in_({h.conversation_id for h in hits})))).scalars()
        } if hits else {}

        def allowed(chat_id: uuid.UUID) -> bool:
            chat = chats.get(chat_id)
            if chat is None or chat.id == ctx.conversation_id or chat.temporary_mode is not None or chat.memory_capture_paused:
                return False
            # A shared workspace's chats are readable there, and nowhere else.
            return workspace_id is not None or (chat.user_id == ctx.user.id and chat.workspace_id is None)

        def said_in_private(hit) -> bool:
            until = chats[hit.conversation_id].memory_private_until
            return until is not None and hit.created_at <= until

        shown, seen = [], set()
        for hit in hits:
            if allowed(hit.conversation_id) and not said_in_private(hit) and hit.conversation_id not in seen:
                seen.add(hit.conversation_id)
                shown.append(hit)
            if len(shown) == _SHOWN:
                break
        if not shown:
            return ToolResult(
                content=f'No earlier chat matches "{query}". Say you can\'t find it rather than guessing.',
                meta={"query": query, "found": 0},
            )

        # A search by meaning always finds its nearest, however far away that is.
        lines = [f'Earlier chats closest to "{query}", best first. They may not be related: judge for yourself, and say so if none of them are.']
        for hit in shown:
            found = await ctx.db.get(Message, hit.message_id)
            if found is None:
                continue
            # The other half of the exchange, so a question comes with its answer.
            near = await ctx.db.scalar(
                select(Message).where(
                    Message.conversation_id == found.conversation_id,
                    Message.created_at > found.created_at if found.role == "user" else Message.created_at < found.created_at,
                ).order_by(Message.created_at.asc() if found.role == "user" else Message.created_at.desc()).limit(1)
            )
            title = hit.conversation_title or "Untitled chat"
            lines.append(f"\n[{title}](/chat/{hit.conversation_id}) — {hit.created_at.strftime('%-d %b %Y')}")
            lines.append(f"{found.role}: {_clip(found.content or '', _CHARS)}")
            if near is not None and (near.content or "").strip():
                lines.append(f"{near.role}: {_clip(near.content, _NEIGHBOUR_CHARS)}")
        return ToolResult(content="\n".join(lines), meta={"query": query, "found": len(shown)})
