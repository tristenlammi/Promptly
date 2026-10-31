"""Habits — a habit tracker built on behaviour-change science (kind
``habits``). Replaces Streaks, Loop Habit Tracker, Habitify and Way of Life.

Modules: ``models`` (the file), ``engine`` (streaks, rates, strength score),
``actions`` (the assistant's hands), ``reminders``, ``brief`` (the expert
prompt), ``text`` (what chat and search read)."""
from __future__ import annotations

from app.items.spec import ItemContext, ItemSpec

from .actions import ACTIONS
from .archive import archive
from .brief import AI_BRIEF, AI_SUGGESTIONS
from .models import HabitsData
from .reminders import reminders
from .text import to_text


def template(ctx: ItemContext) -> dict:
    return HabitsData().model_dump(mode="json")


SPEC = ItemSpec(
    kind="habits",
    name="Habits",
    tagline="Build habits that stick — one tiny check-off at a time.",
    description=(
        "A habit tracker built on behaviour-change science. Track yes/no habits, counts (8 glasses of water), "
        "minutes (20 min reading) and habits you're quitting, on any schedule — every day, chosen weekdays, "
        "3× a week, 10× a month or every few days. Streaks that understand weekly targets and forgive skipped "
        "days, a Loop-style habit-strength score, heatmaps, calendars and a weekly review. The built-in coach "
        "turns vague goals into tiny, cue-anchored habits and reviews your week with you — kindly. Import your "
        "history from Loop Habit Tracker (its CSV export) or any CSV, and export every check-off as CSV. "
        "Reminders arrive as Promptly notifications (open the app to check off — there are no home-screen widgets "
        "or tap-to-complete notification buttons in a web app yet); add Habits to your home screen with "
        "?tab=today to land straight on today's list."
    ),
    category="Habits & journal",
    icon="circle-check-big",
    color="#7B6CD9",
    suffix=".habits",
    model=HabitsData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=AI_SUGGESTIONS,
    ai_web=False,
    reads=("journal", "health"),
    reminders=reminders,
    archive=archive,
    replaces="Replaces Streaks, Loop Habit Tracker, Habitify and Way of Life",
    highlights=[
        "One-tap check-off with a satisfying animation; long-press for counts, minutes, notes or a skip",
        "Yes/no, count, minutes (with a timer that survives closing the app) and quit habits, on any schedule",
        "Honest streaks: weekly targets count per week, skipped days never break a streak, a custom day boundary",
        "Habit-strength score, heatmaps, calendars, weekday patterns, trends and perfect days",
        "Reminders only while a habit is still to do — weekly targets can nudge only on chosen days or when behind pace",
        "Change a habit's schedule or goal without rewriting the past — every day keeps the rules it was lived under",
        "Bring your history: import Loop Habit Tracker's CSV export or any date,habit,value CSV; export everything as CSV",
        "An AI coach grounded in Atomic Habits, Tiny Habits and implementation intentions",
    ],
)
