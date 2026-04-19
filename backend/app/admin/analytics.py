"""Admin analytics endpoints.

Backed by the ``usage_daily`` rollup (always the source of truth for
costs and tokens) plus a join through ``messages → conversations``
when we need a per-model breakdown. All endpoints accept a ``days``
window (default 30) and gate on :func:`require_admin`.

Cost is stored as integer micros in the DB and returned as float
USD here so the frontend never has to think about the conversion.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import (
    AnalyticsModelRow,
    AnalyticsSummary,
    AnalyticsTimeseriesPoint,
    AnalyticsUserRow,
)
from app.auth.deps import require_admin
from app.auth.models import User
from app.billing.models import UsageDaily
from app.chat.models import Conversation, Message
from app.database import get_db

router = APIRouter()


def _window_start(days: int) -> datetime:
    """First instant we want included in the window.

    ``usage_daily.day`` is a date (not a timestamp), so anchoring to
    UTC midnight ``days-1`` ago gives an inclusive range — pass
    ``days=1`` for "today only", ``days=30`` for the last month.
    """
    today = datetime.now(timezone.utc).date()
    return datetime.combine(today - timedelta(days=max(days - 1, 0)), datetime.min.time())


def _micros_to_usd(micros: int | None) -> float:
    if not micros:
        return 0.0
    return round(int(micros) / 1_000_000, 6)


@router.get("/analytics/summary", response_model=AnalyticsSummary)
async def analytics_summary(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AnalyticsSummary:
    """Headline numbers: messages, tokens, cost, active users."""
    start = _window_start(days)
    today = datetime.now(timezone.utc).date()

    total_users = (
        await db.execute(select(func.count(User.id)))
    ).scalar_one()

    window_row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageDaily.messages_sent), 0),
                func.coalesce(func.sum(UsageDaily.prompt_tokens), 0),
                func.coalesce(func.sum(UsageDaily.completion_tokens), 0),
                func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0),
                func.count(func.distinct(UsageDaily.user_id)),
            ).where(UsageDaily.day >= start.date())
        )
    ).one()

    today_row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageDaily.messages_sent), 0),
                func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0),
            ).where(UsageDaily.day == today)
        )
    ).one()

    return AnalyticsSummary(
        window_days=days,
        total_users=int(total_users or 0),
        active_users_window=int(window_row[4] or 0),
        messages_today=int(today_row[0] or 0),
        messages_window=int(window_row[0] or 0),
        prompt_tokens_window=int(window_row[1] or 0),
        completion_tokens_window=int(window_row[2] or 0),
        total_tokens_window=int((window_row[1] or 0) + (window_row[2] or 0)),
        cost_usd_today=_micros_to_usd(today_row[1]),
        cost_usd_window=_micros_to_usd(window_row[3]),
    )


@router.get(
    "/analytics/timeseries",
    response_model=list[AnalyticsTimeseriesPoint],
)
async def analytics_timeseries(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AnalyticsTimeseriesPoint]:
    """Daily totals for the trend chart.

    Sums across users by day. Days with no usage are omitted (the
    frontend fills the gaps so the X axis stays continuous), which
    keeps the payload tiny on a quiet instance.
    """
    start = _window_start(days)
    rows = (
        await db.execute(
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
    ).all()

    return [
        AnalyticsTimeseriesPoint(
            day=datetime.combine(r[0], datetime.min.time(), tzinfo=timezone.utc),
            messages=int(r[1] or 0),
            prompt_tokens=int(r[2] or 0),
            completion_tokens=int(r[3] or 0),
            cost_usd=_micros_to_usd(r[4]),
        )
        for r in rows
    ]


@router.get(
    "/analytics/users",
    response_model=list[AnalyticsUserRow],
)
async def analytics_users(
    days: int = Query(default=30, ge=1, le=180),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AnalyticsUserRow]:
    """Per-user roll-up sorted by cost desc, then tokens desc.

    Joins ``users`` so a row with zero usage in the window still
    surfaces (left join) — handy for the admin to spot inactive
    accounts. Sort puts the costliest users first; ties broken by
    token volume so two zero-cost users still come back in a
    stable order.
    """
    start = _window_start(days)

    # Sub-aggregate per user inside the window so we can left-join
    # against the user table without fanning the user row count out.
    sub = (
        select(
            UsageDaily.user_id.label("user_id"),
            func.coalesce(func.sum(UsageDaily.messages_sent), 0).label("messages"),
            func.coalesce(func.sum(UsageDaily.prompt_tokens), 0).label("prompt_tokens"),
            func.coalesce(func.sum(UsageDaily.completion_tokens), 0).label("completion_tokens"),
            func.coalesce(func.sum(UsageDaily.cost_usd_micros), 0).label("cost_micros"),
            func.max(UsageDaily.updated_at).label("last_active"),
        )
        .where(UsageDaily.day >= start.date())
        .group_by(UsageDaily.user_id)
        .subquery()
    )

    stmt = (
        select(
            User.id,
            User.username,
            User.email,
            func.coalesce(sub.c.messages, 0),
            func.coalesce(sub.c.prompt_tokens, 0),
            func.coalesce(sub.c.completion_tokens, 0),
            func.coalesce(sub.c.cost_micros, 0),
            sub.c.last_active,
        )
        .outerjoin(sub, sub.c.user_id == User.id)
        .order_by(
            func.coalesce(sub.c.cost_micros, 0).desc(),
            func.coalesce(sub.c.prompt_tokens + sub.c.completion_tokens, 0).desc(),
            User.username.asc(),
        )
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()

    return [
        AnalyticsUserRow(
            user_id=r[0],
            username=r[1],
            email=r[2],
            messages_window=int(r[3] or 0),
            prompt_tokens_window=int(r[4] or 0),
            completion_tokens_window=int(r[5] or 0),
            cost_usd_window=_micros_to_usd(r[6]),
            last_active_at=r[7],
        )
        for r in rows
    ]


@router.get(
    "/analytics/by-model",
    response_model=list[AnalyticsModelRow],
)
async def analytics_by_model(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AnalyticsModelRow]:
    """Per-model breakdown.

    There's no model column on ``usage_daily`` — usage is rolled per
    user, not per model — so we count assistant messages and sum
    token / cost columns straight from the ``messages`` table joined
    to ``conversations``. Bounded to the requested window via
    ``messages.created_at`` and grouped by ``conversations.model_id``.
    """
    start = _window_start(days)

    is_assistant = case((Message.role == "assistant", 1), else_=0)
    stmt = (
        select(
            func.coalesce(Conversation.model_id, "unknown"),
            func.coalesce(func.sum(is_assistant), 0),
            func.coalesce(func.sum(Message.prompt_tokens), 0),
            func.coalesce(func.sum(Message.completion_tokens), 0),
            func.coalesce(func.sum(Message.cost_usd_micros), 0),
        )
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Message.created_at >= start)
        .group_by(Conversation.model_id)
        .order_by(func.coalesce(func.sum(Message.cost_usd_micros), 0).desc())
    )
    rows = (await db.execute(stmt)).all()

    return [
        AnalyticsModelRow(
            model_id=str(r[0]),
            messages_window=int(r[1] or 0),
            prompt_tokens_window=int(r[2] or 0),
            completion_tokens_window=int(r[3] or 0),
            cost_usd_window=_micros_to_usd(r[4]),
        )
        for r in rows
    ]


# --------------------------------------------------------------------
# Per-user drill-down
# --------------------------------------------------------------------
@router.get(
    "/analytics/users/{user_id}/timeseries",
    response_model=list[AnalyticsTimeseriesPoint],
)
async def analytics_user_timeseries(
    user_id: uuid.UUID,
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AnalyticsTimeseriesPoint]:
    """Single-user trend, used in the per-user drill-down dialog."""
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")

    start = _window_start(days)
    rows = (
        await db.execute(
            select(
                UsageDaily.day,
                UsageDaily.messages_sent,
                UsageDaily.prompt_tokens,
                UsageDaily.completion_tokens,
                UsageDaily.cost_usd_micros,
            )
            .where(
                (UsageDaily.user_id == user_id) & (UsageDaily.day >= start.date())
            )
            .order_by(UsageDaily.day.asc())
        )
    ).all()

    return [
        AnalyticsTimeseriesPoint(
            day=datetime.combine(r[0], datetime.min.time(), tzinfo=timezone.utc),
            messages=int(r[1] or 0),
            prompt_tokens=int(r[2] or 0),
            completion_tokens=int(r[3] or 0),
            cost_usd=_micros_to_usd(r[4]),
        )
        for r in rows
    ]


__all__ = ["router"]
