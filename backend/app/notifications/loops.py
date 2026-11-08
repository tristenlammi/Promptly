"""Sending held pushes on (an in-process loop, like ``today/push.py``; the
backend runs one worker by design, so there is exactly one of these).

Every minute, for each person with held pushes:

* **Daily summary** — at their Today summary time (``today/push.py``), once
  a day, claimed with one atomic write (``push_preferences.summary_sent_on``)
  so a restart never sends it twice. Everything held — summary *and* quiet
  — goes out as one push of counts per app. When the Today morning push is
  on, it carries these counts itself (:func:`take_for_morning`), so there's
  one morning push, not two. If the summary time falls in quiet hours, the
  summary waits for them to end.
* **Quiet hours ending** — pushes held by quiet hours go out as one push per
  app ("While you were away" · "3 new messages in Rooms"); a single held
  push goes out as it was.

Rows are deleted (and committed) before sending, so nothing is sent twice.
Pushes from someone blocked since, or for a category switched off since,
are dropped.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import date, datetime, time, timezone

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.notifications import quiet
from app.notifications.models import PushHeld, PushPreferences

logger = logging.getLogger("promptly.notifications.loops")

UTC = timezone.utc
_TICK_S = 60
SUMMARY_TITLE = "Your daily summary"
AWAY_TITLE = "While you were away"


async def _take(db: AsyncSession, user_id: uuid.UUID, reason: str | None = None) -> list[PushHeld]:
    """Delete and return someone's held pushes (all, or one reason).
    Committed — what's taken is never sent twice."""
    t = PushHeld.__table__
    q = delete(t).where(t.c.user_id == user_id)
    if reason is not None:
        q = q.where(t.c.reason == reason)
    # Plain rows (attribute access like the model), not ORM objects.
    rows = list((await db.execute(q.returning(*t.columns))).all())
    await db.commit()
    return rows  # type: ignore[return-value]


async def _keep(db: AsyncSession, user_id: uuid.UUID, prefs: PushPreferences | None, rows: list[PushHeld]) -> list[PushHeld]:
    """What may still go: master switch on, category still on, and no
    block between the two people now. (No prefs row = the defaults: on.)"""
    from app.notifications.dispatch import _should_send
    from app.people.blocks import hidden_ids

    hidden = await hidden_ids(db, user_id) if any(r.actor_user_id for r in rows) else set()
    return [r for r in rows if (prefs is None or _should_send(prefs, r.category)) and r.actor_user_id not in hidden]


async def _claim_summary(db: AsyncSession, user_id: uuid.UUID, day: date) -> bool:
    """Mark today's summary as sent — True only for the one pass that did."""
    got = (
        await db.execute(
            text(
                "INSERT INTO push_preferences (user_id, summary_sent_on) VALUES (:u, :d) "
                "ON CONFLICT (user_id) DO UPDATE SET summary_sent_on = :d "
                "WHERE push_preferences.summary_sent_on IS DISTINCT FROM :d RETURNING user_id"
            ),
            {"u": user_id, "d": day},
        )
    ).first()
    await db.commit()
    return got is not None


async def take_for_morning(db: AsyncSession, user, day: date) -> str | None:  # noqa: ANN001
    """Called by the Today morning push as it goes: claims today's summary
    and returns the counts line for everything held ("3 new messages in
    Rooms, 2 new emails in Mail"), or None. Only when that push will
    actually reach them (master switch and item reminders on) — otherwise
    the standalone summary here sends it."""
    prefs = await db.get(PushPreferences, user.id)
    if not carried_by_today(prefs, True):
        return None
    if not await _claim_summary(db, user.id, day):
        return None
    rows = await _keep(db, user.id, prefs, await _take(db, user.id))
    return quiet.summary_line(rows)


def carried_by_today(prefs: PushPreferences | None, today_on: bool) -> bool:
    """Does the Today morning push carry the summary for this person?"""
    if not today_on:
        return False
    if prefs is None:
        return True
    return bool(prefs.enabled and prefs.item_reminder)


