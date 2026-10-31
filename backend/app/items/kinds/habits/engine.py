"""Habit maths: what's due, streaks, completion rates, the habit-strength
score, weekday breakdowns and perfect days. Pure functions over the file's
JSON (plain dicts), so actions, reminders and ``to_text`` share one truth.

The frontend mirrors this file in ``frontend/src/items/kinds/habits/engine.ts``
— change both together.

Rules
-----
* A habit's history starts on its ``start_date`` (else the day it was
  created, else its first log) and ends on ``end_date`` (if set). Days
  outside that don't exist for it.
* **Eras**: when a habit's schedule, type or goal changes, the old set-up is
  kept in ``history`` with the day it stopped applying (``until``). Every
  day is judged under the rules it had — editing never rewrites the past.
* **every N days** counts from ``anchor_date`` (else the start), so a
  backfill before the start never shifts the cadence.
* **Day-based** schedules (daily, weekdays, every N days): each due day is
  *done*, *missed*, *skipped* (neutral) or, for today, *pending* (neutral
  until it's done — today never breaks a streak). Streaks count due days.
* **Period-based** schedules (X per week / per month): each week or month
  is the unit. A period is *done* when its met days reach the requirement;
  the current one is *pending* while it can still be reached. Skipped days
  shrink the requirement proportionally (``ceil(times × available / days)``),
  so a skipped week is neutral and a skipped day or two is forgiven fairly.
  Streaks count periods.
* **Avoid** habits succeed when the day's slips stay within ``limit``. A
  past day with nothing logged counts as clean; today counts once it's
  confirmed (a log with 0 slips), otherwise it's pending.
* **Strength score** follows Loop Habit Tracker: an exponential moving
  average, ``score = score·m + value·(1 − m)`` with ``m = 0.5^(√f / 13)`` per
  day for frequency ``f`` (times per day). Day-based schedules step once
  per due day with the equivalent per-occurrence multiplier
  ``0.5^(1 / (13·√f))`` (the same half-life in calendar days); period
  schedules step daily on a rolling-window value. Partial counts score
  partially; skipped days and a not-yet-done today leave it unchanged.
"""
from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import date, datetime, timedelta

DONE = "done"
MISSED = "missed"
SKIPPED = "skipped"
PENDING = "pending"
OFF = "off"  # not due that day
NEUTRAL = "neutral"  # a period with nothing required (all skipped)

FLEXIBLE = ("per_week", "per_month")
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ------------------------------------------------------------------ days


def parse_day(s: str) -> date:
    return date.fromisoformat(s[:10])


def logical_today(now: datetime, day_ends_at: int = 0) -> date:
    """Today as the person counts it: before ``day_ends_at`` o'clock it's
    still yesterday."""
    return (now - timedelta(hours=int(day_ends_at or 0))).date()


def logical_day_of(moment: str, day_ends_at: int = 0) -> date | None:
    try:
        dt = datetime.fromisoformat(moment)
    except (TypeError, ValueError):
        return None
    return logical_today(dt, day_ends_at)


def days(a: date, b: date) -> Iterable[date]:
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def week_start_of(day: date, week_start: int = 0) -> date:
    return day - timedelta(days=(day.weekday() - week_start) % 7)


def month_end(day: date) -> date:
    nxt = date(day.year + (day.month == 12), day.month % 12 + 1, 1)
    return nxt - timedelta(days=1)


def period_of(day: date, kind: str, week_start: int = 0) -> tuple[date, date]:
    if kind == "per_month":
        first = day.replace(day=1)
        return first, month_end(day)
    first = week_start_of(day, week_start)
    return first, first + timedelta(days=6)


# ----------------------------------------------------------------- habits

# The fields that decide what a day "needs". When they change, the old ones
# are kept in ``history`` (an era per change) so past days keep their rules.
CONFIG_KEYS = ("type", "target", "limit", "schedule", "anchor_date")


def is_flexible(h: dict) -> bool:
    return h.get("schedule", {}).get("kind") in FLEXIBLE


