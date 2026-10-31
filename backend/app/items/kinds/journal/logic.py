"""Journal maths: ordering, ranges, streaks, mood statistics, search,
the text chat reads, and reminders. Pure functions over the file's dict."""
from __future__ import annotations

import copy
import math
import re
from collections import Counter
from datetime import date, datetime, time, timedelta

from app.items.spec import ActionError, ItemContext, Reminder, text_now

from .models import DAY_RE, ENERGY_LABELS, FAMILY_OF, MOOD_LABELS

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def sort_key(e: dict) -> tuple:
    return (e.get("date", ""), e.get("time", ""), e.get("created_at") or "", e.get("id", ""))


def newest_first(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=sort_key, reverse=True)


def in_range(e: dict, start: str | None, end: str | None) -> bool:
    d = e.get("date", "")
    return (start is None or d >= start) and (end is None or d <= end)


def resolve_range(
    start: str | None, end: str | None, days: int | None, today: date, default_days: int | None
) -> tuple[str | None, str | None]:
    if days:
        end_d = date.fromisoformat(end) if end else today
        return (end_d - timedelta(days=days - 1)).isoformat(), end_d.isoformat()
    if start is None and end is None and default_days:
        return (today - timedelta(days=default_days - 1)).isoformat(), today.isoformat()
    return start, end


