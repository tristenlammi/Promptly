"""The file as plain text — what chat, search and Drive AI read."""
from __future__ import annotations

from datetime import timedelta

from app.items.spec import text_now

from . import engine as E

MAX_CHARS = 20_000

TOD = {"morning": "morning", "afternoon": "afternoon", "evening": "evening", "anytime": "any time"}


def _pct(v: float | None) -> str:
    return "–" if v is None else f"{round(v * 100)}%"


def _marks(h: dict, today, ws: int) -> str:
    """The last 14 days, oldest → newest: ✓ done, · missed, s skipped, - not due, ? today pending."""
    logs = E.logs_by_day(h)
    start = E.start_of(h)
    out = []
    for i in range(13, -1, -1):
        d = today - timedelta(days=i)
        log = logs.get(d)
        if start is None or d < start:
            out.append(" ")
        elif E.is_skipped(log):
            out.append("s")
        elif E.is_met(v := E.config_on(h, d), log, d, today) and (log is not None or v.get("type") == "avoid"):
            out.append("✓")
        elif not E.is_flexible(v) and not E.is_due(v, d, start):
            out.append("-")
        elif d == today:
            out.append("?")
        else:
            out.append("·")
    return "".join(out)


def to_text(data: dict) -> str:
    s = data.get("settings") or {}
    boundary = int(s.get("day_ends_at") or 0)
    ws = int(s.get("week_start") or 0)
    today = E.logical_today(text_now(), boundary)
    habits = data.get("habits", [])
    live = [h for h in habits if not h.get("archived")]
    lines: list[str] = []
    lines.append(
        f"Habit tracker — {len(live)} active habit{'s' if len(live) != 1 else ''}"
        f"{f', {len(habits) - len(live)} archived' if len(habits) > len(live) else ''}. "
        f"Week starts {E.WEEKDAY_NAMES[ws]}; day ends at {boundary:02d}:00."
    )
    if live:
        pd = E.perfect_days(data, today)
        lines.append(f"Perfect days: {pd['total']} in all, {pd['last_30']} in the last 30, current run {pd['current_streak']}.")
    lines.append("")
    for h in live:
        st = E.habit_stats(h, today, ws)
        head = f"## {h.get('emoji') + ' ' if h.get('emoji') else ''}{h['name']}"
        meta = [E.describe_goal(h) if h.get("type") != "yes_no" else None, E.describe_schedule(h), TOD.get(h.get("time_of_day", "anytime"))]
        if h.get("area"):
            meta.append(h["area"])
        if h.get("type") == "avoid":
            meta.insert(0, "quitting")
        lines.append(f"{head} ({', '.join(m for m in meta if m)})")
        if h.get("intention"):
            lines.append(f"Plan: {h['intention']}")
        if h.get("identity"):
            lines.append(f"Identity: {h['identity']}")
        if h.get("why"):
            lines.append(f"Why: {h['why'][:300]}")
        lines.append(
            f"Streak {st['current_streak']} {st['streak_unit']} (best {st['best_streak']}); "
            f"strength {st['score']:.0f}/100 ({st['score_change_30d']:+.0f} in 30 d); "
            f"done {_pct(st['rate_7d'])} last 7 d, {_pct(st['rate_30d'])} last 30 d, {_pct(st['rate_all'])} all time; "
            f"last done {st['last_done'] or 'never'}."
        )
        if h.get("type") == "avoid":
            lines.append(f"Clean for {st.get('clean_days', 0)} days; last slip {st.get('last_slip') or 'none'}.")
        lines.append(f"Last 14 days: [{_marks(h, today, ws)}]")
        notes = [log for log in reversed(h.get("logs", [])) if log.get("note")][:5]
        for log in notes:
            lines.append(f"  {log['day']}: {log['note'][:200]}")
        if h.get("history"):
            last = h["history"][-1]
            lines.append(f"Set-up changed {len(h['history'])}× (current rules since {last['until']}; earlier days keep their old rules).")
        if h.get("reminders"):
            lines.append(f"Reminders: {', '.join(h['reminders'])}")
        lines.append("")
    arch = [h for h in habits if h.get("archived")]
    if arch:
        lines.append("Archived: " + ", ".join(h["name"] for h in arch))
        lines.append("")
    for r in reversed(data.get("reviews", [])[-6:]):
        bits = [f"Week of {r['week']} review:"]
        for k, label in (("wins", "Wins"), ("misses", "Misses"), ("focus", "Focus"), ("notes", "Notes"), ("insights", "Insights")):
            if r.get(k):
                bits.append(f"{label}: {r[k][:600]}")
        if len(bits) > 1:
            lines.append("\n".join(bits))
            lines.append("")
    return "\n".join(lines).strip()[:MAX_CHARS]
