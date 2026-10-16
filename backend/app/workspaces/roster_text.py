"""Roster schedule → text for chat context and search (R-174).

The roster's RAG text used to be whatever the last editor's browser
pushed — undated beyond weekday + day, the whole history, and the live
draft rather than what had been published. This renders it server-side:
a window around today (two weeks back, eight ahead), ISO dates with the
year, the published version when there is one, and names resolved from
the workspace's members.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

WINDOW_BACK_DAYS = 14
WINDOW_AHEAD_DAYS = 56


def visible_shifts(data: Any, *, for_admin: bool) -> list[dict]:
    """The shifts a person sees: the published snapshot for non-admins once
    the roster has been published, the live draft otherwise."""
    data = data if isinstance(data, dict) else {}
    if not for_admin and isinstance(data.get("published_shifts"), list):
        return [s for s in data["published_shifts"] if isinstance(s, dict)]
    return [s for s in (data.get("shifts") or []) if isinstance(s, dict)]


def _shift_line(s: dict, names: dict[str, str]) -> str:
    who = names.get(str(s.get("personId") or ""), str(s.get("personName") or s.get("personId") or "Unassigned"))
    if s.get("timed") and s.get("start") and s.get("end"):
        when = f"{s['start']}–{s['end']}"
        if s.get("hours") is not None:
            when += f" ({s['hours']}h)"
    else:
        when = f"{s.get('hours') or 0}h"
    bits = [f"{who} {when}"]
    if s.get("note"):
        bits.append(str(s["note"])[:200])
    return " · ".join(bits)


def flatten_roster(
    title: str,
    data: Any,
    names: dict[str, str],
    today: date | None = None,
) -> str:
    """Readable schedule text for ``title``'s roster around ``today``."""
    data = data if isinstance(data, dict) else {}
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    published = isinstance(data.get("published_shifts"), list)
    shifts = visible_shifts(data, for_admin=not published)
    today = today or date.today()
    start = today - timedelta(days=WINDOW_BACK_DAYS)
    end = today + timedelta(days=WINDOW_AHEAD_DAYS)
    by_day: dict[date, list[dict]] = defaultdict(list)
    for s in shifts:
        try:
            d = date.fromisoformat(str(s.get("date") or ""))
        except ValueError:
            continue
        if start <= d <= end:
            by_day[d].append(s)
    status = "published"
    if published and settings.get("publishedAt"):
        status = f"published {str(settings['publishedAt'])[:10]}"
    elif not published:
        status = "draft (not yet published)"
    lines = [
        f"# Roster: {title} ({status})",
        f"Shifts from {start.isoformat()} to {end.isoformat()}; today is {today.isoformat()}.",
        "",
    ]
    if not by_day:
        lines.append("No shifts in this period.")
        return "\n".join(lines)
    hours: dict[str, float] = defaultdict(float)
    for d in sorted(by_day):
        day_shifts = sorted(by_day[d], key=lambda s: str(s.get("start") or ""))
        label = d.strftime("%a %d %b %Y")
        lines.append(f"## {label} ({d.isoformat()})")
        for s in day_shifts:
            lines.append(f"- {_shift_line(s, names)}")
            if d >= today and d < today + timedelta(days=7):
                who = names.get(str(s.get("personId") or ""), str(s.get("personId") or ""))
                try:
                    hours[who] += float(s.get("hours") or 0)
                except (TypeError, ValueError):
                    pass
        lines.append("")
    if hours:
        lines.append("## Hours in the next 7 days")
        for who, h in sorted(hours.items()):
            lines.append(f"- {who}: {h:g}h")
    return "\n".join(lines).rstrip()


def shift_signature(s: dict) -> tuple:
    return (
        str(s.get("date") or ""),
        str(s.get("start") or ""),
        str(s.get("end") or ""),
        str(s.get("hours") or ""),
        str(s.get("note") or ""),
    )


def publish_diff(old: list[dict], new: list[dict]) -> dict[str, dict[str, int]]:
    """Per person: shifts added and removed (a change counts as both) in
    the newly published version vs the last one."""
    def by_person(rows):
        out: dict[str, set] = defaultdict(set)
        for s in rows:
            out[str(s.get("personId") or "")].add(shift_signature(s))
        return out

    a, b = by_person(old), by_person(new)
    diff: dict[str, dict[str, int]] = {}
    for pid in set(a) | set(b):
        added = len(b.get(pid, set()) - a.get(pid, set()))
        removed = len(a.get(pid, set()) - b.get(pid, set()))
        if (added or removed) and pid:
            diff[pid] = {"added": added, "removed": removed}
    return diff


def upcoming_for(person_id: str, shifts: list[dict], today: date | None = None, days: int = 56) -> list[dict]:
    today = today or date.today()
    end = today + timedelta(days=days)
    out = []
    for s in shifts:
        if str(s.get("personId") or "") != person_id:
            continue
        try:
            d = date.fromisoformat(str(s.get("date") or ""))
        except ValueError:
            continue
        if today <= d <= end:
            out.append(s)
    return sorted(out, key=lambda s: (str(s.get("date")), str(s.get("start") or "")))


def shift_bounds(s: dict, zone) -> tuple[datetime, datetime, bool]:
    """``(start, end, all_day)`` in ``zone`` for a calendar entry."""
    d = date.fromisoformat(str(s["date"]))
    if s.get("timed") and s.get("start") and s.get("end"):
        sh, sm = (int(x) for x in str(s["start"]).split(":")[:2])
        eh, em = (int(x) for x in str(s["end"]).split(":")[:2])
        st = datetime(d.year, d.month, d.day, sh, sm, tzinfo=zone)
        en = datetime(d.year, d.month, d.day, eh, em, tzinfo=zone)
        if en <= st:
            en += timedelta(days=1)  # an overnight shift
        return st, en, False
    st = datetime(d.year, d.month, d.day, tzinfo=zone)
    return st, st + timedelta(days=1), True
