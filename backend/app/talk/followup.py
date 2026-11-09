"""What a Talk conversation can send to your phone (Talk phase 2, WP-T11).

As tools return things with a link (an email you asked about, an event, a note,
a room, a place), the session keeps the last few here, newest first. The model
is told their headlines by number and ``send_to_phone``
(``chat/tools/talk_phone.py``) sends one; the model never writes a link.

**Cut short in the car** (owner decision 6): there, emails, places and other
people's messages are said as a one-sentence gist. When a car answer used one
of :data:`CUT`, the thing itself goes to your phone automatically, at most three
a conversation, and it says so the first time.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any
from urllib.parse import quote

logger = logging.getLogger("promptly.talk")

KEEP = 6
# In the car, these are said as a gist; the thing itself goes to the phone.
CUT = frozenset({"mail_read", "maps_search", "rooms_unread", "read_note"})
SAID_FIRST = "I've sent the details to your phone."


def _clean(text: Any, limit: int = 120) -> str:
    return " ".join(str(text or "").split())[:limit]


def link_of(name: str, meta: dict[str, Any]) -> dict[str, str] | None:
    """A thing with a link from a tool's result, or None. Only links the tool
    made, into this Promptly."""
    from app.chat.tools.talk_phone import safe_link

    card = meta.get("map_card")
    if isinstance(card, dict) and card.get("kind") == "places":
        places = card.get("places") or []
        first = places[0] if places and isinstance(places[0], dict) else None
        if first and isinstance(first.get("lat"), (int, float)) and isinstance(first.get("lon"), (int, float)):
            title = _clean(first.get("name") or card.get("title") or "A place")
            return {"title": f"{title} (in P Maps)", "url": f"/maps?to={first['lat']:.5f},{first['lon']:.5f},{quote(title[:60])}"}
        return None
    url = safe_link(meta.get("url"))
    if url is None or url in ("/mail", "/rooms", "/calendar"):
        return None
    title = _clean(meta.get("title") or meta.get("summary"))
    if name == "mail_read" and title.startswith("Read "):
        title = "Email: " + title[5:]
    elif name == "rooms_unread":
        title = "New messages in Rooms"
    return {"title": title or "Something from Talk", "url": url}


def remember(links: list[dict[str, str]], found: dict[str, str]) -> list[dict[str, str]]:
    return [found, *[x for x in links if x.get("url") != found.get("url")]][:KEEP]


def context_line(links: list[dict[str, str]] | None) -> str | None:
    if not links:
        return None
    listed = "; ".join(f"{i}. {_clean(x.get('title'), 100)}" for i, x in enumerate(links, 1))
    return (
        "If they ask you to send something to their phone, use send_to_phone with its number. From this conversation: "
        f"{listed}."
    )


async def auto_send(user_id: uuid.UUID, found: dict[str, str], sent: int) -> str | None:
    """Send a car answer's thing to the phone. Returns what to add out loud
    ("" to add nothing), or None when nothing was sent."""
    from app.chat.tools import talk_phone
    from app.database import SessionLocal

    if sent >= talk_phone.PER_SESSION:
        return None
    url = talk_phone.safe_link(found.get("url"))
    if url is None:
        return None
    try:
        async with SessionLocal() as db:
            if not await talk_phone.allowed(db, user_id):
                return None
        await talk_phone.send(user_id, found.get("title") or "Something from Talk", url)
    except Exception:  # noqa: BLE001 - the answer still stands
        logger.exception("talk: sending to the phone failed")
        return None
    return SAID_FIRST if sent == 0 else ""
