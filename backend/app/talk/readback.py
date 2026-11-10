"""What would actually be done, said back before it's done (WP-T3).

A change waits for a yes, and the question is built **from the arguments the
tool would run with**, never from the model's wording: a model talked into
something by an email can't make "delete everything" sound like "add milk".
Where the arguments point at something (an email, an event, an item file),
the question names it from the database, the way it really is.

Moved here from ``maps/assistant.py`` (``_question`` and friends), which the
phone's ``/api/assistant`` still uses.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from app.auth.models import User


def text(value: Any, limit: int = 80) -> str:
    return " ".join(str(value).split())[:limit]


def spoken_time(value: Any) -> str:
    """"2026-11-05T09:00" -> "Thursday 5 November at 9 AM"."""
    raw = str(value)[:80]
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        return raw
    day = f"{at:%A} {at.day} {at:%B}"
    if "T" not in raw:
        return day
    clock = f"{at.hour % 12 or 12}" + (f":{at.minute:02d}" if at.minute else "")
    return f"{day} at {clock} {'AM' if at.hour < 12 else 'PM'}"


def spoken_length(seconds: int) -> str:
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    parts = [f"{n} {word}{'' if n == 1 else 's'}" for n, word in ((hours, "hour"), (minutes, "minute"), (secs, "second")) if n]
    return " and ".join(parts)


def clock_words(action: dict[str, Any]) -> str:
    """A timer or alarm, out loud: "a timer for 10 minutes called pasta"."""
    called = f" called {action['label']}" if action.get("label") else ""
    if action["type"] == "set_timer":
        return f"a timer for {spoken_length(action['seconds'])}{called}"
    hour, minute = action["hour"], action["minute"]
    at = f"{hour % 12 or 12}" + (f":{minute:02d}" if minute else "")
    return f"an alarm for {at} {'AM' if hour < 12 else 'PM'}{called}"


def words(value: Any) -> list[str]:
    """The values in a request, out loud: no brackets, ids or yes/no flags."""
    if isinstance(value, dict):
        return [w for v in value.values() for w in words(v)]
    if isinstance(value, list):
        return [w for v in value for w in words(v)]
    if isinstance(value, bool) or value is None:
        return []
    return [str(value)[:80]]


_ANSWERS = {"going": "you're going to", "maybe": "you might go to", "declined": "you can't make"}


def _event_changes(args: dict[str, Any]) -> list[str]:
    parts: list[str] = []
    if args.get("title"):
        parts.append(f"call it {text(args['title'])}")
    if args.get("start"):
        parts.append(f"move it to {spoken_time(args['start'])}")
    if args.get("end"):
        parts.append(f"end it {spoken_time(args['end'])}")
    if args.get("all_day") is not None and "all_day" in args:
        parts.append("make it all day" if args["all_day"] else "give it a time")
    if args.get("location"):
        parts.append(f"set the place to {text(args['location'])}")
    if args.get("description"):
        parts.append("change its notes")
    if args.get("add_guests"):
        parts.append("invite " + ", ".join(text(g) for g in args["add_guests"]))
    if args.get("remove_guests"):
        parts.append("uninvite " + ", ".join(text(g) for g in args["remove_guests"]))
    if args.get("stop_repeating"):
        parts.append("stop it repeating")
    elif args.get("repeat"):
        parts.append("make it repeat")
    return parts


def question(name: str, args: dict[str, Any], *, called: str | None = None) -> str:
    """The read-back for ``name`` run with ``args``. ``called`` names the thing
    the arguments point at, when the caller looked it up."""
    if name == "calendar_add_event":
        guests = args.get("guests") or []
        invite = f", inviting {', '.join(text(g) for g in guests)}" if isinstance(guests, list) and guests else ""
        return f"Add {text(args.get('title'))} to your calendar for {spoken_time(args.get('start'))}{invite}?"
    if name == "calendar_change_event":
        which = called or "that event"
        if args.get("action") == "answer":
            return f"Tell them {_ANSWERS.get(str(args.get('answer')), 'your answer to')} {which}?"
        if args.get("action") == "delete":
            return f"Delete {which}?"
        parts = _event_changes(args)
        return f"Change {which}: {', '.join(parts)[:200]}?" if parts else f"Change {which}?"
    if name == "mail_reply":
        return f"Reply to {text(args.get('to'))}, saying: {str(args.get('text'))[:300]}. Send it?"
    if name == "remember":
        return f"Save to your memory: {text(args.get('content'), 200)}?"
    if name == "set_alarm":
        return f"Set {clock_words({'type': 'set_alarm', **args})}?"
    if name == "use_item":
        values = args.get("args") if isinstance(args.get("args"), dict) else {}
        action = text(args.get("action") or "do that").replace("_", " ")
        where = f" in {called}" if called else ""
        return f"Should I {action}{where}: {', '.join(words(values))[:160]}?"
    values = args.get("args") if isinstance(args.get("args"), dict) else {}
    action = text(args.get("action") or "do that").replace("_", " ")
    return f"Should I {action}: {', '.join(words(values))[:160]}?"


async def cant_use(db, user: User, args: dict[str, Any]) -> tuple[str | None, str | None]:  # noqa: ANN001
    """Don't ask them to agree to something that can't work. Returns
    ``(problem, the file's name)``."""
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.items import _find
    from app.items.registry import get_spec

    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    try:
        row, doc, access = await _find(ctx, args)
    except ToolError as e:
        return str(e), None
    spec = get_spec(doc.kind)
    action = spec.action(str(args.get("action") or "")) if spec else None
    if action is None or not action.chat:
        return "That file has no such action. Check read_item.", None
    if action.writes and access != "edit":
        return "They can only read that file.", None
    from app.items import service

    return None, service.title_of(row)


async def reply_to_whom(db, user: User, args: dict[str, Any]) -> tuple[dict[str, Any], str | None]:  # noqa: ANN001
    """Who a reply really goes to, from the email itself."""
    from app.chat.tools.mail import reply_address
    from app.mail.models import MailAccount, MailMessage

    try:
        row = await db.get(MailMessage, uuid.UUID(str(args.get("message_id"))))
    except ValueError:
        row = None
    account = await db.get(MailAccount, row.account_id) if row is not None else None
    if row is None or account is None or account.user_id != user.id:
        return args, "that email wasn't found"
    return {"message_id": str(row.id), "text": str(args.get("text") or "")[:4000], "to": row.from_name or reply_address(row)}, None


async def _event_title(db, user: User, args: dict[str, Any]) -> tuple[str | None, str | None]:  # noqa: ANN001
    from fastapi import HTTPException

    from app.calendars import core

    try:
        eid = uuid.UUID(str(args.get("event_id")))
        ev, _member, _attendee = await core.load_event(db, eid, user)
    except (ValueError, HTTPException):
        return None, "that event wasn't found"
    return ev.title, None


async def _message(db, user: User, args: dict[str, Any]) -> tuple[str, str | None]:  # noqa: ANN001
    """A Rooms message, said back whole: "Message Sam on Promptly: '...' Send it?"."""
    from sqlalchemy import func, or_, select

    text = " ".join(str(args.get("message") or "").split())[:400]
    to = str(args.get("to") or "").strip().lstrip("@")
    if to:
        n = to.lower()
        rows = (
            await db.execute(
                select(User).where(User.disabled.is_(False), or_(func.lower(User.username) == n, func.lower(User.email) == n))
            )
        ).scalars().all()
        if len(rows) != 1 or rows[0].id == user.id:
            return "", f"there's no one called {to[:60]} on this Promptly. Use find_person for their username"
        other = rows[0]
        who = str((other.settings or {}).get("display_name") or other.username).strip()[:60]
        return f"Message {who} on Promptly: “{text}” Send it?", None
    room = " ".join(str(args.get("room") or "").split())[:60]
    if not room:
        return "", "say which room, or who to message"
    return f"Post in {room}: “{text}” Send it?", None


async def read_back(db, user: User, name: str, args: dict[str, Any]) -> tuple[str, str | None]:  # noqa: ANN001
    """``(question, problem)``. A problem means don't ask: it can't be done,
    and the model is told why instead."""
    if name == "post_to_room":
        return await _message(db, user, args)
    if name in ("create_note", "add_to_note", "tick_note_items"):
        from app.chat.holds import question as hold_question

        return hold_question(name, args), None
    if name == "mail_reply":
        shown, problem = await reply_to_whom(db, user, args)
        return question(name, shown), problem
    if name == "use_item":
        problem, called = await cant_use(db, user, args)
        return question(name, args, called=called), problem
    if name == "calendar_change_event":
        called, problem = await _event_title(db, user, args)
        return question(name, args, called=called), problem
    return question(name, args), None


# What it says once a yes has run it.
_DONE = {
    "calendar_add_event": "Added.",
    "calendar_change_event": "Done.",
    "mail_reply": "Sent.",
    "fetch_url": "Here's the page.",
    "remember": "Saved.",
    "use_item": "Done.",
    # Held on a chat turn that read outside content (chat/holds.py).
    "post_to_room": "Sent.",
    "create_note": "Made the note.",
    "add_to_note": "Added.",
    "tick_note_items": "Done.",
    "draft_form": "Made the draft form. It's in Forms for you to check and send.",
    "timeline_day": "Here's what your timeline shows.",
    "timeline_visits": "Here's what your timeline shows.",
}


def done_line(name: str, *, ok: bool, error: str | None = None, said: str | None = None) -> str:
    """The spoken outcome of an approved change."""
    if not ok:
        reason = (error or "").strip().rstrip(".")
        return f"That didn't work: {reason[:160]}." if reason else "That didn't work."
    if said:
        return said
    return _DONE.get(name, "Done.")


DECLINED = "Okay, I'll leave it."
