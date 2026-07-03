"""End-user usage & cost dashboard API (Phase 8).

The admin analytics endpoints (``admin/analytics.py``) expose the same
numbers fleet-wide; these are the self-scoped counterparts so a user can
see their own spend, token usage, and activity over time. Every endpoint
is hard-scoped to the caller via ``get_current_user`` — there is no
``user_id`` parameter, so one user can never read another's usage.

Read-only: nothing here enforces or mutates budgets. The quota figures
in the summary come from the same ``check_budget`` snapshot the chat path
runs before each message, so "used vs cap" shown here is exactly what
gates the user's next turn.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import AnalyticsModelRow, AnalyticsTimeseriesPoint
from app.auth.deps import get_current_user
from app.auth.models import User
from app.billing import aggregates
from app.billing.schemas import MyUsageSummary
from app.billing.usage import check_budget
from app.database import get_db
from app.paywall import entitlement_status

router = APIRouter()


@router.get("/entitlement")
async def entitlement(
    request: Request,
    _: User = Depends(get_current_user),
) -> dict:
    """Whether the caller's session is entitled, plus the raw feature/plan
    claims it carries. Deliberately on the always-open ``/api/usage`` prefix so
    it's reachable even when the paywall is enforcing — use it to confirm the
    token carries the feature BEFORE turning ``PAYWALL_ENFORCED`` on."""
    return await entitlement_status(request)


@router.get("/me/summary", response_model=MyUsageSummary)
async def my_usage_summary(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MyUsageSummary:
    """Headline window totals plus the caller's live quota posture."""
    start = aggregates.window_start(days)
    snapshot = await check_budget(db, user)
    messages, prompt, completion, cost_micros = await aggregates.window_totals(
        db, user_id=user.id, start=start
    )
    messages_today, cost_micros_today = await aggregates.today_totals(
        db, user_id=user.id
    )

    return MyUsageSummary(
        window_days=days,
        messages_window=messages,
        prompt_tokens_window=prompt,
        completion_tokens_window=completion,
        total_tokens_window=prompt + completion,
        cost_usd_window=aggregates.micros_to_usd(cost_micros),
        messages_today=messages_today,
        cost_usd_today=aggregates.micros_to_usd(cost_micros_today),
        daily_used=snapshot.daily_used,
        daily_cap=snapshot.daily_cap,
        monthly_used=snapshot.monthly_used,
        monthly_cap=snapshot.monthly_cap,
        verdict=snapshot.verdict,
        blocking_window=snapshot.blocking_window,
    )


@router.get("/me/timeseries", response_model=list[AnalyticsTimeseriesPoint])
async def my_usage_timeseries(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AnalyticsTimeseriesPoint]:
    """Per-day messages / tokens / cost for the caller's trend chart."""
    return await aggregates.timeseries(
        db, start=aggregates.window_start(days), user_id=user.id
    )


@router.get("/me/by-model", response_model=list[AnalyticsModelRow])
async def my_usage_by_model(
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AnalyticsModelRow]:
    """Per-model spend / token breakdown for the caller's own turns."""
    return await aggregates.by_model(
        db, start=aggregates.window_start(days), user_id=user.id
    )


__all__ = ["router"]
