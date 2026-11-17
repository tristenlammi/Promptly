"""Approve instead of refuse (R-019, v0.34.0).

A chat turn that read outside content (a web page, an email, a file, a
workspace note someone else could have written) used to have its write tools
refuse with "ask the user to confirm in a new message". In a workspace with
content every turn is marked, so they'd refuse forever. Now the write is
**held**: :func:`app.chat.tools.base.guard_write` raises
:class:`~app.chat.tools.base.HoldForApproval`, and the chat dispatcher saves
the call on the reply as a pending approval — the same shape Talk's spoken
read-backs use (``meta.native``, ``meta.question``) — so it shows as a card
with exactly what would happen. A tap (or a spoken yes) runs it once, through
``chat/approvals.py::decide``, on a fresh turn marked ``user_approved``.
Nothing runs silently, and declining leaves it alone.

Only the tools listed in :data:`HOLDABLE` can be run by a yes; a held call
for anything else stays a refusal.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from app.auth.models import User

# Tools whose untrusted-turn guard holds for a yes, and the card's title.
HOLDABLE: dict[str, str] = {
    "calendar_add_event": "Add to your calendar",
    "calendar_change_event": "Change your calendar",
    "use_item": "Change an app file",
    "post_to_room": "Send a message in Rooms",
    "remember": "Save to memory",
    "create_note": "Make a note",
    "add_to_note": "Add to a note",
    "tick_note_items": "Tick off a list",
    "draft_form": "Make a draft form",
    "home_control": "Change something at home",
    "home_music": "Play music at home",
    "home_automation": "Run a home automation",
    # Reads of something private that a page could be fishing for: the yes
    # shows the result on the card.
    "timeline_day": "Look at your timeline",
    "timeline_visits": "Look at your timeline",
    # Outbound (security review H2): what a page could use to send your
    # data somewhere.
    "fetch_url": "Open a web page",
}
# Of those, the ones whose result is the point: shown on the card after a yes.
SHOWS_RESULT = frozenset({"timeline_day", "timeline_visits", "fetch_url"})
RESULT_CHARS = 3_000

WHY = (
    "This chat read something from outside (a web page, an email, a file or a workspace note), "
    "so Promptly checks with you first."
)
# Opening a page: say what the worry actually is.
WHY_OPEN = (
    "Promptly made this address itself after reading a web page, an email or a file. "
    "It checks with you first, so nothing you've told it can be sent to a site without you seeing."
)


def holdable(name: str) -> bool:
    return name in HOLDABLE


# ------------------------------------------------- waiting for the answer
# A held look (a page to open, the timeline) is something the reply needs in
# order to answer. In a typed chat whose page is listening for it, the reply
# stops at the card and waits: a yes runs the call and the model carries on
# with what it found, a no tells the model so. If nobody answers in time (or
# the reply is stopped, or the server goes down) it falls back to the card on
# the saved reply, decided through ``approvals.py`` as before.
#
# The reply isn't saved while it's being written, so there is no message to
# decide yet: the answer comes in by conversation and call id
# (``approvals_router.answer_waiting_call``) and wakes the waiting dispatcher.
# In-process, like the stream itself (one uvicorn worker).
PAUSE_SECONDS = 150
# A second card shown late in the same step still gets this long.
PAUSE_MIN_SECONDS = 45

DECLINED_NOTE = (
    "The user was asked and said no, so this was not opened. Don't try it again or ask again in this reply. "
    "Answer with what you already have, and say in a few words what you couldn't check."
)

_WAITING: dict[tuple[str, str], asyncio.Future[bool]] = {}


def pausable(name: str) -> bool:
    return name in SHOWS_RESULT


def open_wait(conversation_id: Any, call_id: str) -> asyncio.Future[bool]:
    fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    _WAITING[(str(conversation_id), call_id)] = fut
    return fut


def close_wait(conversation_id: Any, call_id: str) -> None:
    _WAITING.pop((str(conversation_id), call_id), None)


def answer(conversation_id: Any, call_id: str, approve: bool) -> bool:
    """The person's tap. False when nothing is waiting on it any more (it
    timed out, or was already answered): the first answer is the only one."""
    fut = _WAITING.pop((str(conversation_id), call_id), None)
    if fut is None or fut.done():
        return False
    fut.set_result(bool(approve))
    return True


def _t(value: Any, limit: int = 80) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def _items(value: Any, limit: int = 160) -> str:
    if not isinstance(value, list):
        return ""
    words = [str(x).strip() for x in value if str(x).strip()]
    return ", ".join(words)[:limit]


def question(name: str, args: dict[str, Any]) -> str:
    """What the card asks, from the call's real arguments."""
    if name == "post_to_room":
        to = str(args.get("to") or "").strip().lstrip("@")
        where = f"@{to}" if to else (_t(args.get("room"), 60) or "the room")
        return f"Send {where} this message: “{str(args.get('message') or '').strip()[:300]}”?"
    if name == "create_note":
        title = _t(args.get("title"), 80)
        items = args.get("items") if isinstance(args.get("items"), list) else []
        if items:
            n = len([x for x in items if str(x).strip()])
            return f"Make a list{f' “{title}”' if title else ''} with {n} item{'' if n == 1 else 's'}: {_items(items)}?"
        first = next((ln.strip() for ln in str(args.get("text") or "").splitlines() if ln.strip()), "")
        return f"Make a note “{title or first[:80] or 'Untitled'}”?"
    if name == "add_to_note":
        return f"Add {_items(args.get('items')) or 'these'} to {_t(args.get('note'), 60) or 'the note'}?"
    if name == "tick_note_items":
        verb = "Untick" if args.get("checked") is False else "Tick off"
        return f"{verb} {_items(args.get('items')) or 'those items'} in {_t(args.get('note'), 60) or 'the list'}?"
    if name == "draft_form":
        qs = args.get("questions") if isinstance(args.get("questions"), list) else []
        return f"Make a draft form “{_t(args.get('title'), 80)}” with {len(qs)} question{'' if len(qs) == 1 else 's'}?"
    if name == "home_control":
        doing = str(args.get("action") or "").replace("_", " ")
        extra = "".join(
            f", {k} {_t(args.get(k), 20)}" for k in ("brightness", "colour", "volume", "preset") if args.get(k) not in (None, "")
        )
        return f"At home: {doing} {_t(args.get('target'), 60) or 'the speaker'}{extra}?"
    if name == "home_automation":
        return f"At home: run “{_t(args.get('name'), 80)}”?"
    if name == "home_music":
        where = _t(args.get('target'), 60)
        what = _t(args.get('query'), 80) or ('some music' if args.get('mix') is True else 'that')
        return f"At home: play {what}{f' on {where}' if where else ''}?"
    if name == "timeline_day":
        end = str(args.get("end_date") or "").strip()
        return f"Look at your timeline for {_t(args.get('date'), 20)}{f' to {end[:10]}' if end else ''}?"
    if name == "timeline_visits":
        return f"Look up when you were at {_t(args.get('place'), 80)}?"
    if name == "fetch_url":
        url = str(args.get("url") or "").strip()
        try:
            from urllib.parse import urlsplit

            site = (urlsplit(url).hostname or "").removeprefix("www.") or "a website"
        except ValueError:
            site = "a website"
        return f"Open {site}?\n{url[:300]}"
    from app.talk.readback import question as read_back_question

    return read_back_question(name, args)


