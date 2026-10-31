"""Bringing habit history in: Loop Habit Tracker's CSV export and a plain
``date,habit,value`` CSV (which is also what this item exports).

Loop's "Export as CSV" writes a ZIP with:

* ``Habits.csv`` — ``Position,Name,Type,Question,Description,
  FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,
  Target Value,Archived?,Category`` (older versions:
  ``Position,Name,Description,NumRepetitions,Interval,Color``).
* ``Checkmarks.csv`` — one row per day, newest first: ``Date,<habit 1>,
  <habit 2>,…,`` (a trailing empty column).
* ``NNN Name/Checkmarks.csv`` — per habit: ``Date,Value,Notes``.
* ``Scores.csv`` files — ignored (we recompute strength ourselves).

Values: ``YES_MANUAL`` (done), ``YES_AUTO`` (Loop filled it in because the
frequency was already met — not a check-off, ignored), ``NO`` / ``UNKNOWN``
(nothing), ``SKIP`` (a skipped day); older versions write the codes
2 / 1 / 0 / -1 / 3. Numerical habits store thousandths (``8000`` = 8), so a
whole number for a numerical habit is divided by 1000; a number with a
decimal point is taken as is.

Everything here is pure and deterministic for (data, files, now): the
preview and the import run the same plan.
"""
from __future__ import annotations

import csv
import io
import math
import re
from datetime import date

from . import engine as E
from .models import DEFAULT_COLOR, MAX_HABITS, MAX_LOGS

LOOP_YES = {"YES_MANUAL", "2"}
LOOP_IGNORE = {"YES_AUTO", "1", "NO", "0", "UNKNOWN", "-1", ""}
LOOP_SKIP = {"SKIP", "3"}
MAX_IMPORT_LOGS = 250_000

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _rows(text: str) -> list[list[str]]:
    text = text.lstrip("﻿")
    sample = text[:2000]
    delim = ";" if sample.count(";") > sample.count(",") and "\t" not in sample else ("\t" if sample.count("\t") > sample.count(",") else ",")
    return [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]


def _day(s: str) -> date | None:
    s = (s or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    try:
        if m:
            return date(int(m[1]), int(m[2]), int(m[3]))
        m = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)  # Loop's very old 20150125
        if m:
            return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None
    return None


def _num(s: str) -> float | None:
    try:
        v = float((s or "").strip().replace(",", "."))
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _truthy(s: str) -> bool:
    return (s or "").strip().lower() in ("1", "true", "yes", "y", "x", "skip", "skipped")


def _folder_habit(path: str) -> str | None:
    """``"loop/003 Foo Bar/Checkmarks.csv"`` → ``"Foo Bar"``."""
    parts = re.split(r"[\\/]", path)
    if len(parts) < 2:
        return None
    m = re.match(r"^\d{1,4}\s+(.+)$", parts[-2].strip())
    return m[1].strip() if m else None


# ------------------------------------------------------------- the plan


class Plan:
    def __init__(self) -> None:
        self.defs: dict[str, dict] = {}  # lower name → habit fields from Habits.csv
        self.order: list[str] = []  # names (as written) in the order first seen
        self.logs: dict[str, dict[date, dict]] = {}  # lower name → day → log
        self.numeric_seen: dict[str, list[float]] = {}
        self.warnings: list[str] = []
        self.files: list[dict] = []
        self.ids: dict[str, str] = {}  # lower name → an explicit habit id (our own export)

    def name(self, n: str) -> str:
        key = n.strip().lower()
        if key and key not in {x.lower() for x in self.order}:
            self.order.append(n.strip())
        return key

    def put(self, name: str, day: date, log: dict) -> None:
        key = self.name(name)
        if not key:
            return
        self.logs.setdefault(key, {})[day] = log