def start_of(h: dict) -> date | None:
    if h.get("start_date"):
        return parse_day(h["start_date"])
    cands: list[date] = []
    if h.get("created_at"):
        try:
            cands.append(parse_day(h["created_at"]))
        except ValueError:
            pass
    if h.get("logs"):
        cands.append(parse_day(h["logs"][0]["day"]))
    return min(cands) if cands else None


def end_of(h: dict) -> date | None:
    try:
        return parse_day(h["end_date"]) if h.get("end_date") else None
    except ValueError:
        return None


def anchor_of(h: dict, start: date | None) -> date | None:
    """Where an every-N-days cadence counts from: ``anchor_date``, else the start."""
    if h.get("anchor_date"):
        try:
            return parse_day(h["anchor_date"])
        except ValueError:
            pass
    return start


def eras(h: dict) -> list[tuple[dict, date | None, date | None]]:
    """``(view, first, last)`` per stretch of the habit's life with one set of
    rules — ``view`` is the habit as it was set up then (``first`` None =
    from the start, ``last`` None = still running). Oldest first."""
    end = end_of(h)
    out: list[tuple[dict, date | None, date | None]] = []
    lo: date | None = None
    for e in sorted(h.get("history") or [], key=lambda x: x.get("until", "")):
        try:
            until = parse_day(e["until"])
        except (KeyError, ValueError):
            continue
        hi = until - timedelta(days=1)
        if end is not None and hi > end:
            hi = end
        view = {**h, **{k: e.get(k, h.get(k)) for k in CONFIG_KEYS}, "history": []}
        if lo is None or hi >= lo:
            out.append((view, lo, hi))
        lo = until if lo is None else max(lo, until)
    if end is None or lo is None or lo <= end:
        out.append(({**h, "history": []} if h.get("history") else h, lo, end))
    return out


MAX_ERAS = 60


def config_snapshot(h: dict) -> dict:
    """The rule fields as they are now (call before editing them)."""
    s = h.get("schedule") or {}
    return {
        "type": h.get("type", "yes_no"),
        "target": float(h.get("target") or 1),
        "limit": int(h.get("limit") or 0),
        "schedule": {"kind": s.get("kind", "daily"), "days": list(s.get("days") or []), "times": int(s.get("times") or 3), "every": int(s.get("every") or 2)},
        "anchor_date": h.get("anchor_date"),
    }


def _rules_key(c: dict) -> tuple:
    s = c["schedule"]
    kind = s["kind"]
    return (
        c["type"],
        1.0 if c["type"] == "yes_no" else float(c["target"]),
        int(c["limit"]) if c["type"] == "avoid" else 0,
        kind,
        tuple(sorted(s.get("days") or [])) if kind == "weekdays" else (),
        int(s.get("times") or 0) if kind in FLEXIBLE else 0,
        int(s.get("every") or 0) if kind == "every_n_days" else 0,
    )


def note_config_change(h: dict, before: dict, today: date, apply_to_past: bool = False) -> str | None:
    """After ``h``'s rule fields were edited (``before`` = their snapshot):
    keep the old rules for the days before ``today`` as an era, so the past
    isn't re-judged. ``apply_to_past`` drops all eras instead (fixing a
    habit set up wrong). Returns ``"from_today"``, ``"rewrote_past"`` or
    None (nothing that matters changed)."""
    after = config_snapshot(h)
    if _rules_key(before) == _rules_key(after):
        return None
    start = start_of(h)
    if apply_to_past:
        h["history"] = []
        return "rewrote_past"
    if start is None or start >= today:
        return None  # no past days to protect
    old_s, new_s = before["schedule"], after["schedule"]
    anchor = anchor_of(h, start)
    hist = h.setdefault("history", [])
    if not (hist and hist[-1].get("until", "") >= today.isoformat()):
        # (Edited twice today: the first edit's rules never judged a past day.)
        hist.append({**before, "until": today.isoformat(), "anchor_date": before.get("anchor_date") or (anchor.isoformat() if anchor else None)})
        hist.sort(key=lambda e: e["until"])
        while len(hist) > MAX_ERAS:
            hist.pop(0)  # the oldest era merges into the next one
    if new_s["kind"] == "every_n_days" and (old_s["kind"] != "every_n_days" or old_s["every"] != new_s["every"]):
        h["anchor_date"] = today.isoformat()  # the new cadence starts today
    elif not h.get("anchor_date") and anchor:
        h["anchor_date"] = anchor.isoformat()
    return "from_today"


