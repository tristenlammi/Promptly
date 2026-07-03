"""Shared read-side aggregations over the usage data.

Both the admin analytics endpoints (``admin/analytics.py``, fleet-wide)
and the end-user usage dashboard (``billing/router.py``, self-scoped)
read the same numbers; the only difference is whether a ``user_id``
filter is applied. Keeping the window math and the query shapes here —
rather than copy-pasting the SQL into two places — means the two views
can never silently disagree about a day's tokens or a model's spend.

``cost_usd_micros`` is stored as integer micros in the DB and converted
to float USD here so callers never have to think about the conversion.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import (
    AnalyticsModelRow,
    AnalyticsTimeseriesPoint,
)
from app.billing.models import UsageDaily
from app.chat.models import Conversation, Message


def window_start(days: int) -> datetime:
    """First instant we want included in the window.

    ``usage_daily.day`` is a date (not a timestamp), so anchoring to
    UTC midnight ``days-1`` ago gives an inclusive range — pass
    ``days=1`` for "today only", ``days=30`` for the last month.
    Callers that compare against a date column use ``.date()``.
    """
    today = datetime.now(timezone.utc).date()
    return datetime.combine(
        today - timedelta(days=max(days - 1, 0)), datetime.min.time()
    )


def micros_to_usd(micros: int | None) -> float:
    if not micros:
        return 0.0
    return round(int(micros) / 1_000_000, 6)


async def timeseries(
    db: AsyncSession,
    *,
    start: datetime,
    user_id: uuid.UUID | None = None,
) -> list[AnalyticsTimeseriesPoint]:
    """Daily totals off ``usage_daily``, one point per day.

    With ``user_id`` omitted the rows are summed across every user
    (the fleet trend); with it set the result is scoped to that one
    user. Days with no usage are omitted to keep the payload small —
    the frontend fills the gaps so the X axis stays continuous.
    """
    stmt = (
        select(
            UsageDaily.day,
            func.coalesce(func.sum(UsageDaily.messages_sent), 0),
            func.coalesce(func.sum(UsageDaily.prompt_tokens), 0),
            func.coalesce(func.sum(UsageDaily.completion_tokens), 0),
            func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0),
        )
        .where(UsageDaily.day >= start.date())
        .group_by(UsageDaily.day)
        .order_by(UsageDaily.day.asc())
    )
    if user_id is not None:
        stmt = stmt.where(UsageDaily.user_id == user_id)

    rows = (await db.execute(stmt)).all()
    return [
        AnalyticsTimeseriesPoint(
            day=datetime.combine(r[0], datetime.min.time(), tzinfo=timezone.utc),
            messages=int(r[1] or 0),
            prompt_tokens=int(r[2] or 0),
            completion_tokens=int(r[3] or 0),
            cost_usd=micros_to_usd(r[4]),
        )
        for r in rows
    ]


async def by_model(
    db: AsyncSession,
    *,
    start: datetime,
    user_id: uuid.UUID | None = None,
) -> list[AnalyticsModelRow]:
    """Per-model breakdown.

    There's no model column on ``usage_daily`` — usage is rolled per
    user, not per model — so we count assistant messages and sum
    token / cost columns straight from the ``messages`` table joined
    to ``conversations``, bounded to the window via
    ``messages.created_at`` and grouped by ``conversations.model_id``.

    When ``user_id`` is set we attribute each message to its *sender*
    (``author_user_id``, falling back to the conversation owner for
    pre-backfill rows where it's NULL) — the same "sender pays" rule
    the ``usage_daily`` rollup uses — so the per-user by-model figures
    reconcile with the user's daily totals.
    """
    is_assistant = case((Message.role == "assistant", 1), else_=0)
    cost_sum = func.coalesce(func.sum(Message.cost_usd_micros), 0)
    stmt = (
        select(
            func.coalesce(Conversation.model_id, "unknown"),
            func.coalesce(func.sum(is_assistant), 0),
            func.coalesce(func.sum(Message.prompt_tokens), 0),
            func.coalesce(func.sum(Message.completion_tokens), 0),
            cost_sum,
        )
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Message.created_at >= start)
        .group_by(Conversation.model_id)
        .order_by(cost_sum.desc())
    )
    sender = func.coalesce(Message.author_user_id, Conversation.user_id)
    if user_id is not None:
        stmt = stmt.where(sender == user_id)

    rows = (await db.execute(stmt)).all()
    return [
        AnalyticsModelRow(
            model_id=str(r[0]),
            messages_window=int(r[1] or 0),
            prompt_tokens_window=int(r[2] or 0),
            completion_tokens_window=int(r[3] or 0),
            cost_usd_window=micros_to_usd(r[4]),
        )
        for r in rows
    ]


async def window_totals(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    start: datetime,
) -> tuple[int, int, int, int]:
    """Return ``(messages, prompt_tokens, completion_tokens, cost_micros)``
    summed off ``usage_daily`` for one user across the window."""
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageDaily.messages_sent), 0),
                func.coalesce(func.sum(UsageDaily.prompt_tokens), 0),
                func.coalesce(func.sum(UsageDaily.completion_tokens), 0),
                func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0),
            ).where(
                UsageDaily.user_id == user_id,
                UsageDaily.day >= start.date(),
            )
        )
    ).one()
    return int(row[0] or 0), int(row[1] or 0), int(row[2] or 0), int(row[3] or 0)


async def today_totals(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
) -> tuple[int, int]:
    """Return ``(messages_today, cost_micros_today)`` for one user."""
    today = datetime.now(timezone.utc).date()
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageDaily.messages_sent), 0),
                func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0),
            ).where(
                UsageDaily.user_id == user_id,
                UsageDaily.day == today,
            )
        )
    ).one()
    return int(row[0] or 0), int(row[1] or 0)


__all__ = [
    "by_model",
    "micros_to_usd",
    "timeseries",
    "today_totals",
    "window_start",
    "window_totals",
]
