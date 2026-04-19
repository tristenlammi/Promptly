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

from datetime import datetime
from typing import Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.auth.models import User

# Hard-cap on the values we'll ever read out of ``user.settings`` — the
# Pydantic schema already enforces this on write but the JSONB column
# is open-ended at the DB level, so we belt-and-brace here too. A
# malicious or legacy oversized value would otherwise blow up the
# system prompt.
_MAX_LOCATION_CHARS = 120


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


def build_personal_context_prompt(user: User) -> str | None:
    """Return the ambient-context block for ``user`` or ``None``.

    Reads ``user.settings`` for ``location`` and ``timezone``. If
    neither is set, returns ``None`` and the caller leaves the system
    prompt untouched. If only one is set, the block degrades
    gracefully — e.g. a user who set a location but not a timezone
    still gets the location line, just no local-time line.
    """
    settings: Mapping[str, object] = user.settings or {}
    raw_location = settings.get("location")
    raw_timezone = settings.get("timezone")

    location = (
        raw_location.strip()[:_MAX_LOCATION_CHARS]
        if isinstance(raw_location, str) and raw_location.strip()
        else ""
    )
    zone = _safe_zone(raw_timezone if isinstance(raw_timezone, str) else None)

    if not location and zone is None:
        return None

    lines: list[str] = []
    # Lead with a meta line so the model parses the block as
    # background rather than as user-supplied content. The phrasing is
    # tuned over a few iterations:
    #
    #   * "treat as background knowledge" → the model parses it as
    #     ambient context, not a user statement to acknowledge.
    #   * "do not call attention / thank / repeat back" → kills the
    #     "I see you're in Sunshine Coast — based on that…" tic.
    #   * "actively apply local conventions" → the load-bearing
    #     sentence. Without it the model "knew" the user was in
    #     Australia but still quoted prices in USD, dates in MM/DD/
    #     YYYY, distances in miles, etc. The explicit "currency,
    #     units, spelling, date/time format" enumeration makes the
    #     defaulting unambiguous instead of leaving it to taste.
    lines.append(
        "Ambient personal context (background knowledge about the "
        "user's locale — treat as facts you already know):"
    )
    if zone is not None:
        date_str, time_str, abbr = _format_local_now(zone)
        lines.append(f"- Today: {date_str}")
        tz_label = f"{abbr}, " if abbr else ""
        lines.append(
            f"- Local time: {time_str} ({tz_label}{zone.key})"
        )
    if location:
        lines.append(f"- User location: {location}")
    lines.append("")
    lines.append(
        "How to use this context:\n"
        "1. Apply local conventions by DEFAULT — currency (prices in "
        "the user's local currency, e.g. AUD for Australia, GBP for "
        "the UK; convert from foreign sources when needed and note "
        "the original), measurement units (metric vs imperial), "
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
