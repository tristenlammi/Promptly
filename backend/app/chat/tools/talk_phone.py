"""``send_to_phone``: "send that to my phone" (Talk phase 2, WP-T11).

One push to your devices, category ``talk_followup``:

* the title is always "From Talk";
* the body is the thing's own one-line headline (an email's subject, a place's
  name), as the tool that found it said it;
* the link is the thing itself, and **only** something a tool returned this
  conversation (an email, an event, a note, a room, a place in P Maps). The
  model picks one by number from the list it's given; it can't write a link or
  a title, so a web page or an email can't use your own phone to phish you.

The push is the record (and its inbox row): nothing else is kept, matching
"phone conversations aren't kept". Quiet hours don't hold it (you asked a
moment ago) and it isn't in the daily summary. With the switch in Account ->
Notifications off, nothing is sent. At most :data:`PER_SESSION` a conversation.
"""
from __future__ import annotations

import uuid
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

TITLE = "From Talk"
PER_SESSION = 3
FIRST = "I've sent it to your phone."
AGAIN = "Sent to your phone."
TURNED_OFF = "Sending things to your phone is turned off in Account, Notifications."
NOTHING = "There's nothing from this conversation I can send to your phone."
ENOUGH = "I've already sent three things to your phone this time."


def safe_link(url: Any) -> str | None:
    """A link into this Promptly only: a path, never a full address."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url.startswith("/") or url.startswith("//") or "\\" in url or len(url) > 500:
        return None
    return url


async def allowed(db, user_id: uuid.UUID) -> bool:  # noqa: ANN001
    """The person's own switch (and the master switch) say yes."""
    from app.notifications.models import PushPreferences

    prefs = await db.get(PushPreferences, user_id)
    return prefs is None or (bool(prefs.enabled) and bool(getattr(prefs, "talk_followup", True)))


async def send(user_id: uuid.UUID, title: str, url: str) -> None:
    from app.notifications.dispatch import notify_user

    await notify_user(user_id=user_id, category="talk_followup", title=TITLE, body=" ".join(title.split())[:200], url=url, tag=f"talk-{url[:60]}")


class SendToPhoneTool(Tool):
    name = "send_to_phone"
    category = "talk"
    max_per_turn = 1
    timeout_seconds = 10.0
    description = (
        "Send something from this conversation to their phone as a notification they can open later: an email, an event, "
        "a note, a room or a place. Pick it by its number in the list you were given (1 is the latest)."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"item": {"type": "integer", "description": "Its number in the list (1 = the latest)."}},
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        talk = (ctx.turn or {}).get("talk") or {}
        links = [x for x in talk.get("links") or [] if isinstance(x, dict) and safe_link(x.get("url"))]
        if not links:
            return ToolResult(content=NOTHING, meta={"spoken": NOTHING})
        sent = int(talk.get("sent") or 0)
        if sent >= PER_SESSION:
            return ToolResult(content=ENOUGH, meta={"spoken": ENOUGH})
        if not await allowed(ctx.db, ctx.user.id):
            return ToolResult(content=TURNED_OFF, meta={"spoken": TURNED_OFF})
        n = args.get("item", 1)
        if isinstance(n, bool) or not isinstance(n, int):
            n = 1
        if not 1 <= n <= len(links):
            raise ToolError(f"Pick a number from 1 to {len(links)}.")
        pick = links[n - 1]
        url = safe_link(pick.get("url"))
        if url is None:
            raise ToolError("That can't be sent.")
        await send(ctx.user.id, str(pick.get("title") or "Something from Talk"), url)
        said = FIRST if sent == 0 else AGAIN
        return ToolResult(content=said, meta={"spoken": said, "followup": {"url": url}})


TALK_PHONE_TOOLS: list[Tool] = [SendToPhoneTool()]
