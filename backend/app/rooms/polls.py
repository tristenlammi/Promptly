"""Polls in a room: a message whose ``meta.poll`` is the question, its
options and settings; the ticks are ``room_poll_votes`` rows. Anyone in the
room can vote and change their vote until it closes; whoever asked (or a
space admin) can close it. An anonymous poll never sends out who voted."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import RoomMessage, RoomPollVote

MIN_OPTIONS = 2
MAX_OPTIONS = 10
MAX_QUESTION = 300
MAX_OPTION = 120
MAX_OPEN = timedelta(days=60)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _one_line(s: Any, limit: int) -> str:
    return " ".join(str(s or "").split())[:limit]


def make(question: str, options: list[str], *, multiple: bool, anonymous: bool, closes_at: datetime | None, now: datetime | None = None) -> dict:
    """A new poll's ``meta.poll`` from what was asked for (400 if it isn't one)."""
    now = now or datetime.now(timezone.utc)
    q = _one_line(question, MAX_QUESTION)
    if not q:
        raise _bad("Ask a question")
    seen: set[str] = set()
    opts: list[dict] = []
    for raw in options or []:
        text = _one_line(raw, MAX_OPTION)
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        opts.append({"id": str(len(opts) + 1), "text": text})
    if len(opts) < MIN_OPTIONS:
        raise _bad("A poll needs at least two different answers")
    if len(opts) > MAX_OPTIONS:
        raise _bad(f"A poll can have up to {MAX_OPTIONS} answers")
    closes = None
    if closes_at is not None:
        if closes_at.tzinfo is None:
            closes_at = closes_at.replace(tzinfo=timezone.utc)
        if closes_at <= now + timedelta(seconds=30):
            raise _bad("Pick a closing time that's still to come")
        if closes_at > now + MAX_OPEN:
            raise _bad("A poll can stay open for up to 60 days")
        closes = closes_at.astimezone(timezone.utc).isoformat()
    return {"question": q, "options": opts, "multiple": bool(multiple), "anonymous": bool(anonymous), "closes_at": closes, "closed_at": None}


def of(m: RoomMessage) -> dict | None:
    p = (m.meta or {}).get("poll")
    return p if isinstance(p, dict) and isinstance(p.get("options"), list) else None


def body_for(poll: dict) -> str:
    """What stands in for the message's words (lists, notifications, search)."""
    return f"\U0001F4CA {poll['question']}"


def closed(poll: dict, now: datetime | None = None) -> bool:
    if poll.get("closed_at"):
        return True
    raw = poll.get("closes_at")
    if not raw:
        return False
    try:
        return (now or datetime.now(timezone.utc)) >= datetime.fromisoformat(str(raw))
    except ValueError:
        return False


async def states(db: AsyncSession, msgs: list[RoomMessage], viewer_id: uuid.UUID | None = None) -> dict[uuid.UUID, dict]:
    """The live count for each poll among ``msgs``: per-option numbers, how
    many people voted, who (unless it's anonymous), and ``mine`` for the
    viewer when there is one."""
    polls = {m.id: p for m in msgs if m.deleted_at is None and (p := of(m))}
    if not polls:
        return {}
    by_msg: dict[uuid.UUID, dict[str, list[str]]] = {}
    rows = await db.execute(
        select(RoomPollVote.message_id, RoomPollVote.option, RoomPollVote.user_id)
        .where(RoomPollVote.message_id.in_(list(polls)))
        .order_by(RoomPollVote.created_at)
    )
    for mid, opt, uid in rows.all():
        by_msg.setdefault(mid, {}).setdefault(opt, []).append(str(uid))
    out: dict[uuid.UUID, dict] = {}
    for mid, poll in polls.items():
        ids = [str(o.get("id")) for o in poll["options"]]
        votes = by_msg.get(mid, {})
        people = {u for o in ids for u in votes.get(o, [])}
        st: dict[str, Any] = {
            "counts": {o: len(votes.get(o, [])) for o in ids},
            "voters_total": len(people),
            "closed": closed(poll),
        }
        if not poll.get("anonymous"):
            st["voters"] = {o: votes.get(o, []) for o in ids}
        if viewer_id is not None:
            me = str(viewer_id)
            st["mine"] = [o for o in ids if me in votes.get(o, [])]
        out[mid] = st
    return out


async def state(db: AsyncSession, m: RoomMessage, viewer_id: uuid.UUID | None = None) -> dict:
    return (await states(db, [m], viewer_id)).get(m.id, {})


async def vote(db: AsyncSession, m: RoomMessage, user_id: uuid.UUID, options: list[str]) -> None:
    """Replace ``user_id``'s ticks on this poll with ``options`` (none takes
    the vote back). The message row must be locked by the caller."""
    poll = of(m)
    if poll is None or m.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Poll not found")
    if closed(poll):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This poll has closed")
    known = {str(o.get("id")) for o in poll["options"]}
    picked = list(dict.fromkeys(str(o) for o in options))
    if any(o not in known for o in picked):
        raise _bad("That isn't one of the answers")
    if len(picked) > 1 and not poll.get("multiple"):
        raise _bad("Pick one answer")
    await db.execute(delete(RoomPollVote).where(RoomPollVote.message_id == m.id, RoomPollVote.user_id == user_id))
    for o in picked:
        db.add(RoomPollVote(message_id=m.id, user_id=user_id, option=o))
    await db.flush()


def close(m: RoomMessage, now: datetime | None = None) -> bool:
    """Close the poll now. False if it already was."""
    poll = of(m)
    if poll is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Poll not found")
    if closed(poll, now):
        return False
    m.meta = {**(m.meta or {}), "poll": {**poll, "closed_at": (now or datetime.now(timezone.utc)).isoformat()}}
    return True