def excerpt(text: str, n: int = 200, around: str | None = None) -> str:
    t = " ".join((text or "").split())
    if around:
        i = t.lower().find(around.lower())
        if i > n // 3:
            t = "…" + t[i - n // 3 :]
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def mood_word(m: int | None) -> str:
    return f"{m} {MOOD_LABELS[m]}" if m else ""


# ------------------------------------------------------------------ streaks


def streaks(entries: list[dict], today: date) -> dict:
    """Current streak (consecutive days with an entry, ending today — or
    yesterday, so the day isn't "lost" before you've written), longest
    streak, and day counts."""
    days = sorted({e["date"] for e in entries if e.get("date")})
    if not days:
        return {"current": 0, "longest": 0, "days_written": 0, "wrote_today": False, "last_entry": None}
    parsed = [date.fromisoformat(d) for d in days]
    longest, run = 1, 1
    for a, b in zip(parsed, parsed[1:]):
        run = run + 1 if (b - a).days == 1 else 1
        longest = max(longest, run)
    present = set(parsed)
    cur = 0
    probe = today if today in present else today - timedelta(days=1)
    while probe in present:
        cur += 1
        probe -= timedelta(days=1)
    return {
        "current": cur,
        "longest": longest,
        "days_written": len(days),
        "wrote_today": today in present,
        "last_entry": days[-1],
    }


# --------------------------------------------------------------------- mood


def mood_stats(entries: list[dict]) -> dict:
    moods = [e["mood"] for e in entries if e.get("mood")]
    energies = [e["energy"] for e in entries if e.get("energy")]
    by_day: dict[str, list[int]] = {}
    for e in entries:
        if e.get("mood"):
            by_day.setdefault(e["date"], []).append(e["mood"])
    daily = [{"date": d, "mood": round(sum(v) / len(v), 2)} for d, v in sorted(by_day.items())]
    weekday: dict[str, list[float]] = {w: [] for w in WEEKDAYS}
    for row in daily:
        weekday[WEEKDAYS[date.fromisoformat(row["date"]).weekday()]].append(row["mood"])
    emotions = Counter(w for e in entries for w in e.get("emotions", []))
    families = Counter(FAMILY_OF.get(w, "other") for e in entries for w in e.get("emotions", []))
    tags = Counter(t for e in entries for t in e.get("tags", []))
    tag_mood = {}
    for t, n in tags.most_common(15):
        ms = [e["mood"] for e in entries if t in e.get("tags", []) and e.get("mood")]
        if len(ms) >= 2:
            tag_mood[t] = {"entries": n, "avg_mood": round(sum(ms) / len(ms), 2)}
    half = len(daily) // 2
    trend = None
    if len(daily) >= 6:
        first = sum(r["mood"] for r in daily[:half]) / half
        second = sum(r["mood"] for r in daily[half:]) / (len(daily) - half)
        trend = round(second - first, 2)
    return {
        "entries": len(entries),
        "entries_with_mood": len(moods),
        "avg_mood": round(sum(moods) / len(moods), 2) if moods else None,
        "mood_distribution": {MOOD_LABELS[k]: moods.count(k) for k in range(1, 6)},
        "avg_energy": round(sum(energies) / len(energies), 2) if energies else None,
        "best_days": [r["date"] for r in sorted(daily, key=lambda r: -r["mood"])[:3]],
        "hardest_days": [r["date"] for r in sorted(daily, key=lambda r: r["mood"])[:3]],
        "mood_change_first_to_second_half": trend,
        "mood_by_weekday": {w: (round(sum(v) / len(v), 2) if v else None) for w, v in weekday.items()},
        "top_emotions": dict(emotions.most_common(12)),
        "emotion_families": dict(families.most_common()),
        "top_tags": dict(tags.most_common(15)),
        "avg_mood_by_tag": tag_mood,
        "words": sum(e.get("word_count", 0) for e in entries),
        "daily_mood": daily[-120:],
    }


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def strength(r: float | None, n: int) -> str:
    if r is None:
        return "not enough variation to say"
    a = abs(r)
    word = "no real" if a < 0.1 else "a weak" if a < 0.3 else "a moderate" if a < 0.5 else "a strong"
    direction = "" if a < 0.1 else (" positive" if r > 0 else " negative")
    caveat = " (few days — treat as a hunch)" if n < 14 else ""
    return f"{word}{direction} association{caveat}"


# ------------------------------------------------------------------- search


def entry_haystack(e: dict) -> str:
    return " ".join(
        [
            e.get("title", ""),
            e.get("body", ""),
            " ".join(e.get("tags", [])),
            " ".join(e.get("emotions", [])),
            " ".join(e.get("gratitude", [])),
            e.get("location", ""),
            e.get("weather", ""),
        ]
    ).lower()


def matches(e: dict, query: str | None) -> bool:
    if not query:
        return True
    hay = entry_haystack(e)
    return all(w in hay for w in query.lower().replace("#", "").split())


def brief_entry(e: dict, n: int = 200, around: str | None = None) -> dict:
    out = {
        "id": e["id"],
        "date": e["date"],
        "time": e.get("time"),
        "title": e.get("title") or None,
        "mood": mood_word(e.get("mood")) or None,
        "energy": e.get("energy"),
        "emotions": e.get("emotions") or None,
        "tags": e.get("tags") or None,
        "starred": e.get("starred") or None,
        "ai_drafted": e.get("ai_drafted") or None,
        "ai_edited": e.get("ai_edited") or None,
        "words": e.get("word_count", 0),
        "excerpt": excerpt(e.get("body", ""), n, around) or None,
    }
    return {k: v for k, v in out.items() if v is not None}


# --------------------------------------------------------------------- text


def to_text(data: dict) -> str:
    """What normal chats, Drive search and other apps read. Deliberately an
    outline: dates, titles, moods, feelings, energy, tags and stars of recent
    entries, plus counts and the streak — and a short excerpt of each recent
    entry only when the person turns on Settings → "Let chats see short
    excerpts" (off by default). The full text is read only by this journal's
    own assistant."""
    entries = newest_first(data.get("entries", []))
    settings = data.get("settings", {}) or {}
    if not entries:
        return "A private journal — no entries yet."
    today = text_now().date()
    s = streaks(entries, today)
    recent30 = [e for e in entries if e["date"] >= (today - timedelta(days=29)).isoformat()]
    m30 = mood_stats(recent30)
    tags = Counter(t for e in entries for t in e.get("tags", []))
    lines = [
        f"Private journal: {len(entries)} entries on {s['days_written']} days, "
        f"{entries[-1]['date']} → {entries[0]['date']}; "
        f"{sum(e.get('word_count', 0) for e in entries):,} words. "
        f"Streak {s['current']} day(s), longest {s['longest']}.",
    ]
    if m30["avg_mood"] is not None:
        lines.append(
            f"Last 30 days: {m30['entries']} entries, average mood {m30['avg_mood']}/5"
            + (f", average energy {m30['avg_energy']}/5" if m30["avg_energy"] else "")
            + (f"; most felt: {', '.join(list(m30['top_emotions'])[:6])}" if m30["top_emotions"] else "")
            + "."
        )
    if tags:
        lines.append("Tags: " + ", ".join(f"#{t} ({n})" for t, n in tags.most_common(20)) + ".")
    lines.append("")
    lines.append("Recent entries (newest first):")
    share = bool(settings.get("share_excerpts", False))
    for e in entries[:60]:
        bits = [f"{e['date']} {e.get('time', '')}".strip()]
        if e.get("title"):
            bits.append(f"“{e['title']}”")
        if e.get("mood"):
            emo = f" ({', '.join(e['emotions'][:4])})" if e.get("emotions") else ""
            bits.append(f"mood {mood_word(e['mood'])}{emo}")
        if e.get("energy"):
            bits.append(f"energy {e['energy']} {ENERGY_LABELS[e['energy']]}")
        if e.get("tags"):
            bits.append(" ".join(f"#{t}" for t in e["tags"][:8]))
        if e.get("starred"):
            bits.append("★")
        line = "- " + " · ".join(bits)
        if share and e.get("body"):
            line += f" — {excerpt(e['body'], 140)}"
        lines.append(line)
    if len(entries) > 60:
        lines.append(f"(+{len(entries) - 60} older entries — open the journal to read them.)")
    lines.append("")
    lines.append(
        "This is an outline. The entries' text stays in the journal: only the journal's own assistant reads it"
        + (" (short excerpts above are shared by the person's choice)." if share else ".")
    )
    return "\n".join(lines)[:20_000]


# ------------------------------------------------------------------ archive


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    """Entries dated before ``before_day`` move to a new journal file; both
    files keep the templates and settings (the archive's reminders are off,
    so the person isn't nudged twice)."""
    if not re.match(DAY_RE, before_day or ""):
        raise ActionError("Pick a day (YYYY-MM-DD) to archive before.")
    entries = data.get("entries", [])
    old = [e for e in entries if e.get("date", "") < before_day]
    if not old:
        raise ActionError(f"There are no entries before {before_day} to archive.")
    kept = {**data, "entries": [e for e in entries if e.get("date", "") >= before_day]}
    settings = copy.deepcopy(data.get("settings") or {})
    settings.update({"daily_reminder": False, "weekly_reminder": False, "onboarded": True})
    archived = {
        "entries": copy.deepcopy(old),
        "templates": copy.deepcopy(data.get("templates", [])),
        "settings": settings,
    }
    return kept, archived


# ---------------------------------------------------------------- reminders

_NUDGES = [
    "A few quiet minutes for you — how was today, really?",
    "What's one moment from today worth keeping?",
    "Name one thing you're grateful for, and why.",
    "What took your energy today, and what gave it back?",
    "Write a line or two — a short entry still counts.",
    "What's on your mind as the day winds down?",
    "What would you like to remember about today a year from now?",
]


def _at(day: date, hhmm: str, ctx: ItemContext) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(h, m), tzinfo=ctx.tz)