def _loop_habits(rows: list[list[str]], plan: Plan) -> int:
    head = [h.strip().lower() for h in rows[0]]
    col = {h: i for i, h in enumerate(head)}

    def get(r: list[str], *names: str) -> str:
        for n in names:
            i = col.get(n)
            if i is not None and i < len(r):
                return r[i].strip()
        return ""

    n = 0
    for r in rows[1:]:
        name = get(r, "name")[:80]
        if not name:
            continue
        numerator = _num(get(r, "frequencynumerator", "numrepetitions")) or 1
        denominator = _num(get(r, "frequencydenominator", "interval")) or 1
        num, den = max(1, int(numerator)), max(1, int(denominator))
        if num >= den:
            sched = {"kind": "daily"}
        elif den == 7:
            sched = {"kind": "per_week", "times": num}
        elif den in (30, 31):
            sched = {"kind": "per_month", "times": min(31, num)}
        elif num == 1:
            sched = {"kind": "every_n_days", "every": min(365, den)}
        else:
            times = max(1, min(7, round(7 * num / den)))
            sched = {"kind": "per_week", "times": times}
            plan.warnings.append(f"{name}: Loop's {num} times in {den} days became {times}× a week.")
        numerical = get(r, "type").upper() == "NUMERICAL"
        unit = get(r, "unit")[:24]
        target = _num(get(r, "target value")) or 1
        fields: dict = {"name": name, "schedule": sched, "unit": unit}
        if numerical and get(r, "target type").upper() == "AT_MOST":
            fields.update(type="avoid", limit=max(0, min(1000, int(target))))
        elif numerical:
            is_min = unit.lower() in ("min", "mins", "minute", "minutes")
            fields.update(type="duration" if is_min else "count", target=min(100_000, max(0.01, target)))
            if is_min:
                fields["unit"] = ""
        else:
            fields["type"] = "yes_no"
        color = get(r, "color")
        if _HEX.match(color):
            fields["color"] = color.upper()
        if get(r, "archived?", "archived").lower() == "true":
            fields["archived"] = True
        if get(r, "category"):
            fields["area"] = get(r, "category")[:40]
        notes = " — ".join(x for x in (get(r, "question"), get(r, "description")) if x)
        if notes:
            fields["notes"] = notes[:2000]
        fields["numerical"] = numerical
        key = plan.name(name)
        plan.defs[key] = fields
        n += 1
    return n


def _loop_value(plan: Plan, name: str, raw: str, note: str = "") -> dict | None:
    """One Loop cell as a log (None = nothing to log)."""
    v = (raw or "").strip().upper()
    d = plan.defs.get(name.strip().lower())
    numerical = bool(d and d.get("numerical"))
    if v in LOOP_SKIP:
        return {"value": 0, "skipped": True, "note": note}
    if not numerical:
        if v in LOOP_YES:
            return {"value": 1, "skipped": False, "note": note}
        if v in LOOP_IGNORE:
            return {"value": 0, "skipped": False, "note": note, "only_note": True} if note else None
        x = _num(v)
        if x is None:
            return None
        # A number on a habit we have no definition for: a measurable habit.
        plan.numeric_seen.setdefault(name.strip().lower(), []).append(x)
        return {"value": x, "skipped": False, "note": note}
    if v in ("UNKNOWN", "", "YES_AUTO"):
        return {"value": 0, "skipped": False, "note": note, "only_note": True} if note else None
    x = _num(v)
    if x is None or x < 0:
        return None
    if "." not in v:
        x = x / 1000  # Loop stores thousandths
    if x == 0 and d and d.get("type") != "avoid":
        return {"value": 0, "skipped": False, "note": note, "only_note": True} if note else None
    return {"value": round(x, 3), "skipped": False, "note": note}


def _loop_combined(rows: list[list[str]], plan: Plan) -> int:
    names = [h.strip() for h in rows[0][1:]]
    n = 0
    for r in rows[1:]:
        day = _day(r[0] if r else "")
        if day is None:
            continue
        for i, name in enumerate(names):
            if not name or i + 1 >= len(r):
                continue
            log = _loop_value(plan, name, r[i + 1])
            if log is not None:
                plan.put(name, day, log)
                n += 1
    return n


def _loop_single(rows: list[list[str]], plan: Plan, name: str) -> int:
    n = 0
    for r in rows[1:]:
        day = _day(r[0] if r else "")
        if day is None or len(r) < 2:
            continue
        log = _loop_value(plan, name, r[1], (r[2].strip() if len(r) > 2 else "")[:1000])
        if log is not None:
            plan.put(name, day, log)
            n += 1
    return n


