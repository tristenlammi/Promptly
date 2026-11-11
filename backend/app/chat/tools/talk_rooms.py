"""``rooms_unread``: "any messages?" by voice (Talk phase 2, WP-T10).

Who has written and how many, from the same unread counts as the Rooms badge
and Today (muted rooms and hidden DMs left out). For the latest message in a
room, only where Rooms already lets Promptly read it (a room admin's "Promptly
can read this room", or everyone in a DM saying yes): its author and the start
of its text, for a one-line gist. Elsewhere it says the messages are private.

Other people's words, so it's outside content
(``base.UNTRUSTED_CONTENT_TOOLS``): a change on the same turn is read back and
waits for a yes, like after reading an email.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.chat.tools.base import Tool, ToolContext, ToolResult

LATEST_CHARS = 240
WITH_TEXT = 3


class RoomsUnreadTool(Tool):
    name = "rooms_unread"
    category = "rooms"
    max_per_turn = 2
    timeout_seconds = 15.0
    description = (
        "New messages in Rooms (the family and team chat): who has written and how many, with the latest message "
        "where Promptly is allowed to read that room. For 'any messages?', 'did Sam reply?'."
    )
    parameters: dict[str, Any] = {"type": "object", "properties": {}}

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.auth.models import User
        from app.rooms.models import Room, RoomMessage
        from app.rooms.promptly import can_read_history
        from app.today.core import rooms_unread

        found = await rooms_unread(ctx.db, ctx.user, limit=6)
        if not found or not found.get("total"):
            return ToolResult(content="No new messages in Rooms.", meta={"url": "/rooms", "count": 0})
        lines = [f"{found['total']} new message{'s' if found['total'] != 1 else ''} in Rooms:"]
        for i, row in enumerate(found["rooms"]):
            where = f"from {row['name']}" if row["dm"] else f"in #{row['name']}" + (f" ({row['where']})" if row["where"] else "")
            line = f"- {row['unread']} {where}"
            if i < WITH_TEXT:
                room = await ctx.db.get(Room, uuid.UUID(row["id"]))
                if room is not None and await can_read_history(ctx.db, room):
                    last = (
                        await ctx.db.execute(
                            select(RoomMessage)
                            .where(RoomMessage.room_id == room.id, RoomMessage.deleted_at.is_(None), RoomMessage.kind != "system")
                            .order_by(RoomMessage.seq.desc())
                            .limit(1)
                        )
                    ).scalar_one_or_none()
                    if last is not None and (last.body or "").strip():
                        who = "Promptly" if last.kind == "promptly" else "someone"
                        if last.author_id:
                            author = await ctx.db.get(User, last.author_id)
                            who = "you" if last.author_id == ctx.user.id else (author.username if author else who)
                        line += f"; the latest, from {who}: {' '.join(last.body.split())[:LATEST_CHARS]}"
                elif room is not None:
                    line += "; its messages are private to its members"
            lines.append(line)
        return ToolResult(content="\n".join(lines), meta={"url": "/rooms", "count": int(found["total"])})


TALK_ROOMS_TOOLS: list[Tool] = [RoomsUnreadTool()]
