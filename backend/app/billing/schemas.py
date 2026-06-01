"""Response schemas for the end-user usage dashboard (Phase 8).

The per-day trend and per-model breakdown reuse the existing
``AnalyticsTimeseriesPoint`` / ``AnalyticsModelRow`` shapes (see
``admin/schemas.py``) so the frontend can share one set of types and
chart components across the admin and user views. Only the headline
summary differs: the user view pairs the windowed totals with the
caller's own quota posture (effective caps + how close they are),
which the admin headline doesn't carry.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class MyUsageSummary(BaseModel):
    """Headline numbers + quota posture for the signed-in user.

    Window figures are summed off the ``usage_daily`` rollup for the
    requested ``window_days``. The quota block mirrors the pre-stream
    budget check the chat path runs, so "used vs cap" here matches what
    actually gates the user's next message. ``*_cap`` is ``None`` when
    the corresponding limit is unlimited.
    """

    window_days: int

    messages_window: int
    prompt_tokens_window: int
    completion_tokens_window: int
    total_tokens_window: int
    cost_usd_window: float

    messages_today: int
    cost_usd_today: float

    # Quota posture (resolved per-user override → app default → unlimited).
    daily_used: int
    daily_cap: int | None
    monthly_used: int
    monthly_cap: int | None
    verdict: Literal["ok", "warn", "blocked"]
    blocking_window: Literal["daily", "monthly"] | None


__all__ = ["MyUsageSummary"]