async def _send(db: AsyncSession, user_id: uuid.UUID, *, title: str, body: str, url: str, tag: str, category: str = "summary", extra: dict | None = None) -> None:
    from app.notifications.dispatch import PushPayload, deliver

    await deliver(db, user_id, PushPayload(title=title[:200], body=body[:300], url=url, tag=tag, category=category, extra=extra))


async def send_summary(db: AsyncSession, user_id: uuid.UUID, prefs: PushPreferences | None) -> bool:
    rows = await _keep(db, user_id, prefs, await _take(db, user_id))
    line = quiet.summary_line(rows)
    if not line:
        return False
    cats = {r.category for r in rows}
    url = quiet.app_url(next(iter(cats)), rows) if len(cats) == 1 else "/today"
    await _send(db, user_id, title=SUMMARY_TITLE, body=line, url=url, tag="promptly-summary")
    return True


async def release_quiet(db: AsyncSession, user_id: uuid.UUID, prefs: PushPreferences | None) -> int:
    """Quiet hours are over: one push per app (a single push as it was)."""
    rows = await _keep(db, user_id, prefs, await _take(db, user_id, "quiet"))
    sent = 0
    for category, group in quiet.by_category(rows).items():
        if len(group) == 1:
            r = group[0]
            await _send(db, user_id, title=r.title, body=r.body, url=r.url or quiet.app_url(category, group), tag=r.tag or f"held:{category}", category=category, extra=r.extra)
        else:
            await _send(db, user_id, title=AWAY_TITLE, body=quiet.phrase(category, group), url=quiet.app_url(category, group), tag=f"held:{category}", category=category)
        sent += 1
    return sent


async def run_once(db: AsyncSession, now: datetime | None = None) -> dict[str, int]:
    """One pass over everyone with held pushes."""
    from app.auth.models import User
    from app.today import push as today_push

    now = now or quiet._now()
    out = {"summaries": 0, "released": 0}
    user_ids = list((await db.execute(select(PushHeld.user_id).distinct())).scalars().all())
    if not user_ids:
        return out
    tasks = await today_push._tasks_settings(db)
    for uid in user_ids:
        try:
            u = await db.get(User, uid, populate_existing=True)
            if u is None:
                continue
            prefs = await db.get(PushPreferences, uid, populate_existing=True)
            tz = quiet.zone_of(u.settings)
            local = now.astimezone(tz)
            if u.disabled or (prefs is not None and not prefs.enabled):
                await _take(db, uid)  # nothing goes to them; don't keep it
                continue
            if quiet.is_quiet(prefs, now, tz):
                continue
            today_on, at = today_push._from_tasks(tasks[uid]) if uid in tasks else today_push._from_account(u)
            hh, mm = (int(x) for x in at.split(":"))
            due = datetime.combine(local.date(), time(hh, mm), tzinfo=tz)
            sent_today = prefs is not None and prefs.summary_sent_on == local.date()
            # The Today push carries it while it can still go (its window).
            today_will = carried_by_today(prefs, today_on) and local - due <= today_push.WINDOW
            if local >= due and not sent_today and today_will:
                continue  # the Today push is about to take everything
            # A summary is due once its time has come, for what was held
            # before then; later ones wait for tomorrow's.
            has_summary = (
                await db.execute(
                    select(PushHeld.id)
                    .where(PushHeld.user_id == uid, PushHeld.reason == "summary", PushHeld.created_at <= due.astimezone(UTC))
                    .limit(1)
                )
            ).first() is not None
            if has_summary and local >= due and not sent_today:
                if await _claim_summary(db, uid, local.date()):
                    out["summaries"] += int(await send_summary(db, uid, prefs))
                    continue
            out["released"] += await release_quiet(db, uid, prefs)
        except Exception:  # noqa: BLE001 — one person mustn't stop the rest
            logger.exception("held pushes for %s failed", uid)
            await db.rollback()
    return out


async def _loop() -> None:
    logger.info("Held-push loop started")
    while True:
        try:
            async with SessionLocal() as db:
                await run_once(db)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("held-push loop pass failed")
        await asyncio.sleep(_TICK_S)


def start_notification_loops() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="notification_loops")
