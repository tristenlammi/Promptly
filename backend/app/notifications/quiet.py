"""Quiet hours and the daily summary: deciding to hold a push, and the
words for held pushes.

One setting for all of Promptly (``push_preferences.quiet_*``), in the
person's own time zone. A quiet period is attributed to the day it **ends**
on: with a weekend pair set, the periods ending on Saturday or Sunday (that
is, Friday and Saturday nights) use it.

What may be held is decided per category in ``dispatch.RULES`` — calendar
reminders, Passwords, admin alerts and (later) a ringing call never are.
Held pushes go out from ``notifications/loops.py``: one push per app when
quiet hours end, or counts in the daily summary. The summary only ever
says *how many* — never text someone else wrote.
"""
from __future__ import annotations

import logging
import uuid
from collections import OrderedDict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.notifications.models import PushHeld, PushPreferences

logger = logging.getLogger("promptly.notifications.quiet")

UTC = timezone.utc
#: Held pushes kept per person; older ones are dropped beyond this.
HELD_CAP = 500


# ------------------------------------------------------------------ time


def _now() -> datetime:
    return datetime.now(UTC)


def zone_of(settings: dict | None) -> ZoneInfo:
    """The person's saved time zone (``users.settings.timezone``), else UTC."""
    name = str((settings or {}).get("timezone") or "").strip()
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except Exception:  # noqa: BLE001 — a bad zone name falls back to UTC
        return ZoneInfo("UTC")


def _window(prefs: PushPreferences, end_day: date) -> tuple[time, time]:
    if end_day.weekday() >= 5 and prefs.quiet_weekend_start is not None and prefs.quiet_weekend_end is not None:
        return prefs.quiet_weekend_start, prefs.quiet_weekend_end
    return prefs.quiet_start, prefs.quiet_end


def quiet_until(prefs: PushPreferences | None, now: datetime, tz: ZoneInfo) -> datetime | None:
    """When the current quiet period ends (local, aware), or None when it
    isn't quiet now. Handles periods across midnight (22:00–07:00)."""
    if prefs is None or not prefs.quiet_enabled:
        return None
    local = now.astimezone(tz)
    for end_day in (local.date(), local.date() + timedelta(days=1)):
        start_t, end_t = _window(prefs, end_day)
        if start_t is None or end_t is None or start_t == end_t:
            continue
        start_day = end_day if start_t < end_t else end_day - timedelta(days=1)
        start = datetime.combine(start_day, start_t, tzinfo=tz)
        end = datetime.combine(end_day, end_t, tzinfo=tz)
        if start <= local < end:
            return end
    return None


def is_quiet(prefs: PushPreferences | None, now: datetime, tz: ZoneInfo) -> bool:
    return quiet_until(prefs, now, tz) is not None


# ------------------------------------------------------------------ holding


async def hold_reason(
    db: AsyncSession,
    prefs: PushPreferences,
    category: str,
    *,
    summary: bool = False,
    now: datetime | None = None,
) -> str | None:
    """``'summary'``, ``'quiet'`` or None (send now). Never holds a category
    whose rule says it must get through."""
    from app.auth.models import User
    from app.notifications.dispatch import rule_for

    rule = rule_for(category)
    if not rule.holdable:
        return None
    if summary or (rule.summary and category in (prefs.summary_categories or [])):
        return "summary"
    if not prefs.quiet_enabled:
        return None
    user = await db.get(User, prefs.user_id)
    tz = zone_of(user.settings if user is not None else None)
    return "quiet" if is_quiet(prefs, now or _now(), tz) else None


async def hold(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    category: str,
    payload: Any,
    actor_user_id: uuid.UUID | None,
    reason: str,
) -> None:
    """Keep a push for later (the caller commits). Keeps at most
    :data:`HELD_CAP` per person, dropping the oldest."""
    db.add(
        PushHeld(
            user_id=user_id,
            category=category,
            title=(payload.title or "")[:200],
            body=payload.body or "",
            url=(payload.url or None) and payload.url[:500],
            tag=(payload.tag or None) and payload.tag[:200],
            # The badge count is stale by the time it goes; the rest stays.
            extra={k: v for k, v in (payload.extra or {}).items() if k != "app_badge"} or None,
            actor_user_id=actor_user_id,
            reason=reason,
            created_at=_now(),
        )
    )
    await db.flush()
    stale = (
        await db.execute(
            select(PushHeld.id)
            .where(PushHeld.user_id == user_id)
            .order_by(PushHeld.created_at.desc(), PushHeld.id)
            .offset(HELD_CAP)
        )
    ).scalars().all()
    if stale:
        await db.execute(delete(PushHeld).where(PushHeld.id.in_(stale)))


# ------------------------------------------------------------------ words


def _kind_of(row: PushHeld) -> str:
    return str((row.extra or {}).get("kind") or "")


def _count_of(row: PushHeld) -> int:
    """One push can stand for several ("12 new emails": ``extra.count``)."""
    n = (row.extra or {}).get("count")
    return n if isinstance(n, int) and 0 < n < 100_000 else 1


def _and(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def phrase(category: str, rows: Iterable[PushHeld]) -> str:
    """Counts for one app: "3 new messages in Rooms", "4 new posts and
    2 comments in Porch". Only counts and fixed words — no held text."""
    from app.notifications.dispatch import rule_for

    rule = rule_for(category)
    nouns = {k: (one, many) for k, one, many in rule.kinds}
    counts: OrderedDict[str, int] = OrderedDict()
    for r in rows:
        k = _kind_of(r) if _kind_of(r) in nouns else ""
        counts[k] = counts.get(k, 0) + _count_of(r)
    parts = []
    for k, n in counts.items():
        one, many = nouns.get(k, (rule.one, rule.many))
        parts.append(f"{n} {one if n == 1 else many}")
    text = _and(parts) if parts else ""
    return f"{text} in {rule.app}" if rule.app and text else text


def by_category(rows: Iterable[PushHeld]) -> OrderedDict[str, list[PushHeld]]:
    """Held rows grouped per category, oldest first."""
    out: OrderedDict[str, list[PushHeld]] = OrderedDict()
    for r in sorted(rows, key=lambda r: (r.created_at or datetime.min.replace(tzinfo=UTC))):
        out.setdefault(r.category, []).append(r)
    return out


def summary_line(rows: Iterable[PushHeld]) -> str | None:
    """"3 new messages in Rooms, 2 new emails in Mail" — or None."""
    groups = by_category(rows)
    parts = [phrase(c, rs) for c, rs in groups.items()]
    parts = [p for p in parts if p]
    return ", ".join(parts) if parts else None


def app_url(category: str, rows: list[PushHeld]) -> str:
    """Where a collapsed push opens: the one place they all point at, else
    the app."""
    from app.notifications.dispatch import rule_for

    urls = {r.url for r in rows if r.url}
    if len(urls) == 1 and len(rows) >= 1 and all(r.url for r in rows):
        return next(iter(urls))
    return rule_for(category).url