def backfill_start(h: dict, day: str, skipped: bool) -> None:
    """Logging a day before the start moves the start back — but never the
    every-N-days cadence (frozen in ``anchor_date``)."""
    start = h.get("start_date")
    if start and day < start and not skipped:
        if not h.get("anchor_date"):
            h["anchor_date"] = start
        h["start_date"] = day


def last_day(h: dict, today: date) -> date:
    end = end_of(h)
    return min(today, end) if end else today


def day_views(h: dict, today: date) -> list[tuple[date, dict]]:
    """Every day from the start to today (or the end) with the rules that
    applied that day."""
    start = start_of(h)
    if start is None:
        return []
    last = last_day(h, today)
    es = eras(h)
    if start > last or not es:
        return []
    out: list[tuple[date, dict]] = []
    i = 0
    for d in days(start, last):
        while i < len(es) - 1 and es[i][2] is not None and d > es[i][2]:
            i += 1
        out.append((d, es[i][0]))
    return out


def config_on(h: dict, day: date) -> dict:
    """The habit as it was set up on ``day``."""
    for view, lo, hi in eras(h):
        if (lo is None or day >= lo) and (hi is None or day <= hi):
            return view
    return h


def logs_by_day(h: dict) -> dict[date, dict]:
    out: dict[date, dict] = {}
    for log in h.get("logs", []):
        try:
            out[parse_day(log["day"])] = log
        except (KeyError, ValueError):
            continue
    return out


def is_due(h: dict, day: date, start: date | None) -> bool:
    """Day-based: is ``day`` one of its days? Period-based: any day counts."""
    if start is None or day < start:
        return False
    s = h.get("schedule", {})
    kind = s.get("kind", "daily")
    if kind == "weekdays":
        return day.weekday() in (s.get("days") or [])
    if kind == "every_n_days":
        anchor = anchor_of(h, start) or start
        return (day - anchor).days % max(2, int(s.get("every") or 2)) == 0
    return True


def fraction(h: dict, log: dict | None, day: date, today: date) -> float:
    """How much of the day's goal the log reaches, 0..1."""
    if h.get("type") == "avoid":
        return 1.0 if is_met(h, log, day, today) else 0.0
    if log is None or log.get("skipped"):
        return 0.0
    v = float(log.get("value") or 0)
    if h.get("type", "yes_no") == "yes_no":
        return 1.0 if v > 0 else 0.0
    target = float(h.get("target") or 1)
    return max(0.0, min(1.0, v / target))


def is_met(h: dict, log: dict | None, day: date, today: date) -> bool:
    if log is not None and log.get("skipped"):
        return False
    t = h.get("type", "yes_no")
    if t == "avoid":
        if log is None:
            return day < today
        return float(log.get("value") or 0) <= int(h.get("limit") or 0)
    if log is None:
        return False
    v = float(log.get("value") or 0)
    if t == "yes_no":
        return v > 0
    return v >= float(h.get("target") or 1) - 1e-9


def is_skipped(log: dict | None) -> bool:
    return bool(log and log.get("skipped"))


def is_failed(h: dict, log: dict | None) -> bool:
    """Already lost for the day, however it ends: an avoid habit's slips
    went past its limit. (A count short of its target can still be met.)"""
    return (
        h.get("type") == "avoid"
        and log is not None
        and not log.get("skipped")
        and float(log.get("value") or 0) > int(h.get("limit") or 0)
    )


