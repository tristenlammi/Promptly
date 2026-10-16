"""Dates in the user's own timezone (R-173).

Card due dates are stored as UTC instants. The board's RAG text, the
query_board tool and the card activity log printed ``due_at.date()`` —
the *UTC* date — so for Australian users a card due Friday 09:00 read as
due Thursday, and "what's due Friday?" got the wrong answer. AI-proposed
``YYYY-MM-DD`` dates were stored as UTC midnight, which is the day before
in the Americas.
"""
from __future__ import annotations

from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

UTC = timezone.utc


def zone_of(user) -> ZoneInfo | timezone:
    """The user's chosen timezone (Account ▸ Preferences), else UTC."""
    tz = None
    settings = getattr(user, "settings", None)
    if isinstance(settings, dict):
        tz = settings.get("timezone")
    if tz:
        try:
            return ZoneInfo(str(tz))
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return UTC


async def workspace_zone(db: AsyncSession, workspace) -> ZoneInfo | timezone:
    """Timezone for text indexed for the whole workspace: its owner's."""
    from app.auth.models import User

    owner = await db.get(User, workspace.user_id) if workspace is not None else None
    return zone_of(owner)


def local_date(dt: datetime | None, zone) -> str | None:
    """``YYYY-MM-DD`` of ``dt`` in ``zone``."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(zone).date().isoformat()


def local_day_at(day: str | date, zone, hour: int = 9) -> datetime:
    """A calendar day as an instant: ``hour``:00 local on that day — the
    same default time the board UI gives a card dropped on a day."""
    d = date.fromisoformat(day) if isinstance(day, str) else day
    return datetime.combine(d, time(hour, 0), tzinfo=zone).astimezone(UTC)
