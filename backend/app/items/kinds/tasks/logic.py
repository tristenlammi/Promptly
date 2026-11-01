"""Shared task logic: finding tasks and lists, the due moment, completing
(with repeats), and the buckets the views and the text use."""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.items.spec import ActionError

from .models import MAX_LOG
from .recur import next_due

LIST_COLORS = ["#3B7DD8", "#E2725B", "#4E9F5B", "#7B6CD9", "#D9902F", "#C2557A", "#2C9CC8", "#8A6F5A"]


def make_id(prefix: str, *parts: object, taken: set[str] | None = None) -> str:
    """A short id derived from its inputs (actions must be deterministic)."""
    raw = "|".join(str(p) for p in parts)
    base = prefix + hashlib.sha1(raw.encode()).hexdigest()[:8]
    out, n = base, 2
    while taken and out in taken:
        out, n = f"{base}{n}", n + 1
    return out


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())[:30] or "list"


# ------------------------------------------------------------ lookups


def find_list(data: dict, ref: str | None) -> dict | None:
    if not ref:
        return None
    r = ref.strip().lstrip("#").lower()
    for lst in data["lists"]:
        if lst["id"].lower() == r or lst["name"].lower() == r:
            return lst
    return None


def ensure_list(data: dict, name: str | None, color: str | None = None) -> str:
    """The id of list ``name`` (made if new); the inbox when none."""
    if not name or not name.strip():
        return "inbox"
    found = find_list(data, name)
    if found:
        return found["id"]
    taken = {lst["id"] for lst in data["lists"]}
    lid, n = slug(name), 2
    base = lid
    while lid in taken:
        lid, n = f"{base}{n}", n + 1
    data["lists"].append(
        {
            "id": lid,
            "name": name.strip()[:80],
            "color": color or LIST_COLORS[len(data["lists"]) % len(LIST_COLORS)],
            "emoji": "",
            "order": max([lst.get("order", 0) for lst in data["lists"]] or [0]) + 1,
        }
    )
    return lid


def list_name(data: dict, lid: str) -> str:
    lst = next((x for x in data["lists"] if x["id"] == lid), None)
    return lst["name"] if lst else "Inbox"


def find_task(data: dict, ref: str) -> dict:
    """By id, else by exact then partial title (open tasks first)."""
    r = (ref or "").strip()
    for t in data["tasks"]:
        if t["id"] == r:
            return t
    low = r.lower()
    open_first = sorted(data["tasks"], key=lambda t: t["done"])
    for t in open_first:
        if t["title"].lower() == low:
            return t
    hits = [t for t in open_first if low and low in t["title"].lower()]
    live = [t for t in hits if not t["done"]]
    if len(live) == 1 or (not live and len(hits) == 1):
        return (live or hits)[0]
    if hits:
        names = "; ".join(f"{t['title']} ({t['id']})" for t in hits[:6])
        raise ActionError(f"“{ref}” matches several tasks: {names}. Use the id.")
    raise ActionError(f"No task matches “{ref}”.")


# ------------------------------------------------------------ time


def moment(task: dict, settings: dict, tz: ZoneInfo) -> datetime | None:
    """When the task is due: its day at its time (all-day → default time)."""
    if not task.get("due"):
        return None
    clock = task.get("time") or settings.get("default_time") or "09:00"
    hh, mm = (int(x) for x in clock.split(":"))
    return datetime.combine(date.fromisoformat(task["due"]), time(hh, mm), tzinfo=tz)


def is_overdue(task: dict, now: datetime, settings: dict) -> bool:
    if task["done"] or not task.get("due"):
        return False
    today = now.date().isoformat()
    if task["due"] < today:
        return True
    if task["due"] == today and task.get("time"):
        m = moment(task, settings, now.tzinfo)  # type: ignore[arg-type]
        return m is not None and m < now
    return False


def sort_key(t: dict) -> tuple:
    return (t.get("due") or "9999", t.get("time") or "99:99", -t.get("priority", 0), t.get("order", 0))


def buckets(data: dict, today: date, days: int = 7) -> dict[str, list[dict]]:
    """Open tasks: overdue · today · the next ``days`` · later · no date."""
    t0 = today.isoformat()
    end = (today + timedelta(days=days)).isoformat()
    out: dict[str, list[dict]] = {"overdue": [], "today": [], "upcoming": [], "later": [], "someday": []}
    for t in data["tasks"]:
        if t["done"]:
            continue
        d = t.get("due")
        if not d:
            out["someday"].append(t)
        elif d < t0:
            out["overdue"].append(t)
        elif d == t0:
            out["today"].append(t)
        elif d <= end:
            out["upcoming"].append(t)
        else:
            out["later"].append(t)
    for v in out.values():
        v.sort(key=sort_key)
    return out


# ------------------------------------------------------------ changes


def complete(data: dict, task: dict, now: datetime) -> str:
    """Tick a task off. A repeating one is logged and moved to its next
    occurrence (its steps reset); returns a short description."""
    at = now.isoformat()
    day = now.date().isoformat()
    log_id = make_id("d", task["id"], task.get("due"), at, taken={x["id"] for x in data["log"]})
    data["log"].append(
        {"id": log_id, "task_id": task["id"], "title": task["title"], "list_id": task.get("list_id", "inbox"), "at": at, "due": task.get("due")}
    )
    if len(data["log"]) > MAX_LOG:
        del data["log"][: len(data["log"]) - MAX_LOG]
    rep = task.get("repeat")
    if rep:
        nxt = next_due(rep, task.get("due"), day)
        if nxt:
            task["due"] = nxt
            for s in task.get("steps", []):
                s["done"] = False
            return f"next due {nxt}"
    task["done"] = True
    task["done_at"] = at
    return "done"


def reopen(data: dict, task: dict) -> None:
    task["done"] = False
    task["done_at"] = None
    # Drop the completion this undoes (the latest one for this task).
    for i in range(len(data["log"]) - 1, -1, -1):
        if data["log"][i]["task_id"] == task["id"]:
            del data["log"][i]
            break


def fmt_task(t: dict, data: dict, *, with_list: bool = True) -> str:
    bits = [t["title"]]
    if t.get("due"):
        bits.append(f"due {t['due']}{' ' + t['time'] if t.get('time') else ''}")
    if t.get("repeat"):
        from .recur import describe

        bits.append(describe(t["repeat"]))
    if t.get("priority"):
        bits.append({1: "low", 2: "medium", 3: "high"}[t["priority"]] + " priority")
    if with_list and t.get("list_id", "inbox") != "inbox":
        bits.append(f"list {list_name(data, t['list_id'])}")
    if t.get("tags"):
        bits.append(" ".join("#" + x for x in t["tags"]))
    steps = t.get("steps") or []
    if steps:
        bits.append(f"{sum(s['done'] for s in steps)}/{len(steps)} steps")
    return " · ".join(bits)