async def ask(db, user: User, name: str, args: dict[str, Any]) -> tuple[str, str | None]:  # noqa: ANN001
    """``(question, problem)``. A problem means don't ask: it can't be done,
    and the model is told why instead (Talk's read-back checks: the file has
    no such action, the event wasn't found)."""
    if name in ("use_item", "calendar_change_event", "calendar_add_event", "remember"):
        from app.talk.readback import read_back

        return await read_back(db, user, name, args)
    return question(name, args), None


def meta_for(name: str, args: dict[str, Any], asked: str, *, spoken: bool) -> dict[str, Any]:
    """The pending approval saved on the reply's ``tool_calls`` entry."""
    now = datetime.now(timezone.utc)
    meta: dict[str, Any] = {
        "approval": "pending",
        "native": True,
        "held": "outside_content",
        "why": WHY_OPEN if name == "fetch_url" else WHY,
        "tool": name,
        "title": HOLDABLE.get(name, name.replace("_", " ")),
        "question": asked,
        "arguments": args,
        "asked_at": now.isoformat(),
    }
    if spoken:
        # Asked out loud in Talk: the same clock as its own read-backs.
        from datetime import timedelta

        from app.talk.confirm import ASK_TTL_S

        meta["spoken"] = True
        meta["expires_at"] = (now + timedelta(seconds=ASK_TTL_S + 25)).isoformat()
    return meta


def note_for_model(asked: str) -> str:
    """What the model is told instead of the tool's result."""
    return (
        "Not done yet. This turn read outside content, so the user has been shown an approval card asking: "
        f"\"{asked}\" It happens only if they approve it. In one short sentence, say what will happen if they "
        "do. Don't say it's done, and don't ask them to send another message."
    )