def is_final(h: dict, log: dict | None, day: date, today: date) -> bool:
    """Is the day settled? Past days always; today once met or failed."""
    return day < today or is_met(h, log, day, today) or is_failed(h, log)


# --------------------------------------------------------- day-based units


def _day_status(v: dict, d: date, start: date | None, today: date, logs: dict[date, dict]) -> str:
    """One day under a day-based set of rules ``v``."""
    if not is_due(v, d, start):
        return OFF
    log = logs.get(d)
    if is_skipped(log):
        return SKIPPED
    if is_met(v, log, d, today):
        return DONE
    if d == today and not is_failed(v, log):
        return PENDING
    return MISSED


def _flex_day_status(v: dict, d: date, today: date, logs: dict[date, dict]) -> str:
    """A day under X-per-week/month rules: no single day is required."""
    log = logs.get(d)
    if is_skipped(log):
        return SKIPPED
    return DONE if log is not None and is_met(v, log, d, today) else OFF


def day_statuses(h: dict, today: date, logs: dict[date, dict] | None = None) -> list[tuple[date, str]]:
    """(day, status) from the start to today, each day under the rules it
    had (days under an X-per-week era are done / skipped / off)."""
    start = start_of(h)
    logs = logs if logs is not None else logs_by_day(h)
    return [
        (d, _flex_day_status(v, d, today, logs) if is_flexible(v) else _day_status(v, d, start, today, logs))
        for d, v in day_views(h, today)
    ]


# ------------------------------------------------------ period-based units


def _era_periods(v: dict, first: date, cap: date | None, today: date, week_start: int, logs: dict[date, dict]) -> list[dict]:
    """The weeks / months of one X-per-period era running ``first``..``cap``
    (None = still running). Days outside it aren't available."""
    kind = v["schedule"]["kind"]
    times = int(v["schedule"].get("times") or 1)
    out: list[dict] = []
    last = min(today, cap) if cap else today
    p_start, p_end = period_of(first, kind, week_start)
    while p_start <= last:
        length = (p_end - p_start).days + 1
        available = 0
        done = 0
        left = 0
        for d in days(p_start, p_end):
            if d < first or (cap is not None and d > cap):
                continue
            log = logs.get(d)
            if is_skipped(log):
                continue
            available += 1
            if d <= today and is_met(v, log, d, today):
                done += 1
            elif d > today or (d == today and not is_failed(v, log)):
                left += 1
        required = min(times, available, math.ceil(times * available / length - 1e-9))
        current = p_start <= today <= p_end and (cap is None or cap >= today)
        if required <= 0:
            status = NEUTRAL
        elif done >= required:
            status = DONE
        elif current and done + left >= required:
            status = PENDING
        else:
            status = MISSED
        out.append(
            {
                "start": p_start,
                "end": p_end,
                "required": required,
                "done": done,
                "left": left if current else 0,
                "status": status,
            }
        )
        p_start = p_end + timedelta(days=1)
        p_end = period_of(p_start, kind, week_start)[1]
    return out


def _era_spans(h: dict, today: date) -> list[tuple[dict, date, date | None]]:
    """Eras that overlap the habit's life up to today: ``(view, first, cap)``."""
    start = start_of(h)
    if start is None:
        return []
    last = last_day(h, today)
    out = []
    for v, lo, hi in eras(h):
        first = max(start, lo) if lo else start
        if first > last or (hi is not None and hi < first):
            continue
        out.append((v, first, hi))
    return out


def periods(h: dict, today: date, week_start: int = 0, logs: dict[date, dict] | None = None) -> list[dict]:
    """Each week / month from the start to the current one (eras with an
    X-per-period schedule only): ``{start, end, required, done, left,
    status}`` (``left`` = days still open in the current period, today
    included if not yet met)."""
    logs = logs if logs is not None else logs_by_day(h)
    out: list[dict] = []
    for v, first, cap in _era_spans(h, today):
        if is_flexible(v):
            out.extend(_era_periods(v, first, cap, today, week_start, logs))
    return out


