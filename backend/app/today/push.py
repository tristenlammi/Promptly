"""The one morning push (#5): "3 events · 4 tasks due · Leg day", with the
first thing on, opening Today.

It replaces the Tasks app's own morning digest (Tasks no longer schedules
one), so nobody gets two. Where the setting lives:

* someone with a Tasks app — its "Morning summary" switch and time
  (``settings.digest`` / ``digest_time``), as before;
* everyone else — ``user.settings.morning_summary`` (``{"on", "time"}``),
  off unless they turn it on (from the Today page).

Every minute, each person whose time has come (within :data:`WINDOW` — a
server that was down at 08:00 still sends at 09:00, never at noon) is
claimed for the day with one atomic write to their settings
(``morning_summary_sent``), so a restart or an overlapping pass never sends
twice. A day with nothing on sends nothing.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import re
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import SessionLocal

logger = logging.getLogger("promptly.today.push")

UTC = timezone.utc
WINDOW = timedelta(hours=3)
SENT_KEY = "morning_summary_sent"
PREF_KEY = "morning_summary"
DEFAULT_TIME = "08:00"
_TICK_S = 60
_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _clock(v: object) -> str:
    s = str(v or "").strip()
    return s if _CLOCK.match(s) else DEFAULT_TIME


def _from_tasks(data: dict) -> tuple[bool, str]:
    s = (data or {}).get("settings") or {}
    return bool(s.get("digest", True)), _clock(s.get("digest_time"))


def _from_account(user: User) -> tuple[bool, str]:
    p = (user.settings or {}).get(PREF_KEY) or {}
    if not isinstance(p, dict):
        return False, DEFAULT_TIME
    return bool(p.get("on", False)), _clock(p.get("time"))


async def prefs(db: AsyncSession, user: User) -> dict:
    """``{"on", "time", "source"}`` — where the switch lives for this person."""
    from app.items import service

    found = await service.primary_file(db, user, "tasks")
    if found is not None:
        on, at = _from_tasks(found[1].data)
        return {"on": on, "time": at, "source": "tasks", "file_id": str(found[0].id)}
    on, at = _from_account(user)
    return {"on": on, "time": at, "source": "account", "file_id": None}


async def set_prefs(db: AsyncSession, user: User, on: bool, at: str) -> dict:
    """Turn it on/off and set its time, wherever it lives. Committed."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.items import service

    at = _clock(at)
    found = await service.primary_file(db, user, "tasks")
    if found is not None:
        row, doc, _ = await service.load(db, user, found[0].id, need="edit", lock=True)
        data = copy.deepcopy(doc.data)
        data.setdefault("settings", {})
        data["settings"]["digest"] = bool(on)
        data["settings"]["digest_time"] = at
        await service.save_data(db, user, row, doc, data, base_revision=None)
    else:
        u = await db.get(User, user.id)
        settings = dict(u.settings or {})
        settings[PREF_KEY] = {"on": bool(on), "time": at}
        u.settings = settings
        flag_modified(u, "settings")
    await db.commit()
    return await prefs(db, user)


# ------------------------------------------------------------------ the text


def _n(k: int, one: str, many: str | None = None) -> str:
    return f"{k} {one if k == 1 else (many or one + 's')}"


def compose(summary: dict) -> tuple[str, str] | None:
    """(title, body) of the push from a :func:`app.today.core.build` result,
    or None when the day has nothing on."""
    from zoneinfo import ZoneInfo

    from .core import local_clock

    sec = summary.get("sections") or {}
    tz = ZoneInfo(summary.get("tz") or "UTC")
    parts: list[str] = []
    events = (sec.get("events") or {}).get("events") or []
    if events:
        parts.append(_n(len(events), "event"))
    tasks = sec.get("tasks") or {}
    due = int(tasks.get("today_count") or 0) + int(tasks.get("overdue_count") or 0)
    if due:
        parts.append(f"{_n(due, 'task')} due")
    for s in (sec.get("workout") or {}).get("sessions") or []:
        if s.get("status") == "planned":
            parts.append(s["name"])
            break
    shifts = (sec.get("work") or {}).get("shifts") or []
    if shifts:
        sh = shifts[0]
        parts.append(f"Shift {sh['start']}–{sh['end']}" if sh.get("start") and sh.get("end") else "Shift today")
    cards = int((sec.get("work") or {}).get("due_count") or 0)
    if cards:
        parts.append(f"{_n(cards, 'card')} due")
    habits = int((sec.get("habits") or {}).get("left") or 0)
    if habits:
        parts.append(_n(habits, "habit"))
    if not parts:
        return None
    title = " · ".join(parts)
    body = ""
    timed = [e for e in events if not e["all_day"]]
    now_iso = summary.get("now") or ""
    upcoming = [e for e in timed if e["end"] >= _utc_iso(now_iso)] or timed
    if upcoming:
        e = upcoming[0]
        body = f"First up: {local_clock(e['start'], tz)} {e['title']}"
    elif events:
        body = f"All day: {events[0]['title']}"
    elif tasks.get("today") or tasks.get("overdue"):
        names = [t["title"] for t in (tasks.get("today") or []) + (tasks.get("overdue") or [])]
        body = ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
    else:
        body = "Open Today to see your day."
    return title[:200], body[:300]


