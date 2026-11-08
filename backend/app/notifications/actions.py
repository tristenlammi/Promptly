"""Buttons on a push ("Going" / "Can't go", "Done" / "Snooze 1 hour").

The service worker shows each push's ``actions``; tapping one POSTs that
action's token to ``/api/notifications/action``. The worker has no session
(it can't read the app's sign-in), so the token is the key: an HMAC of
(user, action, target, expiry, token version) under the app's secret. It
does exactly one thing for one person, stops working after a week, and dies
with "sign out everywhere" (the user's token version moves on).

A platform without notification buttons just opens the push's link, as before.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings

logger = logging.getLogger("promptly.notifications.actions")

TTL_S = 7 * 24 * 3600
_DOMAIN = b"promptly-notification-action:v1:"

# action id → what the button says
LABELS = {
    "cal_going": "Going",
    "cal_declined": "Can't go",
    "cal_snooze": "Snooze 10 min",
    "task_done": "Done",
    "task_snooze": "Snooze 1 hour",
    # Calls (0282): a ringing DM call. Decline works from the push alone;
    # Answer needs media, so its token is redeemed by the page or the
    # Android incoming-call screen at /api/calls/answer (never here).
    "call_decline": "Decline",
    "call_answer": "Answer",
}


class ActionRefused(Exception):
    """The token is bad, expired, or the thing it points at is gone."""


def _key() -> bytes:
    return _DOMAIN + get_settings().SECRET_KEY.encode("utf-8")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(user: User, action: str, target: str, *, ttl_s: int = TTL_S, now: float | None = None) -> str:
    body = {"u": str(user.id), "a": action, "t": target, "e": int((now or time.time()) + ttl_s), "v": int(user.token_version or 0)}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    mac = hmac.new(_key(), raw, hashlib.sha256).digest()
    return f"{_b64(raw)}.{_b64(mac)}"


def verify(token: str, *, now: float | None = None) -> dict[str, Any]:
    """The token's claims, or :class:`ActionRefused`. Doesn't check the user
    (see :func:`perform`)."""
    try:
        raw_b64, mac_b64 = token.split(".", 1)
        raw = _unb64(raw_b64)
        mac = _unb64(mac_b64)
    except (ValueError, TypeError) as exc:
        raise ActionRefused("bad token") from exc
    if not hmac.compare_digest(mac, hmac.new(_key(), raw, hashlib.sha256).digest()):
        raise ActionRefused("bad token")
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise ActionRefused("bad token") from exc
    if not isinstance(body, dict) or body.get("a") not in LABELS:
        raise ActionRefused("bad token")
    if int(body.get("e") or 0) < (now or time.time()):
        raise ActionRefused("expired")
    return body


def buttons(user: User, *pairs: tuple[str, str]) -> dict[str, Any]:
    """``extra`` for :func:`notify_user`: [(action, target), …] → the
    worker's ``actions`` (each with its own token)."""
    return {"actions": [{"action": a, "title": LABELS[a], "token": sign(user, a, t)} for a, t in pairs]}


def task_buttons(user: User, file_id: uuid.UUID, key: str) -> dict[str, Any] | None:
    """A Tasks reminder's buttons, from its reminder key — ``task:<id>:<due>:<min>``
    (or a snoozed one, ``snooze:<ts>:task:…``). None for anything else."""
    orig = key.split(":", 2)[2] if key.startswith("snooze:") and key.count(":") >= 2 else key
    parts = orig.split(":")
    if len(parts) < 2 or parts[0] != "task" or not parts[1]:
        return None
    return buttons(user, ("task_done", f"{file_id}|{parts[1]}"), ("task_snooze", f"{file_id}|{key}"))


# ------------------------------------------------------------------ doing it


async def perform(db: AsyncSession, token: str) -> str:
    """Do what the token says, as its person. Returns a short line for the
    worker to show ("You're going to Dinner"). Commits."""
    claims = verify(token)
    try:
        uid = uuid.UUID(str(claims["u"]))
    except ValueError as exc:
        raise ActionRefused("bad token") from exc
    user = await db.get(User, uid)
    if user is None or user.disabled or int(user.token_version or 0) != int(claims.get("v") or 0):
        raise ActionRefused("bad token")
    action, target = claims["a"], str(claims.get("t") or "")
    if action in ("cal_going", "cal_declined"):
        return await _rsvp(db, user, target, "going" if action == "cal_going" else "declined")
    if action == "cal_snooze":
        return await _cal_snooze(db, user, target)
    if action == "task_done":
        return await _task_done(db, user, target)
    if action == "task_snooze":
        return await _task_snooze(db, user, target)
    if action == "call_decline":
        return await _call_decline(db, user, target)
    raise ActionRefused("bad token")