def _generic(rows: list[list[str]], plan: Plan) -> int:
    head = [h.strip().lower() for h in rows[0]]

    def idx(*names: str) -> int | None:
        for nm in names:
            if nm in head:
                return head.index(nm)
        return None

    i_day, i_habit = idx("date", "day"), idx("habit", "name", "habit name")
    i_val, i_note = idx("value", "amount", "count", "minutes"), idx("note", "notes", "comment")
    i_skip, i_reason, i_id = idx("skipped", "skip"), idx("reason"), idx("habit_id", "id")
    n = 0
    for r in rows[1:]:

        def cell(i: int | None) -> str:
            return r[i].strip() if i is not None and i < len(r) else ""

        day, name = _day(cell(i_day)), cell(i_habit)[:80]
        if day is None or not name:
            continue
        if i_id is not None and cell(i_id):
            plan.ids[name.lower()] = cell(i_id)[:48]
        skipped = _truthy(cell(i_skip)) if i_skip is not None else False
        raw = cell(i_val)
        val = _num(raw) if raw else None
        if not skipped and raw and val is None:
            low = raw.lower()
            val = 1.0 if low in ("yes", "y", "true", "done", "x", "✓", "yes_manual") else (0.0 if low in ("no", "false", "n") else None)
            if val is None:
                continue
        if val is None:
            val = 1.0
        if val < 0:
            continue
        plan.put(name, day, {"value": min(100_000.0, val), "skipped": skipped, "note": cell(i_note)[:1000], "reason": cell(i_reason)[:200]})
        if val not in (0.0, 1.0):
            plan.numeric_seen.setdefault(name.lower(), []).append(val)
        n += 1
    return n


def build_plan(files: list[tuple[str, str]]) -> Plan:
    plan = Plan()
    # Habit definitions first so check-offs know which habits are numerical.
    kinds: list[tuple[str, str, list[list[str]]]] = []
    for path, text in files:
        rows = _rows(text)
        base = re.split(r"[\\/]", path)[-1].lower()
        if not rows:
            plan.files.append({"name": path, "format": "empty", "rows": 0})
            continue
        head = [h.strip().lower() for h in rows[0]]
        if "name" in head and ("frequencynumerator" in head or "numrepetitions" in head or head[:2] == ["position", "name"]):
            kind = "loop_habits"
        elif base.startswith("scores") or head[-1:] == ["score"] or (len(head) == 2 and head[1] == "score"):
            kind = "scores"
        elif head and head[0] == "date" and len(head) >= 2 and head[1] == "value" and "habit" not in head:
            kind = "loop_single"
        elif ("date" in head or "day" in head) and ("habit" in head or "habit name" in head or ("name" in head and "position" not in head)):
            kind = "generic"
        elif head and head[0] == "date" and len(head) >= 2:
            kind = "loop_combined"
        else:
            kind = "unknown"
        kinds.append((path, kind, rows))
    kinds.sort(key=lambda k: k[1] != "loop_habits")
    combined_seen = any(k == "loop_combined" for _, k, _ in kinds)
    for path, kind, rows in kinds:
        n = 0
        if kind == "loop_habits":
            n = _loop_habits(rows, plan)
        elif kind == "loop_combined":
            n = _loop_combined(rows, plan)
        elif kind == "loop_single":
            name = _folder_habit(path)
            if name is None:
                plan.warnings.append(f"{path}: a Loop per-habit file outside its 'NNN Name' folder — import the whole ZIP instead.")
                kind = "skipped"
            elif combined_seen:
                kind = "duplicate"  # the combined Checkmarks.csv already has these days (notes still come from here)
                for r in rows[1:]:
                    day = _day(r[0] if r else "")
                    note = (r[2].strip() if len(r) > 2 else "")[:1000]
                    if day and note:
                        cur = plan.logs.get(name.lower(), {}).get(day)
                        if cur is not None:
                            cur["note"] = note
                        else:
                            plan.put(name, day, {"value": 0, "skipped": False, "note": note, "only_note": True})
                        n += 1
            else:
                n = _loop_single(rows, plan, name)
        elif kind == "generic":
            n = _generic(rows, plan)
        elif kind == "unknown":
            plan.warnings.append(f"{path}: not a format I know (expected Loop's export or date,habit,value columns).")
        plan.files.append({"name": path, "format": kind, "rows": n})
    return plan


# -------------------------------------------------------------- applying