# ------------------------------------------------------------------ streaks


def streaks(statuses: Iterable[str]) -> tuple[int, int]:
    """(current, best) over chronological statuses: DONE extends, MISSED
    breaks, everything else (skipped, off, pending, neutral) passes."""
    seq = list(statuses)
    best = run = 0
    for s in seq:
        if s == DONE:
            run += 1
            best = max(best, run)
        elif s == MISSED:
            run = 0
    current = 0
    for s in reversed(seq):
        if s == DONE:
            current += 1
        elif s == MISSED:
            break
    return current, best


def unit_statuses(h: dict, today: date, week_start: int = 0, logs: dict[date, dict] | None = None) -> list[str]:
    """Streak units in order: periods for X-per-period eras, days otherwise."""
    logs = logs if logs is not None else logs_by_day(h)
    start = start_of(h)
    out: list[str] = []
    for v, first, cap in _era_spans(h, today):
        if is_flexible(v):
            out.extend(p["status"] for p in _era_periods(v, first, cap, today, week_start, logs))
        else:
            last = min(today, cap) if cap else today
            out.extend(_day_status(v, d, start, today, logs) for d in days(first, last))
    return out


def streak_unit(h: dict) -> str:
    kind = h.get("schedule", {}).get("kind")
    return "weeks" if kind == "per_week" else "months" if kind == "per_month" else "days"


# -------------------------------------------------------------------- rates


def completion_rate(
    h: dict, today: date, window: int | None, week_start: int = 0, logs: dict[date, dict] | None = None
) -> float | None:
    """Share of what was expected that got done, over the last ``window``
    days (None = all time). Skipped and pending don't count against it."""
    lo = today - timedelta(days=window - 1) if window else date.min
    logs = logs if logs is not None else logs_by_day(h)
    start = start_of(h)
    got = need = 0
    for v, first, cap in _era_spans(h, today):
        if is_flexible(v):
            for p in _era_periods(v, first, cap, today, week_start, logs):
                if p["end"] < lo or p["status"] == NEUTRAL:
                    continue
                if p["status"] == DONE:
                    got += p["required"]
                    need += p["required"]
                elif p["status"] == MISSED:
                    got += p["done"]
                    need += p["required"]
                else:  # pending: what's done so far counts, the rest isn't due yet
                    got += min(p["done"], p["required"])
                    need += min(p["done"], p["required"])
            continue
        last = min(today, cap) if cap else today
        for d in days(max(first, lo), last):
            s = _day_status(v, d, start, today, logs)
            if s == DONE:
                got += 1
                need += 1
            elif s == MISSED:
                need += 1
    return round(got / need, 4) if need else None


# -------------------------------------------------------------------- score


def frequency(h: dict) -> float:
    s = h.get("schedule", {})
    kind = s.get("kind", "daily")
    if kind == "weekdays":
        return max(1, len(s.get("days") or [])) / 7
    if kind == "every_n_days":
        return 1 / max(2, int(s.get("every") or 2))
    if kind == "per_week":
        return min(7, int(s.get("times") or 1)) / 7
    if kind == "per_month":
        return min(31, int(s.get("times") or 1)) / 30.44
    return 1.0


def score_series(h: dict, today: date, logs: dict[date, dict] | None = None) -> list[tuple[date, float]]:
    """The strength score (0..1) at the end of every day from the start,
    each day stepped under the rules it had."""
    start = start_of(h)
    logs = logs if logs is not None else logs_by_day(h)
    dv = day_views(h, today)
    met = {d for d, v in dv if is_flexible(v) and is_met(v, logs.get(d), d, today)}
    out: list[tuple[date, float]] = []
    s = 0.0
    for d, v in dv:
        log = logs.get(d)
        f = frequency(v)
        if is_flexible(v):
            if is_skipped(log) or not is_final(v, log, d, today):
                out.append((d, s))
                continue
            m = 0.5 ** (math.sqrt(f) / 13)
            window = 7 if v["schedule"]["kind"] == "per_week" else 30
            times = int(v["schedule"].get("times") or 1)
            n = sum(1 for k in range(window) if d - timedelta(days=k) in met)
            s = s * m + min(1.0, n / times) * (1 - m)
            out.append((d, s))
            continue
        if not is_due(v, d, start) or is_skipped(log) or not is_final(v, log, d, today):
            out.append((d, s))
            continue
        m = 0.5 ** (1 / (13 * math.sqrt(f)))
        s = s * m + fraction(v, log, d, today) * (1 - m)
        out.append((d, s))
    return out


