"""Token usage rollup + budget enforcement (Phase 3.2).

Three public surfaces, all keyed off the ``usage_daily`` table:

* ``record_usage`` — called once per finished stream, folds the
  provider-reported token counts into the ``(user, today)`` rollup
  row using a single PostgreSQL ``INSERT ... ON CONFLICT DO UPDATE``
  upsert. Race-free across uvicorn workers because the conflict
  resolution happens inside the database.
* ``check_budget`` — called before the stream is enqueued. Returns
  the user's current daily/monthly totals + their effective caps and
  a verdict: ``"ok"``, ``"warn"`` (>=80% of monthly), or
  ``"blocked"`` (>=100% of either window).
* ``maybe_alert_admins`` — fires a one-shot warning email to every
  admin when ``check_budget`` first reports ``"warn"`` for a user in
  a given month. The "we already mailed about user X for YYYY-MM"
  bookkeeping lives in ``app_settings.budget_alerts_sent``.

Caps resolution mirrors ``files.quota``: per-user override on
``users.{daily,monthly}_token_budget`` wins; falls back to
``app_settings.default_{daily,monthly}_token_budget``; ``None`` means
unlimited.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.billing.models import UsageDaily

logger = logging.getLogger("promptly.billing")

# 80 % of the *monthly* cap is the threshold at which we email admins.
# Daily caps don't get a warning email because they reset every 24 h —
# an over-quota daily alert fires often enough to be noise rather than
# signal.
_WARN_THRESHOLD = 0.80

BudgetVerdict = Literal["ok", "warn", "blocked"]


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    """One user's spend posture at a single moment.

    ``daily_*`` and ``monthly_*`` are always real numbers; the cap
    fields are ``None`` when the corresponding limit is "unlimited".
    """

    daily_used: int
    daily_cap: int | None
    monthly_used: int
    monthly_cap: int | None
    verdict: BudgetVerdict
    # Which window failed, populated when verdict ∈ {"warn", "blocked"}.
    # ``"daily"``, ``"monthly"``, or ``None``.
    blocking_window: Literal["daily", "monthly"] | None = None


# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------
def _today_utc() -> date:
    """All windows roll on UTC midnight so a user near the IDL can't
    juke the cap by hopping timezones."""
    return datetime.now(timezone.utc).date()


def _month_start(d: date) -> date:
    return date(d.year, d.month, 1)


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


async def _settings(db: AsyncSession) -> AppSettings | None:
    return await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)


async def _effective_caps(
    db: AsyncSession, user: User
) -> tuple[int | None, int | None]:
    """Return ``(daily_cap, monthly_cap)`` after override resolution."""
    settings_row = await _settings(db)
    daily = user.daily_token_budget
    if daily is None and settings_row is not None:
        daily = settings_row.default_daily_token_budget
    monthly = user.monthly_token_budget
    if monthly is None and settings_row is not None:
        monthly = settings_row.default_monthly_token_budget
    return daily, monthly


async def _window_totals(
    db: AsyncSession, user_id: uuid.UUID, today: date
) -> tuple[int, int]:
    """Return ``(daily_total, monthly_total)`` summed off ``usage_daily``.

    Both queries hit the composite PK / range index, so even users with
    a million message-days come back in O(rows in the current month).
    """
    # Daily — direct PK lookup.
    daily_row = await db.execute(
        select(
            func.coalesce(UsageDaily.prompt_tokens, 0)
            + func.coalesce(UsageDaily.completion_tokens, 0)
        ).where(
            UsageDaily.user_id == user_id,
            UsageDaily.day == today,
        )
    )
    daily_total = int(daily_row.scalar() or 0)

    # Monthly — range scan over the current calendar month.
    monthly_row = await db.execute(
        select(
            func.coalesce(
                func.sum(UsageDaily.prompt_tokens + UsageDaily.completion_tokens),
                0,
            )
        ).where(
            UsageDaily.user_id == user_id,
            UsageDaily.day >= _month_start(today),
            UsageDaily.day <= today,
        )
    )
    monthly_total = int(monthly_row.scalar() or 0)

    return daily_total, monthly_total


# --------------------------------------------------------------------
# Pre-stream: budget check
# --------------------------------------------------------------------
async def check_budget(db: AsyncSession, user: User) -> BudgetSnapshot:
    """Snapshot the user's current spend + verdict.

    Verdict logic (evaluated in this order — first hit wins):

    * ``blocked`` if today's total ≥ ``daily_cap`` (cap not None).
    * ``blocked`` if this month's total ≥ ``monthly_cap`` (cap not None).
    * ``warn``    if this month's total ≥ 80 % of ``monthly_cap``.
    * ``ok``      otherwise.

    The pre-send check is *strictly greater than or equal* on the cap
    so a user who's exactly at 100 % can't slip one more turn through.
    """
    today = _today_utc()
    daily_cap, monthly_cap = await _effective_caps(db, user)
    daily_used, monthly_used = await _window_totals(db, user.id, today)

    verdict: BudgetVerdict = "ok"
    blocking: Literal["daily", "monthly"] | None = None

    if daily_cap is not None and daily_used >= daily_cap:
        verdict = "blocked"
        blocking = "daily"
    elif monthly_cap is not None and monthly_used >= monthly_cap:
        verdict = "blocked"
        blocking = "monthly"
    elif (
        monthly_cap is not None
        and monthly_used >= int(monthly_cap * _WARN_THRESHOLD)
    ):
        verdict = "warn"
        blocking = "monthly"

    return BudgetSnapshot(
        daily_used=daily_used,
        daily_cap=daily_cap,
        monthly_used=monthly_used,
        monthly_cap=monthly_cap,
        verdict=verdict,
        blocking_window=blocking,
    )


# --------------------------------------------------------------------
# Post-stream: roll usage into the cache table
# --------------------------------------------------------------------
async def record_usage(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    cost_usd: float | None = None,
    day: date | None = None,
) -> None:
    """Fold one stream's usage into ``usage_daily``.

    ``None`` token counts (sloppy provider, OpenAI sometimes drops
    ``usage`` mid-stream) become 0 — we still bump the message
    counter so the admin "messages today" column stays honest.

    ``cost_usd`` is converted to integer micros (1 = $0.000001) before
    rollup so the SUM stays exact. ``None`` becomes 0 for the same
    reason as the token columns. The caller computes the dollar
    figure from provider-reported pricing (OpenRouter returns it in
    the stream metadata; for direct providers we estimate from the
    model price table).

    Implemented as a single Postgres upsert so two concurrent streams
    for the same user can't lose updates to a SELECT-then-UPDATE race.
    """
    when = day or _today_utc()
    pt = max(0, int(prompt_tokens or 0))
    ct = max(0, int(completion_tokens or 0))
    cost_micros = max(0, int(round((cost_usd or 0.0) * 1_000_000)))

    stmt = (
        pg_insert(UsageDaily)
        .values(
            user_id=user_id,
            day=when,
            prompt_tokens=pt,
            completion_tokens=ct,
            messages_sent=1,
            cost_usd_micros=cost_micros,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "day"],
            set_={
                "prompt_tokens": UsageDaily.prompt_tokens + pt,
                "completion_tokens": UsageDaily.completion_tokens + ct,
                "messages_sent": UsageDaily.messages_sent + 1,
                "cost_usd_micros": UsageDaily.cost_usd_micros + cost_micros,
                "updated_at": func.now(),
            },
        )
    )
    await db.execute(stmt)
    # Caller decides when to commit — we usually piggy-back on the
    # ``await db.commit()`` that persists the assistant message.


# --------------------------------------------------------------------
# Admin alerting (80 % warn, one mail per user per month)
# --------------------------------------------------------------------
def _mark_alerted(
    sent_map: dict, user_id: uuid.UUID, month_key: str
) -> bool:
    """Update the in-memory bookkeeping. Returns True if this is the
    first alert for ``user_id`` in ``month_key`` (caller should send).
    """
    key = str(user_id)
    entry = sent_map.get(key) or {}
    if entry.get("monthly") == month_key:
        return False
    entry["monthly"] = month_key
    sent_map[key] = entry
    return True


async def maybe_alert_admins(
    db: AsyncSession,
    *,
    user: User,
    snapshot: BudgetSnapshot,
) -> bool:
    """Send the 80 % warning email if we haven't already this month.

    Returns ``True`` when an email was actually dispatched. Returns
    ``False`` (and does nothing) when:

    * ``snapshot.verdict != "warn"`` — nothing to alert about.
    * The admin already received a warning for this user this month.
    * SMTP isn't configured — we log a debug line and bail; the chat
      flow keeps working, it just doesn't get a notification.
    * The send raises — we swallow + log so an SMTP outage can't
      take down the chat.
    """
    if snapshot.verdict != "warn" or snapshot.monthly_cap is None:
        return False

    settings_row = await _settings(db)
    if settings_row is None or not settings_row.smtp_configured:
        logger.debug(
            "Budget warn for user=%s but SMTP isn't configured; skipping alert",
            user.id,
        )
        return False

    today = _today_utc()
    month_key = _month_key(today)

    # Mutate a *copy* so SQLAlchemy notices the change. JSONB columns
    # don't track in-place mutation (the dict object identity is the
    # same after a ``["k"] = v`` write), so without the reassignment
    # the row would never be flagged dirty and the bookkeeping would
    # be lost.
    sent_map = dict(settings_row.budget_alerts_sent or {})
    if not _mark_alerted(sent_map, user.id, month_key):
        return False

    # Look up every admin email *before* we attempt the send so a
    # missed admin doesn't leave the bookkeeping in a "we alerted"
    # state with nobody to receive it.
    admin_rows = (
        await db.execute(select(User).where(User.role == "admin"))
    ).scalars().all()
    admin_emails = [a.email for a in admin_rows if a.email]
    if not admin_emails:
        logger.warning("Budget warn for user=%s but no admins are configured", user.id)
        return False

    # Build the mail body before persisting the bookkeeping change so
    # an exception here doesn't leave us thinking we already alerted.
    pct = (
        int(snapshot.monthly_used / snapshot.monthly_cap * 100)
        if snapshot.monthly_cap
        else 0
    )
    subject = f"[Promptly] {user.username} is at {pct}% of monthly token budget"
    body = (
        f"Hello,\n\n"
        f"User '{user.username}' ({user.email}) has used "
        f"{snapshot.monthly_used:,} of their {snapshot.monthly_cap:,} "
        f"token monthly budget ({pct}%).\n\n"
        f"Daily usage today: {snapshot.daily_used:,}"
        + (
            f" / {snapshot.daily_cap:,}\n"
            if snapshot.daily_cap is not None
            else " (no daily cap)\n"
        )
        + f"\nWindow: {month_key} (UTC).\n\n"
        f"You can adjust per-user budgets from the Admin → Users panel.\n"
        f"\n— Promptly\n"
    )

    # Lazy-import to avoid pulling aiosmtplib into anything that
    # imports billing.usage but doesn't actually send mail.
    from app.mfa.smtp import (  # noqa: PLC0415
        SmtpNotConfiguredError,
        SmtpSendError,
        send_message,
    )

    sent_any = False
    for email in admin_emails:
        try:
            await send_message(db, to=email, subject=subject, text_body=body)
            sent_any = True
        except (SmtpNotConfiguredError, SmtpSendError) as e:
            logger.warning("Could not deliver budget alert to %s: %s", email, e)
        except Exception:  # noqa: BLE001
            logger.exception("Unexpected error delivering budget alert to %s", email)

    if sent_any:
        # Persist the bookkeeping update so subsequent turns don't
        # re-alert for the same period.
        settings_row.budget_alerts_sent = sent_map
    return sent_any


__all__ = [
    "BudgetSnapshot",
    "BudgetVerdict",
    "check_budget",
    "maybe_alert_admins",
    "record_usage",
]