def _guess_type(values: list[float]) -> tuple[str, float]:
    if not values:
        return "yes_no", 1
    vals = sorted(values)
    med = vals[len(vals) // 2]
    return "count", max(1.0, round(med, 2))


def apply_plan(
    plan: Plan,
    data: dict,
    *,
    today: date,
    now_iso: str,
    new_id,
    overwrite: bool = False,
    write: bool = True,
) -> dict:
    """Merge the plan into ``data`` (when ``write``) and say what it does."""
    habits = data.setdefault("habits", [])
    by_id = {h["id"]: h for h in habits}
    by_name = {h["name"].strip().lower(): h for h in habits}
    report = {"new_habits": [], "matched_habits": [], "logs_added": 0, "logs_replaced": 0, "logs_kept": 0, "dropped_old": 0, "first_day": None, "last_day": None}
    total = sum(len(v) for v in plan.logs.values())
    if total > MAX_IMPORT_LOGS:
        raise ValueError(f"That's {total} check-offs — more than {MAX_IMPORT_LOGS} in one import. Split the file.")
    keys = [n.lower() for n in plan.order if n.lower() in plan.defs or n.lower() in plan.logs]
    new_count = 0
    days_seen: list[date] = []
    for key in keys:
        name = next(n for n in plan.order if n.lower() == key)
        logs = plan.logs.get(key, {})
        days_seen.extend(logs)
        target = by_id.get(plan.ids.get(key, "")) or by_name.get(key)
        if target is None:
            if len(habits) + (new_count if not write else 0) >= MAX_HABITS:
                plan.warnings.append(f"{name}: not added — a file holds at most {MAX_HABITS} habits.")
                continue
            d = dict(plan.defs.get(key) or {})
            d.pop("numerical", None)
            if "type" not in d:
                t, tgt = _guess_type(plan.numeric_seen.get(key, []))
                d.update(type=t, target=tgt)
            real = [x for x, lg in logs.items() if not lg.get("only_note")]
            first = min(real) if real else today
            hid = plan.ids.get(key) if plan.ids.get(key) and plan.ids[key] not in by_id else new_id(data, name)
            h = {
                "id": hid,
                "name": d.pop("name", name)[:80],
                "emoji": "",
                "color": d.pop("color", DEFAULT_COLOR),
                "area": "",
                "type": "yes_no",
                "target": 1,
                "unit": "",
                "limit": 0,
                "schedule": {"kind": "daily", "days": [], "times": 3, "every": 2},
                "time_of_day": "anytime",
                "reminders": [],
                "start_date": min(first, today).isoformat(),
                "archived": False,
                "intention": "",
                "identity": "",
                "why": "",
                "notes": "",
                "created_at": now_iso,
                "logs": [],
            }
            sched = d.pop("schedule", None)
            if sched:
                h["schedule"] = {**h["schedule"], **sched}
            h.update(d)
            if h["type"] == "yes_no":
                h["target"] = 1
            report["new_habits"].append({"name": h["name"], "type": h["type"], "schedule": E.describe_schedule(h), "days": len(logs)})
            new_count += 1
            if write:
                habits.append(h)
                by_id[h["id"]] = h
                by_name[key] = h
            else:
                h["logs"] = []
            target = h
            existing: dict[str, dict] = {}
        else:
            report["matched_habits"].append({"id": target["id"], "name": target["name"], "days": len(logs)})
            existing = {lg["day"]: lg for lg in target.get("logs", [])}
        merged = dict(existing)
        for day in sorted(logs):
            if day > today:
                continue
            lg = logs[day]
            k = day.isoformat()
            if k in existing and not overwrite:
                if lg.get("note") and not existing[k].get("note") and write:
                    existing[k]["note"] = lg["note"]
                report["logs_kept"] += 1
                continue
            if lg.get("only_note"):
                if k not in existing:  # a note on a day with no check-off
                    merged[k] = {"day": k, "value": 0, "note": lg["note"], "skipped": False, "reason": "", "at": now_iso}
                continue
            if k in existing:
                report["logs_replaced"] += 1
            else:
                report["logs_added"] += 1
            value = float(lg.get("value") or 0)
            if target.get("type") == "yes_no" and not lg.get("skipped"):
                value = 1.0 if value > 0 else 0.0
                if value == 0 and not lg.get("note"):
                    report["logs_added"] -= 1
                    continue
            merged[k] = {
                "day": k,
                "value": value,
                "note": lg.get("note", ""),
                "skipped": bool(lg.get("skipped")),
                "reason": lg.get("reason", ""),
                "at": now_iso,
            }
        ordered = [merged[k] for k in sorted(merged)]
        if len(ordered) > MAX_LOGS:
            drop = len(ordered) - MAX_LOGS
            report["dropped_old"] += drop
            plan.warnings.append(
                f"{target['name']}: {drop} of the oldest days don't fit ({MAX_LOGS} days per habit) — archive older data first to keep them."
            )
            ordered = ordered[drop:]
        if write:
            start = E.start_of(target)
            first_real = next((lg["day"] for lg in ordered if not lg.get("skipped")), None)
            if first_real and target.get("start_date") and first_real < target["start_date"]:
                if not target.get("anchor_date") and start:
                    target["anchor_date"] = start.isoformat()  # backfilling never shifts the cadence
                target["start_date"] = first_real
            target["logs"] = ordered
    if days_seen:
        report["first_day"] = min(days_seen).isoformat()
        report["last_day"] = max(days_seen).isoformat()
    report["files"] = plan.files
    report["warnings"] = plan.warnings[:50]
    return report