def score(h: dict, today: date, logs: dict[date, dict] | None = None) -> float:
    series = score_series(h, today, logs)
    return series[-1][1] if series else 0.0


# ------------------------------------------------------------- breakdowns


def weekday_breakdown(h: dict, today: date, logs: dict[date, dict] | None = None) -> list[dict]:
    """Per weekday (Mon…Sun): done / expected and the rate."""
    rows = [{"weekday": WEEKDAYS[i], "done": 0, "total": 0} for i in range(7)]
    logs = logs if logs is not None else logs_by_day(h)
    start = start_of(h)
    for d, v in day_views(h, today):
        log = logs.get(d)
        r = rows[d.weekday()]
        if is_flexible(v):
            if is_skipped(log) or not is_final(v, log, d, today):
                continue
            r["total"] += 1
            if is_met(v, log, d, today):
                r["done"] += 1
            continue
        s = _day_status(v, d, start, today, logs)
        if s in (DONE, MISSED):
            r["total"] += 1
            r["done"] += s == DONE
    return [{**r, "rate": round(r["done"] / r["total"], 4) if r["total"] else None} for r in rows]


def active(data: dict) -> list[dict]:
    return [h for h in data.get("habits", []) if not h.get("archived")]


def perfect_days(data: dict, today: date) -> dict:
    """Days on which every due (day-based, active) habit was done. Today
    counts once it's perfect; until then it doesn't break the run."""
    per_day: dict[date, list[str]] = {}
    for h in active(data):
        if is_flexible(h):
            continue
        for d, s in day_statuses(h, today):
            if s in (DONE, MISSED, PENDING):
                per_day.setdefault(d, []).append(s)
    ordered = sorted(per_day)
    flags: list[tuple[date, str]] = []
    for d in ordered:
        ss = per_day[d]
        if all(s == DONE for s in ss):
            flags.append((d, DONE))
        elif d == today and MISSED not in ss:
            flags.append((d, PENDING))
        else:
            flags.append((d, MISSED))
    # Days with nothing due pass (neither perfect nor a break).
    cur, best = streaks(s for _, s in flags)
    perfect = [d for d, s in flags if s == DONE]
    return {
        "total": len(perfect),
        "current_streak": cur,
        "best_streak": best,
        "last_30": sum(1 for d in perfect if d > today - timedelta(days=30)),
        "today": dict(flags).get(today),
    }


# ----------------------------------------------------------------- today


def today_status(h: dict, today: date, week_start: int = 0, logs: dict[date, dict] | None = None) -> dict:
    """What today looks like for one habit: due? done? progress?"""
    logs = logs if logs is not None else logs_by_day(h)
    start = start_of(h)
    log = logs.get(today)
    out: dict = {
        "due": False,
        "done": is_met(h, log, today, today),
        "skipped": is_skipped(log),
        "value": float(log["value"]) if log and not log.get("skipped") else 0.0,
    }
    end = end_of(h)
    if start is None or start > today or (end is not None and end < today):
        return out
    if is_flexible(h):
        ps = periods(h, today, week_start, logs)
        p = ps[-1] if ps else None
        if p:
            out["period"] = {
                "done": p["done"],
                "required": p["required"],
                "left": p["left"],
                "status": p["status"],
                "start": p["start"].isoformat(),
                "end": p["end"].isoformat(),
            }
            out["due"] = p["status"] == PENDING and not out["skipped"]
    else:
        out["due"] = is_due(h, today, start) and not out["skipped"]
    return out


