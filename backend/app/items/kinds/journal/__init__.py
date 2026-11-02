"""Journal — a private, calm writing app with moods, prompts and templates,
insights and a reflection partner. Replaces Day One, Journey and Reflectly."""
from __future__ import annotations

from app.items.spec import ItemContext, ItemSpec

from .actions import ACTIONS
from .brief import AI_BRIEF, AI_SUGGESTIONS
from .logic import archive, reminders, to_text
from .models import JournalData, builtin_templates
from .routes import router


def template(ctx: ItemContext) -> dict:
    return {"entries": [], "templates": builtin_templates(), "settings": {}}


SPEC = ItemSpec(
    kind="journal",
    name="Journal",
    tagline="A calm, private place to write — with moods, prompts and gentle insight.",
    description=(
        "A distraction-free journal for every day: write freely in Markdown, check in with your mood, energy and "
        "the exact emotions you feel, and keep gratitude lists. Evidence-based templates — morning pages, three "
        "good things, daily and weekly reviews, an evening wind-down, a CBT thought record and a self-compassion "
        "break — and a library of reflective prompts help when the page is blank. A timeline, a mood calendar, "
        "“On this day” and insights show how you've been, and a warm assistant helps you reflect on a week, "
        "notice patterns (with humility) and connect your mood to sleep and habits. Private by default: other "
        "chats in Promptly see only an outline (dates, titles, moods, tags), and you choose whether they see "
        "short excerpts. Writing about a day shows that day's events and photos to add in a tap. Not yet: importing from Day One, end-to-end encryption or an app lock."
    ),
    category="Habits & journal",
    icon="book-open",
    color="#B5835A",
    suffix=".journal",
    model=JournalData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=AI_SUGGESTIONS,
    reads=("habits", "health"),
    reminders=reminders,
    # The 8 MB default (~5 years of daily 1,500-character entries); past 75%
    # the shell offers "Archive older data" → ``archive``.
    archive=archive,
    # Normal chats get the outline (to_text) and the chat-visible actions,
    # never the raw JSON with every entry's text.
    chat_raw=False,
    # GET /api/items/k/journal/{id}/day — that day's events and photos.
    router=router,
    replaces="Replaces Day One, Journey and Reflectly",
    highlights=[
        "Distraction-free, full-screen writing with Markdown; unsaved text is kept on your device",
        "Mood, energy and feelings-wheel emotions in two taps",
        "Templates: morning pages, three good things, daily & weekly review, CBT thought record, self-compassion",
        "A library of reflective prompts, plus a prompt of the day",
        "Timeline with full-text search, a mood calendar and “On this day”",
        "Insights: mood trends, emotions, streaks, tags and words written",
        "A gentle reflection partner that summarises your week and spots patterns",
        "Daily and weekly reminders that skip days (and weeks) you've already written",
        "Private by default — other chats see an outline, not your words",
    ],
)
