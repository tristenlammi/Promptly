"""Study's daily nudge: one push a day at most, at the time the person chose,
only when there is something to do and they haven't studied yet today.

Off unless turned on (``user.settings.study.remind = {"on", "time"}``). It
goes out as an ``item_reminder`` (the "Reminders" switch in Account →
Notifications, and each device's own switch, apply to it like any other).
The day is claimed with one atomic write before sending, so a restart or an
overlapping pass never sends twice. Run by the arq worker
(``study_nudge_tick``, every 5 minutes).

When it is quiet (``rules.nudge_wanted``): they already studied today;
or nothing is due for review, no lesson is open, and no subject has been
studied (or started) in the last :data:`RECENT_DAYS` days: a subject left
alone that long stops asking.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.study import rules, service
from app.study.models import StudyDay, StudySession, StudySubject

logger = logging.getLogger("promptly.study")

SENT_KEY = "study_nudge_sent"
DEFAULT_TIME = "17:00"
RECENT_DAYS = 14
_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def clock(v: object) -> str:
    s = str(v or "").strip()
    return s if _CLOCK.match(s) else DEFAULT_TIME


def prefs(user: User) -> dict[str, Any]:
    p = ((user.settings or {}).get("study") or {}).get("remind") or {}
    if not isinstance(p, dict):
        p = {}
    return {"on": bool(p.get("on", False)), "time": clock(p.get("time"))}


def compose(*, due: int, lesson: tuple[str, str | None] | None) -> tuple[str, str]:
    """(title, body). ``lesson`` is (subject title, next concept title or None)."""
    if due:
        title = "1 idea to review" if due == 1 else f"{due} ideas to review"
        body = "A couple of minutes keeps what you've learned." if lesson is None else f"Then carry on with {lesson[0]}."
        return title, body
    assert lesson is not None
    return f"Carry on with {lesson[0]}"[:200], (f"Next: {lesson[1]}" if lesson[1] else "Pick up where you left off.")[:300]


async def _claim(db: AsyncSession, user_id: Any, day: str) -> bool:
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


async def what_to_do(db: AsyncSession, user: User, now: datetime) -> dict[str, Any] | None:
    """What a nudge would say for this person now, or None for nothing."""
    zone = service._zone(user)
    today = now.astimezone(zone).date()
    studied = (await db.execute(select(StudyDay.day).where(StudyDay.user_id == user.id, StudyDay.day == today))).first() is not None
    due = len(await service.due_rows(db, user, now=now))
    live = service._live_subjects(user)
    open_lesson = (
        await db.execute(
            select(StudySubject)
            .join(StudySession, StudySession.subject_id == StudySubject.id)
            .where(*live, StudySession.kind == "lesson", StudySession.status == "active")
            .order_by(StudySession.started_at.desc())
        )
    ).scalars().first()
    recent = (
        await db.execute(
            select(StudySubject)
            .where(*live, StudySubject.status == "active", func.coalesce(StudySubject.last_studied_at, StudySubject.created_at) >= now - timedelta(days=RECENT_DAYS))
            .order_by(func.coalesce(StudySubject.last_studied_at, StudySubject.created_at).desc())
        )
    ).scalars().first()
    if not rules.nudge_wanted(due=due, lesson_open=open_lesson is not None, studied_today=studied, recent_subject=recent is not None):
        return None
    subject = open_lesson or recent
    lesson = None
    if subject is not None:
        nxt = rules.pick_concept([service._state(c) for c in await service.concepts_of(db, subject.id)])
        title = None
        if nxt is not None:
            from app.study.models import StudyConcept

            row = await db.get(StudyConcept, nxt.id)
            title = row.title if row else None
        lesson = (subject.title, title)
    title, body = compose(due=due, lesson=lesson)
    url = "/study/review" if due else f"/study/{subject.id}/continue"
    return {"title": title, "body": body, "url": url, "due": due}


async def send_due(db: AsyncSession, now: datetime | None = None) -> int:
    """Send today's nudge to everyone whose time has come. Returns how many."""
    from app.notifications import dispatch

    now = now or datetime.now(timezone.utc)
    users = list(
        (
            await db.execute(
                select(User).where(User.disabled.is_(False), func.jsonb_extract_path_text(User.settings, "study", "remind", "on") == "true")
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )
    sent = 0
    for u in users:
        p = prefs(u)
        if not p["on"]:
            continue
        local = now.astimezone(service._zone(u))
        day = local.date().isoformat()
        hh, mm = (int(x) for x in p["time"].split(":"))
        if not rules.nudge_due(local.hour * 60 + local.minute, hh * 60 + mm, sent_today=(u.settings or {}).get(SENT_KEY) == day):
            continue
        try:
            msg = await what_to_do(db, u, now)
            if msg is None:
                continue  # nothing to say now; later today there may be
            if not await _claim(db, u.id, day):
                continue
            await dispatch.notify_user(
                user_id=u.id, category="item_reminder", title=msg["title"], body=msg["body"], url=msg["url"], tag=f"study:{day}",
            )
            sent += 1
        except Exception:  # noqa: BLE001 — one person's nudge mustn't stop the rest
            logger.exception("study nudge failed")
            await db.rollback()
    return sent