def describe_schedule(h: dict) -> str:
    s = h.get("schedule", {})
    kind = s.get("kind", "daily")
    if kind == "weekdays":
        ds = s.get("days") or []
        if ds == [0, 1, 2, 3, 4]:
            return "weekdays"
        if ds == [5, 6]:
            return "weekends"
        return ", ".join(WEEKDAYS[d] for d in ds)
    if kind == "per_week":
        return f"{s.get('times', 1)}× a week"
    if kind == "per_month":
        return f"{s.get('times', 1)}× a month"
    if kind == "every_n_days":
        return f"every {s.get('every', 2)} days"
    return "every day"


def describe_goal(h: dict) -> str:
    t = h.get("type", "yes_no")
    unit = h.get("unit") or ""
    if t == "count":
        return f"{fmt(h.get('target', 1))} {unit or 'times'}".strip()
    if t == "duration":
        return f"{fmt(h.get('target', 1))} min"
    if t == "avoid":
        lim = int(h.get("limit") or 0)
        return "avoid completely" if lim == 0 else f"at most {lim} {unit or 'times'}"
    return "done"


def fmt(n: float | int | None) -> str:
    if n is None:
        return "–"
    f = float(n)
    return str(int(f)) if f.is_integer() else f"{f:.1f}"


def habit_stats(h: dict, today: date, week_start: int = 0) -> dict:
    """Everything worth knowing about one habit, as numbers."""
    logs = logs_by_day(h)
    units = unit_statuses(h, today, week_start, logs)
    cur, best = streaks(units)
    series = score_series(h, today, logs)
    sc = series[-1][1] if series else 0.0
    month_ago = today - timedelta(days=30)
    prev = next((v for d, v in reversed(series) if d <= month_ago), 0.0) if series else 0.0
    views = dict(day_views(h, today))
    met_days = [d for d, log in logs.items() if d <= today and is_met(views.get(d, h), log, d, today) and log is not None]
    slips = [
        d
        for d, log in logs.items()
        if views.get(d, h).get("type") == "avoid" and not log.get("skipped") and float(log.get("value") or 0) > 0
    ]
    start = start_of(h)
    out = {
        "id": h["id"],
        "name": h["name"],
        "type": h.get("type", "yes_no"),
        "goal": describe_goal(h),
        "schedule": describe_schedule(h),
        "archived": bool(h.get("archived")),
        "start_date": start.isoformat() if start else None,
        "end_date": h.get("end_date"),
        "schedule_changes": len(h.get("history") or []),
        "current_streak": cur,
        "best_streak": best,
        "streak_unit": streak_unit(h),
        "score": round(sc * 100, 1),
        "score_change_30d": round((sc - prev) * 100, 1),
        "rate_7d": completion_rate(h, today, 7, week_start, logs),
        "rate_30d": completion_rate(h, today, 30, week_start, logs),
        "rate_90d": completion_rate(h, today, 90, week_start, logs),
        "rate_all": completion_rate(h, today, None, week_start, logs),
        "times_done": len(met_days),
        "last_done": max(met_days).isoformat() if met_days else None,
        "skipped_days": sum(1 for log in logs.values() if log.get("skipped")),
        "weekdays": weekday_breakdown(h, today, logs),
        "today": today_status(h, today, week_start, logs),
    }
    if h.get("type") == "avoid":
        out["slip_days"] = len(slips)
        out["last_slip"] = max(slips).isoformat() if slips else None
        clean_since = (max(slips) + timedelta(days=1)) if slips else start
        out["clean_days"] = max(0, (last_day(h, today) - clean_since).days) if clean_since else 0
    if h.get("type") in ("count", "duration"):
        vals = [float(log.get("value") or 0) for d, log in logs.items() if not log.get("skipped") and d > today - timedelta(days=30)]
        out["avg_30d"] = round(sum(vals) / len(vals), 2) if vals else None
    return out
