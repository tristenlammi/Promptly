"""Tasks & reminders (kind ``tasks``): lists of to-dos with due days and
times, reminder pushes, repeats, priorities, tags and steps, a morning
digest, and a completion log. Replaces Todoist, Google Tasks, Apple
Reminders and TickTick."""
from __future__ import annotations

from datetime import timedelta

from app.items.spec import ItemContext, ItemSpec, text_now

from . import logic as L
from .actions import ACTIONS
from .models import TasksData
from .recur import describe
from .reminders import reminders


def template(ctx: ItemContext) -> dict:
    lists = [
        ("inbox", "Inbox", "#8A6F5A", "📥"),
        ("personal", "Personal", "#3B7DD8", "🙂"),
        ("home", "Home", "#4E9F5B", "🏠"),
        ("work", "Work", "#7B6CD9", "💼"),
        ("shopping", "Shopping", "#D9902F", "🛒"),
    ]
    return TasksData.model_validate(
        {"lists": [{"id": i, "name": n, "color": c, "emoji": e, "order": k} for k, (i, n, c, e) in enumerate(lists)]}
    ).model_dump(mode="json")


def to_text(data: dict) -> str:
    now = text_now()
    today = now.date()
    b = L.buckets(data, today, 14)
    lines: list[str] = [f"Tasks (as of {today.isoformat()})"]
    budget = 18_000

    def add(title: str, tasks: list[dict], cap: int) -> None:
        nonlocal budget
        if not tasks:
            return
        lines.append(f"\n{title} ({len(tasks)}):")
        for t in tasks[:cap]:
            row = f"- {L.fmt_task(t, data)}"
            if t.get("notes"):
                row += f" — {t['notes'][:160]}"
            if budget - len(row) < 0:
                lines.append("- …")
                return
            budget -= len(row)
            lines.append(row)
        if len(tasks) > cap:
            lines.append(f"- … and {len(tasks) - cap} more")

    add("Overdue", b["overdue"], 60)
    add("Today", b["today"], 80)
    add("Next 14 days", b["upcoming"], 120)
    add("Later", b["later"], 80)
    add("No date", b["someday"], 120)
    reps = [t for t in data["tasks"] if t.get("repeat") and not t["done"]]
    if reps:
        lines.append("\nRepeating: " + "; ".join(f"{t['title']} ({describe(t['repeat'])})" for t in reps[:40]))
    since = (today - timedelta(days=13)).isoformat()
    recent = [x for x in data["log"] if x["at"][:10] >= since]
    if recent:
        lines.append(f"\nCompleted in the last 14 days ({len(recent)}):")
        for x in reversed(recent[-40:]):
            lines.append(f"- {x['at'][:10]} {x['title']}")
    names = ", ".join(lst["name"] for lst in data["lists"])
    lines.append(f"\nLists: {names}")
    return "\n".join(lines)


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    """Done tasks finished before ``before_day`` and older log entries move
    to the archive file; open tasks always stay."""
    old = [t for t in data["tasks"] if t["done"] and (t.get("done_at") or "")[:10] < before_day]
    ids = {t["id"] for t in old}
    kept = {
        **data,
        "tasks": [t for t in data["tasks"] if t["id"] not in ids],
        "log": [x for x in data["log"] if x["at"][:10] >= before_day],
    }
    archived = {
        **data,
        "tasks": old,
        "log": [x for x in data["log"] if x["at"][:10] < before_day],
    }
    return kept, archived


AI_BRIEF = """You are a sharp, calm personal organiser running the person's task list.

How to work:
- "Remind me to…", "add…", "I need to…" → add_tasks. Turn natural language into fields: "tomorrow at 3" → due tomorrow, time 15:00; "next Friday" → that date; "in March" → 1 March (all day) unless they say a day; "every month on the 1st" → repeat monthly, month_day 1; "every weekday" → weekly, weekdays [0,1,2,3,4]; "every 3 days after I do it" → daily, interval 3, from_completion. Today's date is in your context — compute dates from it, never guess.
- Pick the list from context (groceries → Shopping, work things → Work, chores → Home), else the Inbox. Don't invent new lists unless asked.
- Reminders: a timed task gets an at-the-time push by default. For things with lead time (a bill, a renewal, a birthday) add sensible early alerts, e.g. 1 day (1440) or 1 week (10080) before, and say so. All-day tasks show in the morning digest.
- Priority only when the person signals urgency or importance (3 = high). Don't mark everything high.
- Multi-step jobs ("plan the party", "move house") → one task with steps, or a few tasks on sensible dates; ask one short question only if the deadline is unknown and matters.
- Before changing or completing tasks, get ids from agenda / find_tasks. Use complete_tasks to tick off (repeats roll forward on their own); postpone_tasks to reschedule ("move everything overdue to tomorrow").
- Planning the day: use agenda. Suggest a realistic order — the hard or high-priority thing first, timed tasks fixed, small tasks batched — and keep it short. If there's more than a day's work, propose what to push and do it only when they agree.
- Reviews: use review. Celebrate what got done (counts, streaks), name what keeps slipping, and offer one concrete fix (split it, schedule it, delegate it or drop it). Techniques you can draw on: Getting Things Done (capture everything, next physical action, weekly review), Eisenhower (urgent vs important), time-blocking, "eat the frog", the two-minute rule.
- Confirm what you did in one line with the date written naturally ("Added 'Renew rego' for Mon 2 Mar, reminder a week before"). Never claim a reminder you didn't set."""


SPEC = ItemSpec(
    kind="tasks",
    name="Tasks & Reminders",
    tagline="To-dos, reminders and repeats — on every device.",
    description=(
        "Lists for everything you need to do, with due days and times, reminder pushes to your phone, "
        "repeats (every weekday, the 1st of each month, three days after you last did it), priorities, tags and steps. "
        "Type it the way you'd say it — “Pay rent every month on the 1st #home” — and it fills in the rest. "
        "A morning push lists the day, and the assistant can plan your day, reschedule what slipped, or review your week."
    ),
    category="Productivity",
    icon="list-todo",
    color="#DB4C3F",
    suffix=".tasks",
    model=TasksData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=[
        "Remind me to renew the car rego a week before 1 March",
        "Plan my day",
        "Move everything overdue to tomorrow",
        "What did I get done this week?",
        "Add a weekly clean-the-bathroom task every Saturday",
    ],
    reminders=reminders,
    archive=archive,
    remind_collaborators=True,
    replaces="Replaces Todoist, Google Tasks, Apple Reminders and TickTick",
    highlights=[
        "Quick add in plain words: dates, times, repeats, #lists, !priority",
        "Reminder pushes at the time, or a day or a week before",
        "Repeats: daily, weekdays, monthly on a date, yearly, or N days after done",
        "Today, Upcoming and per-list views; steps, notes, tags and priorities",
        "A morning digest of what's due",
        "Share a list with the household — everyone gets its reminders",
        "Ask the assistant to plan your day, reschedule, or review your week",
    ],
)