def _uuid(s: str) -> uuid.UUID:
    try:
        return uuid.UUID(s)
    except ValueError as exc:
        raise ActionRefused("bad target") from exc


async def _rsvp(db: AsyncSession, user: User, target: str, status: str) -> str:
    from fastapi import HTTPException

    from app.calendars import service
    from app.calendars.models import CalEvent

    eid = _uuid(target)
    try:
        await service.rsvp(db, user, eid, status)
    except HTTPException as exc:
        raise ActionRefused("gone") from exc
    await db.commit()
    ev = await db.get(CalEvent, eid)
    title = ev.title if ev else "the event"
    return f"You're going to {title}" if status == "going" else f"You can't make {title}"


SNOOZE_CAL = timedelta(minutes=10)


async def _cal_snooze(db: AsyncSession, user: User, target: str) -> str:
    """Remind again in 10 minutes. Saved in ``cal_event_snoozes`` (so a
    restart doesn't lose it); the calendar reminder loop sends it when it's
    due and deletes the row. Snoozing the same one again moves it."""
    from fastapi import HTTPException
    from sqlalchemy.dialects.postgresql import insert

    from app.calendars import core
    from app.calendars.models import CalEventSnooze

    eid_s, _, occ_s = target.partition("|")
    eid = _uuid(eid_s)
    try:
        ev, _m, _att = await core.load_event(db, eid, user)
        start = datetime.fromisoformat(occ_s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (HTTPException, ValueError) as exc:
        raise ActionRefused("gone") from exc
    until = datetime.now(timezone.utc) + SNOOZE_CAL
    await db.execute(
        insert(CalEventSnooze)
        .values(user_id=user.id, event_id=ev.id, occurrence=start, until=until)
        .on_conflict_do_update(constraint="uq_cal_event_snoozes", set_={"until": until})
    )
    title = ev.title
    await db.commit()
    return f"I'll remind you about {title} in 10 minutes"


async def _task_done(db: AsyncSession, user: User, target: str) -> str:
    import copy

    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    fid_s, _, task_id = target.partition("|")
    fid = _uuid(fid_s)
    try:
        row, doc, _access = await items.load(db, user, fid, need="edit", lock=True)
    except items.ItemNotFound as exc:
        raise ActionRefused("gone") from exc
    spec = get_spec(doc.kind)
    if spec is None or doc.kind != "tasks":
        raise ActionRefused("gone")
    data = copy.deepcopy(doc.data)
    ctx = items.make_context(db, user, row.id, spec)
    try:
        out = await items.run_action(ctx, spec, data, "complete_tasks", {"tasks": [task_id]})
        await items.save_data(db, user, row, doc, data, base_revision=None)
    except (ActionError, items.ItemError) as exc:
        raise ActionRefused("gone") from exc
    await db.commit()
    return out.summary if out.summary != "Nothing to change" else "Already done"


SNOOZE_TASK = timedelta(hours=1)


async def _task_snooze(db: AsyncSession, user: User, target: str) -> str:
    """The same reminder again in an hour — a reminder row of its own
    (``snooze:…``), which a recompute of the file leaves alone."""
    from sqlalchemy import select

    from app.items.models import ItemReminder

    fid_s, _, key = target.partition("|")
    fid = _uuid(fid_s)
    sent = (
        await db.execute(
            select(ItemReminder)
            .where(ItemReminder.file_id == fid, ItemReminder.user_id == user.id, ItemReminder.key == key)
            .limit(1)
        )
    ).scalar_one_or_none()
    if sent is None:
        raise ActionRefused("gone")
    now = datetime.now(timezone.utc)
    orig = key.split(":", 2)[2] if key.startswith("snooze:") else key
    db.add(
        ItemReminder(
            file_id=fid, user_id=user.id, key=f"snooze:{int(now.timestamp())}:{orig}"[:200],
            due_at=now + SNOOZE_TASK, title=sent.title, body=sent.body,
        )
    )
    await db.commit()
    return f"I'll remind you about {sent.title} in an hour"


async def _call_decline(db: AsyncSession, user: User, target: str) -> str:
    """Decline a ringing DM call from its push (Calls)."""
    from app.calls import dm

    try:
        await dm.decline_by_id(db, user, _uuid(target))
    except dm.CallError as exc:
        raise ActionRefused("gone") from exc
    return "Call declined"