def is_reflection(e: dict) -> bool:
    return e.get("template_id") == "weekly-reflection" or "weekly" in (e.get("tags") or [])


def wrote_reflection(entries: list[dict], day: date) -> bool:
    """A weekly reflection in the seven days ending on ``day``."""
    start = (day - timedelta(days=6)).isoformat()
    end = day.isoformat()
    return any(is_reflection(e) and start <= e.get("date", "") <= end for e in entries)


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    s = data.get("settings", {}) or {}
    written = {e["date"] for e in data.get("entries", [])}
    out: list[Reminder] = []
    today = ctx.today
    for i in range(8):
        day = today + timedelta(days=i)
        iso = day.isoformat()
        if s.get("daily_reminder"):
            due = _at(day, s.get("reminder_time") or "21:00", ctx)
            if due > ctx.now and iso not in written:
                out.append(
                    Reminder(
                        key=f"journal:daily:{iso}",
                        due_at=due,
                        title="Time to journal",
                        body=_NUDGES[day.toordinal() % len(_NUDGES)],
                    )
                )
        if s.get("weekly_reminder") and day.weekday() == int(s.get("weekly_day", 6)):
            due = _at(day, s.get("weekly_time") or "18:00", ctx)
            if due > ctx.now and not wrote_reflection(data.get("entries", []), day):
                out.append(
                    Reminder(
                        key=f"journal:weekly:{iso}",
                        due_at=due,
                        title="Your weekly reflection",
                        body="Look back on the week: highlights, what was hard, and an intention for the next.",
                    )
                )
    return out
