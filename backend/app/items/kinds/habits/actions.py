"""The Habits item's actions — the assistant's (and chat's) hands.

Deterministic for (data, args, ctx.now): new ids come from the name (slug +
counter), moments from ``ctx.now``.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import engine as E
from . import importer
from .models import DAY, HEX, HHMM, MAX_HABITS, MAX_LOGS, HabitType, ScheduleKind, TimeOfDay

# ------------------------------------------------------------------ helpers


def _settings(data: dict) -> dict:
    return data.setdefault("settings", {})


def today_for(ctx: ItemContext, data: dict) -> date:
    return E.logical_today(ctx.now, int(_settings(data).get("day_ends_at") or 0))


def _week_start(data: dict) -> int:
    return int(_settings(data).get("week_start") or 0)


def _day(ctx: ItemContext, data: dict, s: str | None) -> date:
    if not s:
        return today_for(ctx, data)
    try:
        return E.parse_day(s)
    except ValueError as e:
        raise ActionError(f"{s!r} isn't a day (use YYYY-MM-DD).") from e


def find(data: dict, ref: str) -> dict:
    """A habit by id, else by name (exact, then unique partial match)."""
    ref = (ref or "").strip()
    habits = data.get("habits", [])
    for h in habits:
        if h["id"] == ref:
            return h
    low = ref.lower()
    exact = [h for h in habits if h["name"].lower() == low]
    if len(exact) == 1:
        return exact[0]
    part = [h for h in habits if low and low in h["name"].lower()]
    if len(part) == 1:
        return part[0]
    names = ", ".join(f"{h['name']} ({h['id']})" for h in habits[:40]) or "none yet"
    if len(part) > 1:
        raise ActionError(f"{ref!r} matches several habits — use the id. Habits: {names}")
    raise ActionError(f"No habit called {ref!r}. Habits: {names}")


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:30] or "habit"


def _new_id(data: dict, name: str) -> str:
    base = _slug(name)
    taken = {h["id"] for h in data.get("habits", [])}
    hid, n = base, 2
    while hid in taken:
        hid, n = f"{base}-{n}", n + 1
    return hid


def _label(h: dict) -> str:
    return f"{h.get('emoji') + ' ' if h.get('emoji') else ''}{h['name']}"


def _fmt_value(h: dict, v: float) -> str:
    t = h.get("type")
    if t == "duration":
        return f"{E.fmt(v)} min"
    if t == "count":
        return f"{E.fmt(v)}/{E.fmt(h.get('target'))}{(' ' + h['unit']) if h.get('unit') else ''}"
    if t == "avoid":
        return "clean" if v == 0 else f"{E.fmt(v)} slip{'s' if v != 1 else ''}"
    return "done"


# ------------------------------------------------------------- habit fields


class ScheduleIn(BaseModel):
    kind: ScheduleKind = Field(
        default="daily",
        description="daily | weekdays (on `days`) | per_week (`times` per week, any days) | "
        "per_month (`times` per calendar month) | every_n_days (every `every` days from the start date)",
    )
    days: list[int] = Field(default_factory=list, max_length=7, description="For weekdays: 0=Mon … 6=Sun")
    times: int = Field(default=3, ge=1, le=31, description="For per_week / per_month")
    every: int = Field(default=2, ge=2, le=365, description="For every_n_days")


class HabitFields(BaseModel):
    emoji: str | None = Field(default=None, max_length=16, description="One emoji, e.g. 💧")
    color: str | None = Field(default=None, pattern=HEX, description="Hex colour like #4E9F5B")
    area: str | None = Field(default=None, max_length=40, description="Life area: Health, Mind, Work…")
    type: HabitType | None = Field(
        default=None,
        description="yes_no (did it or not) | count (a number per day, e.g. 8 glasses) | "
        "duration (minutes per day) | avoid (a habit to quit: success = not doing it; log slips)",
    )
    target: float | None = Field(default=None, gt=0, le=100_000, description="count: per day; duration: minutes per day")
    unit: str | None = Field(default=None, max_length=24, description="count unit: glasses, pages, steps…")
    limit: int | None = Field(default=None, ge=0, le=1000, description="avoid: slips allowed per day (default 0)")
    schedule: ScheduleIn | None = None
    time_of_day: TimeOfDay | None = Field(default=None, description="morning | afternoon | evening | anytime")
    reminders: list[str] | None = Field(default=None, max_length=6, description="Reminder times, 24h HH:MM")
    start_date: str | None = Field(default=None, pattern=DAY, description="YYYY-MM-DD; default today")
    intention: str | None = Field(
        default=None, max_length=300, description="Implementation intention: 'After I pour my coffee, I will meditate for 1 minute'"
    )
    identity: str | None = Field(default=None, max_length=200, description="'I am someone who…'")
    why: str | None = Field(default=None, max_length=1000, description="Why it matters to them")
    notes: str | None = Field(default=None, max_length=2000)
    reminder_days: list[int] | None = Field(
        default=None, max_length=7, description="X-per-week/month habits: remind only on these weekdays (0=Mon…6=Sun); [] = any day"
    )
    remind_when_behind: bool | None = Field(
        default=None, description="X-per-week/month habits: remind only when behind the pace needed to hit the target"
    )


class NewHabit(HabitFields):
    name: str = Field(min_length=1, max_length=80, description="Short, concrete: 'Drink water', 'Read 10 pages'")


def _apply_fields(h: dict, p: HabitFields) -> None:
    for key in (
        "emoji", "color", "area", "type", "unit", "limit", "time_of_day", "intention", "identity", "why", "notes", "start_date",
        "remind_when_behind",
    ):
        v = getattr(p, key)
        if v is not None:
            h[key] = v
    if p.target is not None:
        h["target"] = p.target
    if p.schedule is not None:
        h["schedule"] = p.schedule.model_dump()
    if p.reminder_days is not None:
        h["reminder_days"] = sorted({d for d in p.reminder_days if 0 <= d <= 6})
    if p.reminders is not None:
        bad = [t for t in p.reminders if not re.match(HHMM, t)]
        if bad:
            raise ActionError(f"Reminder times must be HH:MM (24h): {bad}")
        h["reminders"] = sorted(set(p.reminders))
    if h.get("type") == "yes_no":
        h["target"] = 1
    elif h.get("type") == "duration" and p.target is None and float(h.get("target") or 1) <= 1:
        h["target"] = 10  # a sensible default: ten minutes


def _make(ctx: ItemContext, data: dict, p: NewHabit) -> dict:
    if len(data.get("habits", [])) >= MAX_HABITS:
        raise ActionError(f"A Habits file holds at most {MAX_HABITS} habits — archive or delete some first.")
    hid = _new_id(data, p.name)
    h: dict = {
        "id": hid,
        "name": p.name.strip(),
        "emoji": "",
        "color": "#7B6CD9",
        "area": "",
        "type": "yes_no",
        "target": 1,
        "unit": "",
        "limit": 0,
        "schedule": {"kind": "daily", "days": [], "times": 3, "every": 2},
        "time_of_day": "anytime",
        "reminders": [],
        "start_date": today_for(ctx, data).isoformat(),
        "archived": False,
        "intention": "",
        "identity": "",
        "why": "",
        "notes": "",
        "created_at": ctx.now.isoformat(),
        "logs": [],
    }
    _apply_fields(h, p)
    data.setdefault("habits", []).append(h)
    return h


def create_habit(ctx: ItemContext, data: dict, p: NewHabit) -> ActionOutcome:
    h = _make(ctx, data, p)
    return ActionOutcome(
        summary=f"Added {_label(h)} ({E.describe_schedule(h)})",
        result={"id": h["id"], "schedule": E.describe_schedule(h), "goal": E.describe_goal(h)},
    )


class NewHabits(BaseModel):
    habits: list[NewHabit] = Field(min_length=1, max_length=20)


def create_habits(ctx: ItemContext, data: dict, p: NewHabits) -> ActionOutcome:
    made = [_make(ctx, data, h) for h in p.habits]
    names = ", ".join(_label(h) for h in made)
    return ActionOutcome(summary=f"Added {len(made)} habit{'s' if len(made) != 1 else ''}: {names}", result={"ids": [h["id"] for h in made]})


class EditHabit(HabitFields):
    habit: str = Field(description="Habit id or name")
    name: str | None = Field(default=None, min_length=1, max_length=80)
    apply_to_past: bool = Field(
        default=False,
        description="Schedule/type/target changes normally apply from today on (past days keep the rules they had). "
        "True re-judges the whole history with the new set-up — only to fix a habit that was set up wrong from the start.",
    )


def edit_habit(ctx: ItemContext, data: dict, p: EditHabit) -> ActionOutcome:
    h = find(data, p.habit)
    before = E.config_snapshot(h)
    if p.name is not None:
        h["name"] = p.name.strip()
    _apply_fields(h, p)
    era = E.note_config_change(h, before, today_for(ctx, data), apply_to_past=p.apply_to_past)
    changed = sorted(k for k, v in p.model_dump(exclude={"habit", "apply_to_past"}).items() if v is not None)
    tail = {"from_today": " (from today on — past days keep their old rules)", "rewrote_past": " (the whole history now uses the new set-up)"}.get(era, "")
    return ActionOutcome(summary=f"Updated {_label(h)}{tail}", result={"id": h["id"], "changed": changed, "history": era})


class ArchiveHabit(BaseModel):
    habit: str = Field(description="Habit id or name")
    archived: bool = Field(default=True, description="False brings it back")


def archive_habit(ctx: ItemContext, data: dict, p: ArchiveHabit) -> ActionOutcome:
    h = find(data, p.habit)
    h["archived"] = p.archived
    return ActionOutcome(summary=f"{'Archived' if p.archived else 'Restored'} {_label(h)}", result={"id": h["id"]})


class DeleteHabit(BaseModel):
    habit: str = Field(description="Habit id or name")


def delete_habit(ctx: ItemContext, data: dict, p: DeleteHabit) -> ActionOutcome:
    h = find(data, p.habit)
    data["habits"] = [x for x in data["habits"] if x["id"] != h["id"]]
    return ActionOutcome(summary=f"Deleted {_label(h)} and its {len(h.get('logs', []))} logs", result={"id": h["id"]})


class Reorder(BaseModel):
    order: list[str] = Field(min_length=1, max_length=100, description="Habit ids (or names) in the new order; unlisted ones follow")


def reorder_habits(ctx: ItemContext, data: dict, p: Reorder) -> ActionOutcome:
    picked: list[dict] = []
    for ref in p.order:
        h = find(data, ref)
        if h not in picked:
            picked.append(h)
    ids = {h["id"] for h in picked}
    data["habits"] = picked + [h for h in data["habits"] if h["id"] not in ids]
    return ActionOutcome(summary="Reordered habits", result={"order": [h["id"] for h in data["habits"]]})


# --------------------------------------------------------------------- logs


def _put_log(h: dict, day: date, entry: dict) -> None:
    key = day.isoformat()
    logs = [x for x in h.get("logs", []) if x["day"] != key]
    if len(logs) >= MAX_LOGS:
        raise ActionError(
            f"{h['name']} already holds {MAX_LOGS} days of history — use “Archive older data” in the file menu "
            "to move old years into an archive file, then log again."
        )
    logs.append({"day": key, **entry})
    logs.sort(key=lambda x: x["day"])
    h["logs"] = logs
    E.backfill_start(h, key, bool(entry.get("skipped")))


def _get_log(h: dict, day: date) -> dict | None:
    key = day.isoformat()
    return next((x for x in h.get("logs", []) if x["day"] == key), None)


class LogEntry(BaseModel):
    habit: str = Field(description="Habit id or name")
    day: str | None = Field(default=None, pattern=DAY, description="YYYY-MM-DD (the person's day); default today")
    value: float | None = Field(
        default=None,
        ge=0,
        le=100_000,
        description="yes_no: omit. count: how many. duration: minutes. avoid: number of slips (0 = a clean day). "
        "Omitted = the full target (count/duration), done (yes_no), clean (avoid)",
    )
    add: bool = Field(default=False, description="Add `value` (default 1) to what's already logged that day instead of replacing it")
    note: str | None = Field(default=None, max_length=1000)


def _log_one(ctx: ItemContext, data: dict, p: LogEntry) -> tuple[dict, date, float]:
    h = find(data, p.habit)
    day = _day(ctx, data, p.day)
    today = today_for(ctx, data)
    if day > today:
        raise ActionError(f"{day.isoformat()} hasn't happened yet — only today or earlier can be logged (skips can be planned ahead).")
    t = h.get("type", "yes_no")
    old = _get_log(h, day)
    prev = float(old["value"]) if old and not old.get("skipped") else 0.0
    if p.add:
        value = prev + (p.value if p.value is not None else 1)
    elif p.value is not None:
        value = p.value
    else:
        value = 0.0 if t == "avoid" else (1.0 if t == "yes_no" else float(h.get("target") or 1))
    if t == "yes_no":
        value = 1.0 if value > 0 else 0.0
    note = p.note if p.note is not None else (old.get("note", "") if old else "")
    if t != "avoid" and value <= 0 and not note:
        if old:
            h["logs"] = [x for x in h["logs"] if x["day"] != day.isoformat()]
        return h, day, 0.0
    _put_log(h, day, {"value": value, "note": note, "skipped": False, "reason": "", "at": ctx.now.isoformat()})
    return h, day, value


def log_habit(ctx: ItemContext, data: dict, p: LogEntry) -> ActionOutcome:
    h, day, value = _log_one(ctx, data, p)
    when = "" if day == today_for(ctx, data) else f" on {day.isoformat()}"
    st = E.habit_stats(h, today_for(ctx, data), _week_start(data))
    return ActionOutcome(
        summary=f"{_label(h)}: {_fmt_value(h, value)}{when}",
        result={"id": h["id"], "day": day.isoformat(), "value": value, "current_streak": st["current_streak"], "streak_unit": st["streak_unit"]},
    )


class LogMany(BaseModel):
    entries: list[LogEntry] = Field(min_length=1, max_length=400)


def log_habits(ctx: ItemContext, data: dict, p: LogMany) -> ActionOutcome:
    done = [_log_one(ctx, data, e) for e in p.entries]
    names = sorted({_label(h) for h, _, _ in done})
    return ActionOutcome(
        summary=f"Logged {len(done)} entr{'ies' if len(done) != 1 else 'y'} ({', '.join(names[:5])}{'…' if len(names) > 5 else ''})",
        result=[{"id": h["id"], "day": d.isoformat(), "value": v} for h, d, v in done],
    )


class Unlog(BaseModel):
    habit: str = Field(description="Habit id or name")
    day: str | None = Field(default=None, pattern=DAY, description="YYYY-MM-DD; default today")


def unlog_habit(ctx: ItemContext, data: dict, p: Unlog) -> ActionOutcome:
    h = find(data, p.habit)
    day = _day(ctx, data, p.day)
    if _get_log(h, day) is None:
        raise ActionError(f"Nothing is logged for {h['name']} on {day.isoformat()}.")
    h["logs"] = [x for x in h["logs"] if x["day"] != day.isoformat()]
    return ActionOutcome(summary=f"Cleared {_label(h)} on {day.isoformat()}", result={"id": h["id"], "day": day.isoformat()})


class Skip(BaseModel):
    habits: list[str] = Field(default_factory=list, max_length=100, description="Habit ids or names; empty = every active habit")
    day: str | None = Field(default=None, pattern=DAY, description="First day to skip; default today")
    until: str | None = Field(default=None, pattern=DAY, description="Last day to skip (inclusive), for a trip or illness; default = `day`")
    reason: str = Field(default="", max_length=200, description="Sick, travelling, rest day…")


def skip_habit(ctx: ItemContext, data: dict, p: Skip) -> ActionOutcome:
    first = _day(ctx, data, p.day)
    last = _day(ctx, data, p.until) if p.until else first
    if last < first:
        raise ActionError("`until` is before `day`.")
    if (last - first).days > 120:
        raise ActionError("Skip at most 120 days at once.")
    today = today_for(ctx, data)
    if last > today + timedelta(days=180):
        raise ActionError("Skips can be planned up to 180 days ahead.")
    targets = [find(data, r) for r in p.habits] if p.habits else E.active(data)
    if not targets:
        raise ActionError("There are no habits to skip.")
    n = 0
    kept = 0
    for h in targets:
        start = E.start_of(h)
        for d in E.days(first, last):
            old = _get_log(h, d)
            if old and not old.get("skipped") and E.is_met(h, old, d, today):
                kept += 1  # already done that day — leave it
                continue
            if not E.is_flexible(h) and not E.is_due(h, d, start or d):
                continue
            _put_log(h, d, {"value": 0, "note": old.get("note", "") if old else "", "skipped": True, "reason": p.reason, "at": ctx.now.isoformat()})
            n += 1
    span = first.isoformat() if first == last else f"{first.isoformat()} – {last.isoformat()}"
    who = _label(targets[0]) if len(targets) == 1 else f"{len(targets)} habits"
    return ActionOutcome(
        summary=f"Skipped {who} for {span}{f' ({p.reason})' if p.reason else ''}",
        result={"skipped_days": n, "already_done_kept": kept},
    )


# ----------------------------------------------------------------- settings


class SetSettings(BaseModel):
    day_ends_at: int | None = Field(default=None, ge=0, le=6, description="Hour (0–6) the day rolls over; 3 = a log at 2 am counts for the day before")
    week_start: int | None = Field(default=None, ge=0, le=6, description="0 = Monday … 6 = Sunday")
    reminders_on: bool | None = Field(default=None, description="Master switch for all reminders")
    evening_summary: bool | None = Field(default=None, description="An evening 'still to do' nudge")
    evening_time: str | None = Field(default=None, pattern=HHMM)
    review_reminder: bool | None = Field(default=None, description="A weekly review reminder")
    review_weekday: int | None = Field(default=None, ge=0, le=6)
    review_time: str | None = Field(default=None, pattern=HHMM)
    celebrate: bool | None = Field(default=None, description="Animations and haptics on check-off")
    areas: list[str] | None = Field(default=None, max_length=24)


def set_settings(ctx: ItemContext, data: dict, p: SetSettings) -> ActionOutcome:
    s = _settings(data)
    changed = {k: v for k, v in p.model_dump().items() if v is not None}
    s.update(changed)
    s["onboarded"] = True
    return ActionOutcome(summary="Updated settings", result=changed)


# ------------------------------------------------------------------ reviews


class WriteReview(BaseModel):
    week: str | None = Field(default=None, pattern=DAY, description="Any day in the week; default this week")
    wins: str | None = Field(default=None, max_length=3000)
    misses: str | None = Field(default=None, max_length=3000)
    notes: str | None = Field(default=None, max_length=5000)
    focus: str | None = Field(default=None, max_length=1000, description="One focus for next week")
    insights: str | None = Field(default=None, max_length=6000, description="Your insights (markdown): patterns, what helped, one tiny tweak")


def write_review(ctx: ItemContext, data: dict, p: WriteReview) -> ActionOutcome:
    day = _day(ctx, data, p.week)
    wk = E.week_start_of(day, _week_start(data)).isoformat()
    reviews = data.setdefault("reviews", [])
    r = next((x for x in reviews if x["week"] == wk), None)
    if r is None:
        r = {"week": wk, "wins": "", "misses": "", "notes": "", "focus": "", "insights": "", "updated_at": ""}
        reviews.append(r)
        reviews.sort(key=lambda x: x["week"])
    for k in ("wins", "misses", "notes", "focus", "insights"):
        v = getattr(p, k)
        if v is not None:
            r[k] = v
    r["updated_at"] = ctx.now.isoformat()
    return ActionOutcome(summary=f"Saved the review for the week of {wk}", result={"week": wk})


# --------------------------------------------------------------- read-only


class StatsArgs(BaseModel):
    habit: str | None = Field(default=None, description="Habit id or name; omit for every active habit")
    include_archived: bool = False


def habit_stats(ctx: ItemContext, data: dict, p: StatsArgs) -> ActionOutcome:
    today = today_for(ctx, data)
    ws = _week_start(data)
    if p.habit:
        hs = [find(data, p.habit)]
    else:
        hs = [h for h in data.get("habits", []) if p.include_archived or not h.get("archived")]
    per = [E.habit_stats(h, today, ws) for h in hs]
    result: dict = {"today": today.isoformat(), "habits": per}
    if not p.habit:
        result["perfect_days"] = E.perfect_days(data, today)
        rates = [s["rate_30d"] for s in per if s["rate_30d"] is not None]
        result["overall_rate_30d"] = round(sum(rates) / len(rates), 4) if rates else None
    return ActionOutcome(summary="", result=result)


class WeekArgs(BaseModel):
    week: str | None = Field(default=None, pattern=DAY, description="Any day in the week; default this week")


def _week_summary(data: dict, wk_start: date, today: date, ws: int) -> dict:
    wk_end = wk_start + timedelta(days=6)
    last = min(wk_end, today)
    rows = []
    perfect = 0
    per_day: dict[date, list[str]] = {}
    for h in E.active(data):
        logs = E.logs_by_day(h)
        start = E.start_of(h)
        if start is None or start > last:
            continue
        notes = [f"{d.isoformat()}: {log['note']}" for d, log in sorted(logs.items()) if wk_start <= d <= wk_end and log.get("note")]
        skipped = [f"{d.isoformat()}{(' (' + log['reason'] + ')') if log.get('reason') else ''}" for d, log in sorted(logs.items()) if wk_start <= d <= wk_end and log.get("skipped")]
        row: dict = {"id": h["id"], "name": h["name"], "schedule": E.describe_schedule(h), "notes": notes, "skipped": skipped}
        if E.is_flexible(h):
            ps = [x for x in E.periods(h, last, ws, logs) if x["start"] <= last and x["end"] >= wk_start]
            done = sum(1 for d in E.days(max(wk_start, start), last) if E.is_met(h, logs.get(d), d, today))
            if h["schedule"]["kind"] == "per_week" and ps:
                p = ps[-1]
                row.update(done=done, expected=p["required"], status=p["status"])
            else:
                row.update(done=done, expected=None, status=ps[-1]["status"] if ps else None)
        else:
            sts = [(d, s) for d, s in E.day_statuses(h, last, logs) if d >= wk_start]
            done = sum(1 for _, s in sts if s == E.DONE)
            missed = sum(1 for _, s in sts if s == E.MISSED)
            row.update(done=done, expected=done + missed + sum(1 for _, s in sts if s == E.PENDING), missed=missed)
            row["status"] = "done" if missed == 0 and done > 0 else ("missed" if missed else "pending")
            for d, s in sts:
                if s in (E.DONE, E.MISSED, E.PENDING):
                    per_day.setdefault(d, []).append(s)
        if h.get("type") == "avoid":
            row["slips"] = sum(int(log.get("value") or 0) for d, log in logs.items() if wk_start <= d <= wk_end and not log.get("skipped"))
        exp = row.get("expected")
        row["rate"] = round(row["done"] / exp, 4) if exp else None
        cur, _best = E.streaks(E.unit_statuses(h, last, ws, logs))
        row["streak_at_week_end"] = cur
        rows.append(row)
    perfect = sum(1 for ss in per_day.values() if ss and all(s == E.DONE for s in ss))
    exp_total = sum(r["expected"] or 0 for r in rows)
    done_total = sum(min(r["done"], r["expected"]) for r in rows if r.get("expected"))
    return {
        "week": wk_start.isoformat(),
        "end": wk_end.isoformat(),
        "complete": today > wk_end,
        "rate": round(done_total / exp_total, 4) if exp_total else None,
        "perfect_days": perfect,
        "habits": rows,
    }


def weekly_review_data(ctx: ItemContext, data: dict, p: WeekArgs) -> ActionOutcome:
    today = today_for(ctx, data)
    ws = _week_start(data)
    wk = E.week_start_of(_day(ctx, data, p.week), ws)
    cur = _week_summary(data, wk, today, ws)
    prev = _week_summary(data, wk - timedelta(days=7), today, ws)
    rows = cur["habits"]
    wins = [r["name"] for r in rows if r.get("rate") is not None and r["rate"] >= 0.999]
    misses = [r["name"] for r in rows if r.get("rate") is not None and r["rate"] < 0.6 and r.get("status") != "pending"]
    review = next((r for r in data.get("reviews", []) if r["week"] == cur["week"]), None)
    return ActionOutcome(
        summary="",
        result={
            **cur,
            "previous_week_rate": prev["rate"],
            "wins": wins,
            "misses": misses,
            "existing_review": review,
        },
    )


class RiskArgs(BaseModel):
    day: str | None = Field(default=None, pattern=DAY, description="Default today")


def at_risk(data: dict, today: date, ws: int) -> list[dict]:
    out = []
    yesterday = today - timedelta(days=1)
    for h in E.active(data):
        logs = E.logs_by_day(h)
        st = E.today_status(h, today, ws, logs)
        if st["done"] or st["skipped"] or E.is_failed(h, logs.get(today)):
            continue
        cur, best = E.streaks(E.unit_statuses(h, today, ws, logs))
        start = E.start_of(h)
        if start is None or start > today:
            continue
        item = {"id": h["id"], "name": h["name"], "time_of_day": h.get("time_of_day"), "current_streak": cur, "streak_unit": E.streak_unit(h), "best_streak": best}
        if E.is_flexible(h):
            per = st.get("period") or {}
            if per.get("status") != E.PENDING:
                continue
            need = per["required"] - per["done"]
            if need <= 0:
                continue
            if need >= per["left"]:
                item.update(reason=f"needs {need} more in the {per['left']} day{'s' if per['left'] != 1 else ''} left this {'week' if h['schedule']['kind'] == 'per_week' else 'month'} — today is required", priority=3 if cur else 2)
            elif need == per["left"] - 1:
                item.update(reason=f"needs {need} more with {per['left']} days left — little slack", priority=1)
            else:
                continue
            out.append(item)
            continue
        if not E.is_due(h, today, start):
            continue
        ylog = logs.get(yesterday)
        missed_yesterday = E.is_due(h, yesterday, start) and not E.is_skipped(ylog) and not E.is_met(h, ylog, yesterday, today)
        if missed_yesterday:
            item.update(reason="missed yesterday — never miss twice", priority=4)
        elif cur > 0:
            item.update(reason=f"{cur}-{item['streak_unit'][:-1]} streak at stake", priority=3 if cur >= 7 else 2)
        else:
            item.update(reason="due today", priority=0)
        out.append(item)
    out.sort(key=lambda x: (-x["priority"], -x["current_streak"]))
    return out


def at_risk_habits(ctx: ItemContext, data: dict, p: RiskArgs) -> ActionOutcome:
    day = _day(ctx, data, p.day)
    return ActionOutcome(summary="", result={"day": day.isoformat(), "at_risk": at_risk(data, day, _week_start(data))})


# ------------------------------------------------------------------- import


class ImportFile(BaseModel):
    name: str = Field(min_length=1, max_length=300, description="File name or path inside the ZIP ('001 Meditate/Checkmarks.csv')")
    content: str = Field(max_length=8_000_000, description="The CSV text")


class ImportArgs(BaseModel):
    files: list[ImportFile] = Field(min_length=1, max_length=400)
    overwrite: bool = Field(default=False, description="Replace days that already have a log (default: keep what's there)")


def _import(ctx: ItemContext, data: dict, p: ImportArgs, write: bool) -> dict:
    plan = importer.build_plan([(f.name, f.content) for f in p.files])
    try:
        return importer.apply_plan(
            plan, data, today=today_for(ctx, data), now_iso=ctx.now.isoformat(), new_id=_new_id, overwrite=p.overwrite, write=write
        )
    except ValueError as e:
        raise ActionError(str(e)) from e


def preview_import(ctx: ItemContext, data: dict, p: ImportArgs) -> ActionOutcome:
    import copy

    report = _import(ctx, copy.deepcopy(data), p, write=False)
    return ActionOutcome(summary="", result=report)


def import_history(ctx: ItemContext, data: dict, p: ImportArgs) -> ActionOutcome:
    report = _import(ctx, data, p, write=True)
    n_new = len(report["new_habits"])
    if not report["logs_added"] and not report["logs_replaced"] and not n_new:
        raise ActionError("Nothing to import — " + ("; ".join(report["warnings"][:3]) or "no habit days found in those files."))
    data.setdefault("settings", {})["onboarded"] = True
    return ActionOutcome(
        summary=f"Imported {report['logs_added'] + report['logs_replaced']} days"
        f"{f' and {n_new} new habit' + ('s' if n_new != 1 else '') if n_new else ''}",
        result=report,
    )


# ------------------------------------------------------------------- export

ACTIONS = [
    ItemAction(
        "create_habit",
        "Create one habit. Make it concrete and small, with a schedule, a time of day and (ideally) an implementation "
        "intention ('After I <cue>, I will <tiny action>'). Use type avoid for habits to quit.",
        NewHabit,
        create_habit,
    ),
    ItemAction("create_habits", "Create several habits at once (a whole routine). Same fields as create_habit.", NewHabits, create_habits),
    ItemAction("edit_habit", "Change a habit's fields (only the ones given). Use it to shrink, reschedule, rename or add a cue/reminder.", EditHabit, edit_habit),
    ItemAction("archive_habit", "Archive a habit (hidden from Today, history kept) or restore it with archived=false.", ArchiveHabit, archive_habit),
    ItemAction("delete_habit", "Delete a habit and all its history. Prefer archive unless they clearly want it gone.", DeleteHabit, delete_habit),
    ItemAction("reorder_habits", "Set the order habits are listed in.", Reorder, reorder_habits),
    ItemAction(
        "log_habit",
        "Log a habit for a day (default today): done, a count, minutes, or (avoid habits) slips — 0 slips confirms a "
        "clean day. add=true adds to that day's value ('another glass'). Only today or past days.",
        LogEntry,
        log_habit,
    ),
    ItemAction("log_habits", "Log many habit-days in one go (backfilling a week, a whole morning routine).", LogMany, log_habits),
    ItemAction("unlog_habit", "Remove a day's log (or skip) for a habit — undoing a check-off.", Unlog, unlog_habit),
    ItemAction(
        "skip_habit",
        "Mark days as skipped (sick, travelling, planned rest) for some or all habits — skips never break streaks. "
        "Can cover a range and be planned ahead. Days already done are kept.",
        Skip,
        skip_habit,
    ),
    ItemAction("set_settings", "Change settings: day boundary, week start, reminder switches and times, areas.", SetSettings, set_settings),
    ItemAction(
        "write_review",
        "Write or update the weekly review (wins, misses, notes, next week's focus, and your insights). Fields left out stay as they are.",
        WriteReview,
        write_review,
    ),
    ItemAction(
        "habit_stats",
        "Real numbers for one habit or all: current/best streak (with its unit), completion rates 7/30/90/all, strength "
        "score (0–100, Loop-style) and its 30-day change, weekday breakdown, today's status, perfect days.",
        StatsArgs,
        habit_stats,
        writes=False,
    ),
    ItemAction(
        "weekly_review_data",
        "The numbers for a weekly review: per habit done/expected/rate/streak, notes and skips, wins, misses, perfect days, last week's rate.",
        WeekArgs,
        weekly_review_data,
        writes=False,
    ),
    ItemAction(
        "preview_import",
        "Dry-run an import of habit history from CSV (Loop Habit Tracker's export files, or date,habit,value[,note,skipped] "
        "rows): which habits would be created or matched and how many days would be added. Changes nothing.",
        ImportArgs,
        preview_import,
        writes=False,
        chat=False,
    ),
    ItemAction(
        "import_history",
        "Import habit history from CSV (same files as preview_import). Creates missing habits, adds their days; keeps "
        "days already logged unless overwrite=true.",
        ImportArgs,
        import_history,
        chat=False,
    ),
    ItemAction(
        "at_risk_habits",
        "Habits whose streaks may break today (due and not done, missed yesterday, or a weekly target with no slack left), most urgent first.",
        RiskArgs,
        at_risk_habits,
        writes=False,
    ),
]

__all__ = ["ACTIONS", "at_risk", "find", "today_for"]

