"""Per-user ambient context block injected into the chat system prompt.

The point of this module is to let the model "just know" the user's
current local date/time and rough location *without* reading like the
user retold it every turn. The block is phrased as background context
rather than as a user statement, and we explicitly tell the model not
to call attention to where it came from — no "since you mentioned
you're in Australia…" style re-narration.

Wired into the chat router via :func:`build_personal_context_prompt`.
Returns ``None`` when the user hasn't filled in any personal context
yet, so the existing system-prompt path stays unchanged for those
users (no empty header, no wasted tokens).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.auth.models import User

# Hard-cap on the values we'll ever read out of ``user.settings`` — the
# Pydantic schema already enforces this on write but the JSONB column
# is open-ended at the DB level, so we belt-and-brace here too. A
# malicious or legacy oversized value would otherwise blow up the
# system prompt.
_MAX_LOCATION_CHARS = 120
_MAX_CURRENCY_CHARS = 8


def _safe_zone(tz: str | None) -> ZoneInfo | None:
    if not tz:
        return None
    try:
        return ZoneInfo(tz)
    except ZoneInfoNotFoundError:
        # Defensive: a bad value snuck past validation (e.g. a manual
        # DB edit). Fall back to "no timezone" rather than crashing
        # mid-stream.
        return None


def _format_local_now(zone: ZoneInfo) -> tuple[str, str, str]:
    """Return ``(date_line, time_line, abbreviation)`` for ``zone``.

    Split into separate lines because the prompt reads more naturally
    that way ("Today: …\nLocal time: …") and it keeps each fact short
    enough to survive aggressive context-window pressure.
    """
    now = datetime.now(zone)
    # ``%A, %d %B %Y`` → "Saturday, 18 April 2026". Friendly across
    # locales and unambiguous — avoids the US/EU month-day mix-up.
    date_str = now.strftime("%A, %d %B %Y")
    # 12h with am/pm reads more naturally for casual queries ("what
    # time is it?") than 24h. Strip the leading zero on Windows-vs-
    # Unix safe path: ``%I`` always gives a zero-padded hour, so we
    # lstrip the result.
    time_str = now.strftime("%I:%M %p").lstrip("0")
    abbr = now.strftime("%Z") or ""
    return date_str, time_str, abbr


def build_personal_context_prompt(user: User) -> str:
    """Return the ambient-context block for ``user`` — always non-empty.

    The **current date/time is always included** (in the user's timezone if
    they set one, otherwise UTC) — knowing what day it is is a universal system
    fact, not a personal preference, and gating it on settings meant a user who
    never filled them in got no temporal anchor at all and answered as if it
    were still the model's training-cutoff year. Locale rules (currency, units,
    spelling, date format) stay gated on ``location`` / ``timezone`` /
    ``currency`` being set, since those genuinely are personal and shouldn't be
    guessed.
    """
    settings: Mapping[str, object] = user.settings or {}
    raw_location = settings.get("location")
    raw_timezone = settings.get("timezone")
    raw_currency = settings.get("currency")

    location = (
        raw_location.strip()[:_MAX_LOCATION_CHARS]
        if isinstance(raw_location, str) and raw_location.strip()
        else ""
    )
    zone = _safe_zone(raw_timezone if isinstance(raw_timezone, str) else None)
    currency = (
        raw_currency.strip().upper()[:_MAX_CURRENCY_CHARS]
        if isinstance(raw_currency, str) and raw_currency.strip()
        else ""
    )

    lines: list[str] = []
    lines.append(
        "Ambient context (background facts you already know — treat as known, "
        "don't repeat back to the user):"
    )
    # Date/time — ALWAYS present. Local when we have a timezone, else UTC.
    if zone is not None:
        date_str, time_str, abbr = _format_local_now(zone)
        lines.append(f"- Today's date: {date_str}")
        tz_label = f"{abbr}, " if abbr else ""
        lines.append(f"- Local time: {time_str} ({tz_label}{zone.key})")
    else:
        utc_now = datetime.now(timezone.utc)
        lines.append(f"- Today's date: {utc_now.strftime('%A, %d %B %Y')} (UTC)")
        lines.append(
            f"- Current time: {utc_now.strftime('%I:%M %p').lstrip('0')} UTC"
        )
    if location:
        lines.append(f"- User location: {location}")
    if currency:
        lines.append(f"- Preferred currency: {currency}")
    lines.append("")

    # Locale-application rules only make sense when there's a locale to apply.
    has_locale = bool(location or currency or zone is not None)
    if not has_locale:
        lines.append(
            "When the user asks for the date/time or anything time-sensitive, "
            "anchor on the values above — never say you don't know the current "
            "date, and don't fall back to your training cutoff. Treat your own "
            "knowledge as potentially out of date for recent events. Don't call "
            "attention to having this context."
        )
        return "\n".join(lines)
    # When the user has set an explicit currency, that's authoritative —
    # it overrides whatever the locale would imply, which is the whole
    # point (a user in one country may want prices in another currency).
    if currency:
        currency_rule = (
            f"currency — quote ALL prices in {currency} by default, "
            "regardless of locale; convert from foreign sources and note "
            "the original amount + currency"
        )
    else:
        currency_rule = (
            "currency (prices in the user's local currency, e.g. AUD for "
            "Australia, GBP for the UK; convert from foreign sources when "
            "needed and note the original)"
        )
    lines.append(
        "How to use this context:\n"
        f"1. Apply local conventions by DEFAULT — {currency_rule}, "
        "measurement units (metric vs imperial), "
        "spelling (en-AU/en-GB vs en-US), date format (DD/MM/YYYY in "
        "AU/UK, MM/DD/YYYY in the US), 12h vs 24h time, and any "
        "region-specific norms (tax, public holidays, business "
        "hours, road rules, electrical sockets, etc.).\n"
        "2. When the user asks for the date, the time, or anything "
        "time-sensitive, anchor on the values above — do not say "
        "you don't know.\n"
        "3. Do NOT call attention to having this information, do NOT "
        "thank the user for sharing it, and do NOT repeat it back "
        "unless the user explicitly asks. Just behave as if you "
        "already knew."
    )

    return "\n".join(lines)


__all__ = ["build_personal_context_prompt"]