def _utc_iso(local_iso: str) -> str:
    try:
        return datetime.fromisoformat(local_iso).astimezone(UTC).isoformat().replace("+00:00", "Z")
    except ValueError:
        return ""


# ------------------------------------------------------------------ sending


async def _tasks_settings(db: AsyncSession) -> dict:
    """Each person's Tasks app settings, as ``{"settings": …}`` (the app's
    own file, most recent first — what :func:`app.items.service.primary_file`
    picks)."""
    from app.files.models import UserFile
    from app.items.models import ItemDocument, ItemState
    from app.items.service import ARCHIVE_KEY

    rows = (
        await db.execute(
            # Just the settings — not every task, every minute.
            select(UserFile.user_id, ItemDocument.data["settings"])
            .join(ItemDocument, ItemDocument.file_id == UserFile.id)
            .where(
                ItemDocument.kind == "tasks",
                UserFile.trashed_at.is_(None),
                ~select(ItemState.file_id)
                .where(ItemState.file_id == UserFile.id, ItemState.key == ARCHIVE_KEY)
                .exists(),
            )
            .order_by(UserFile.modified_at.desc())
        )
    ).all()
    out: dict = {}
    for uid, settings in rows:
        out.setdefault(uid, {"settings": settings or {}})
    return out


async def _claim(db: AsyncSession, user_id, day: str) -> bool:  # noqa: ANN001
    """Mark today's push as sent — True only for the one pass that did."""
    got = (
        await db.execute(
            text(
                "UPDATE users SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{" + SENT_KEY + "}', to_jsonb(CAST(:d AS text))) "
                "WHERE id = :u AND COALESCE(settings->>'" + SENT_KEY + "', '') <> :d RETURNING id"
            ),
            {"u": user_id, "d": day},
        )
    ).first()
    await db.commit()
    return got is not None


async def send_due(db: AsyncSession, now: datetime | None = None) -> int:
    from app.items.service import zone_for
    from app.notifications import dispatch
    from app.notifications import loops as held_loops

    from . import core

    now = now or datetime.now(UTC)
    tasks = await _tasks_settings(db)
    users = list((await db.execute(select(User).where(User.disabled.is_(False)).execution_options(populate_existing=True))).scalars())
    sent = 0
    for u in users:
        on, at = _from_tasks(tasks[u.id]) if u.id in tasks else _from_account(u)
        if not on:
            continue
        tz = zone_for(u)
        local = now.astimezone(tz)
        hh, mm = (int(x) for x in at.split(":"))
        due = datetime.combine(local.date(), time(hh, mm), tzinfo=tz)
        day = local.date().isoformat()
        if local < due or local - due > WINDOW or (u.settings or {}).get(SENT_KEY) == day:
            continue
        try:
            if not await _claim(db, u.id, day):
                continue
            summary = await core.build(db, u, now, photos=False)
            msg = compose(summary)
            # Pushes held for the daily summary (or by quiet hours) ride
            # along as counts, so there's one morning push, not two.
            held = await held_loops.take_for_morning(db, u, local.date())
            if msg is None and held:
                msg = (held_loops.SUMMARY_TITLE, held)
            elif msg is not None and held:
                msg = (msg[0], f"{msg[1]}\nAlso: {held}".strip()[:300])
            if msg is None:
                continue
            await dispatch.notify_user(
                user_id=u.id,
                category="item_reminder",
                title=msg[0],
                body=msg[1],
                url="/today",
                tag=f"today:{day}",
            )
            sent += 1
        except Exception:  # noqa: BLE001 — one person's summary mustn't stop the rest
            logger.exception("morning summary for %s failed", u.id)
            await db.rollback()
    return sent


async def _loop() -> None:
    logger.info("Today loop started")
    while True:
        try:
            async with SessionLocal() as db:
                await send_due(db)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("today loop pass failed")
        await asyncio.sleep(_TICK_S)


def start_today_loops() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="today_loops")
