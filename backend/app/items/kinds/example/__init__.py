"""Example item (hidden): tally counters. The reference kind for authors —
the smallest complete item: a model, a template, text, actions with
params, an AI brief and suggestions. Not in the Store (``hidden``)."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext, ItemSpec


# ---- the file's shape: every field has a default, so old files still load


class Tap(BaseModel):
    at: str  # ISO moment
    by: int = 1


class Counter(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(max_length=80)
    goal: int | None = Field(default=None, ge=1, le=1_000_000)
    taps: list[Tap] = Field(default_factory=list, max_length=20_000)


class ExampleData(BaseModel):
    counters: list[Counter] = Field(default_factory=list, max_length=200)


def template(ctx: ItemContext) -> dict:
    return {"counters": [{"id": "water", "name": "Glasses of water", "goal": 8, "taps": []}]}


def _today_total(c: dict, day: str) -> int:
    return sum(t["by"] for t in c["taps"] if t["at"][:10] == day)


def to_text(data: dict) -> str:
    lines = []
    for c in data.get("counters", []):
        days: dict[str, int] = {}
        for t in c["taps"]:
            days[t["at"][:10]] = days.get(t["at"][:10], 0) + t["by"]
        recent = ", ".join(f"{d}: {n}" for d, n in sorted(days.items(), reverse=True)[:14])
        goal = f" (goal {c['goal']}/day)" if c.get("goal") else ""
        lines.append(f"- {c['name']}{goal}: {recent or 'no taps yet'}")
    return "Counters:\n" + "\n".join(lines)


# ---- actions: the AI's (and chat's) hands. Deterministic for (data, args, now).


class AddCounter(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    goal: int | None = Field(default=None, ge=1, le=1_000_000, description="Daily goal, if any")


def add_counter(ctx: ItemContext, data: dict, p: AddCounter) -> ActionOutcome:
    base = "".join(ch for ch in p.name.lower() if ch.isalnum())[:30] or "counter"
    cid, n = base, 2
    while any(c["id"] == cid for c in data["counters"]):
        cid, n = f"{base}{n}", n + 1
    data["counters"].append({"id": cid, "name": p.name, "goal": p.goal, "taps": []})
    return ActionOutcome(summary=f"Added the counter “{p.name}”", result={"id": cid})


class Count(BaseModel):
    counter_id: str
    by: int = Field(default=1, ge=-1000, le=1000)
    at: datetime | None = Field(default=None, description="When; default now")


def count(ctx: ItemContext, data: dict, p: Count) -> ActionOutcome:
    c = next((c for c in data["counters"] if c["id"] == p.counter_id), None)
    if c is None:
        raise ActionError(f"No counter with id {p.counter_id!r}.")
    when = (p.at or ctx.now).astimezone(ctx.tz)
    c["taps"].append({"at": when.isoformat(), "by": p.by})
    return ActionOutcome(
        summary=f"{c['name']}: {'+' if p.by >= 0 else ''}{p.by}",
        result={"today": _today_total(c, when.date().isoformat())},
    )


class NoArgs(BaseModel):
    pass


def summary(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    day = ctx.today.isoformat()
    return ActionOutcome(
        summary="",
        result={c["name"]: {"today": _today_total(c, day), "goal": c.get("goal")} for c in data["counters"]},
    )


SPEC = ItemSpec(
    kind="example",
    name="Tally",
    tagline="Count anything, every day.",
    description="The reference item: counters you tap, with daily goals.",
    category="Habits & journal",
    icon="list-checks",
    color="#4F8A8B",
    suffix=".tally",
    model=ExampleData,
    template=template,
    to_text=to_text,
    actions=[
        ItemAction("add_counter", "Create a new counter.", AddCounter, add_counter),
        ItemAction("count", "Add to (or, with a negative number, take from) a counter.", Count, count),
        ItemAction("today_summary", "Today's totals for every counter.", NoArgs, summary, writes=False),
    ],
    ai_brief="Help the person keep their counts. Use add_counter and count; never invent past taps.",
    ai_suggestions=["Add a counter for coffees with a goal of 2", "How am I doing today?"],
    hidden=True,
)
