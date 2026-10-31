"""The Journal file's shape.

Bounds (a journal is kept for years, so they're generous but finite):

* at most :data:`MAX_ENTRIES` entries, each body at most :data:`MAX_BODY`
  characters (Markdown);
* the file as a whole is capped by the spec's ``max_bytes`` (the 8 MB
  default) — the limit that actually binds first: about five years of a
  daily ~1,500 character entry. The shell shows how full a journal is past
  75% and offers "Archive older data" (``archive`` in ``__init__``), which
  moves entries before a day into a new journal file and keeps templates
  and settings in both.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_ENTRIES = 20_000
MAX_BODY = 100_000
MAX_TEMPLATES = 100

DAY_RE = r"^\d{4}-\d{2}-\d{2}$"
TIME_RE = r"^([01]\d|2[0-3]):[0-5]\d$"

MOOD_LABELS = {1: "Awful", 2: "Low", 3: "Okay", 4: "Good", 5: "Great"}
ENERGY_LABELS = {1: "Drained", 2: "Low", 3: "Steady", 4: "Energised", 5: "Buzzing"}

# A curated, feelings-wheel based set (Plutchik's primaries + Willcox's
# Feelings Wheel), grouped into families the insights count by. The person
# may add their own words too; unknown words count as "other".
EMOTIONS: dict[str, list[str]] = {
    "joyful": ["happy", "content", "grateful", "proud", "hopeful", "excited", "playful", "loved", "inspired", "confident", "relieved", "amused"],
    "calm": ["calm", "peaceful", "relaxed", "safe", "centred", "focused"],
    "sad": ["sad", "lonely", "disappointed", "hurt", "grieving", "guilty", "ashamed", "empty", "nostalgic", "homesick"],
    "anxious": ["anxious", "worried", "overwhelmed", "insecure", "nervous", "scared", "stressed", "restless"],
    "angry": ["angry", "frustrated", "irritated", "resentful", "jealous", "annoyed"],
    "surprised": ["surprised", "amazed", "confused", "curious", "moved"],
    "tired": ["tired", "bored", "numb", "drained", "unmotivated"],
}
FAMILY_OF = {w: fam for fam, words in EMOTIONS.items() for w in words}

_WORD_RE = re.compile(r"[\w’'-]+", re.UNICODE)


def count_words(*texts: str) -> int:
    return sum(len(_WORD_RE.findall(t or "")) for t in texts)


def norm_tag(t: str) -> str:
    t = re.sub(r"\s+", "-", (t or "").strip().lstrip("#").lower())
    return t[:40]


def norm_word(w: str) -> str:
    return re.sub(r"\s+", " ", (w or "").strip().lower())[:30]


def _dedupe(items: list[str]) -> list[str]:
    out: list[str] = []
    for i in items:
        if i and i not in out:
            out.append(i)
    return out


class Entry(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    date: str = Field(pattern=DAY_RE, description="The person's local day")
    time: str = Field(default="12:00", pattern=TIME_RE)
    created_at: str | None = Field(default=None, max_length=40)
    updated_at: str | None = Field(default=None, max_length=40)
    title: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=MAX_BODY)
    mood: int | None = Field(default=None, ge=1, le=5)
    emotions: list[str] = Field(default_factory=list, max_length=12)
    energy: int | None = Field(default=None, ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=30)
    gratitude: list[str] = Field(default_factory=list, max_length=10)
    location: str = Field(default="", max_length=200)
    weather: str = Field(default="", max_length=120)
    starred: bool = False
    template_id: str | None = Field(default=None, max_length=40)
    prompt: str = Field(default="", max_length=500)
    ai_drafted: bool = False
    # The assistant rewrote or added to the text (edit_entry body/append).
    ai_edited: bool = False
    word_count: int = 0

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return _dedupe([norm_tag(t) for t in v])

    @field_validator("emotions")
    @classmethod
    def _emotions(cls, v: list[str]) -> list[str]:
        return _dedupe([norm_word(w) for w in v])

    @field_validator("gratitude")
    @classmethod
    def _gratitude(cls, v: list[str]) -> list[str]:
        return [g.strip()[:300] for g in v if g and g.strip()]

    @model_validator(mode="after")
    def _count(self) -> "Entry":
        # Always the truth, whoever wrote the entry.
        self.word_count = count_words(self.title, self.body, *self.gratitude)
        return self


class Template(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=5000, description="Markdown the new entry starts with")
    prompts: list[str] = Field(default_factory=list, max_length=20)
    gratitude_slots: int = Field(default=0, ge=0, le=10)
    target_words: int | None = Field(default=None, ge=10, le=5000)
    default_tags: list[str] = Field(default_factory=list, max_length=10)
    builtin: bool = False
    hidden: bool = False

    @field_validator("prompts")
    @classmethod
    def _prompts(cls, v: list[str]) -> list[str]:
        return [p.strip()[:300] for p in v if p and p.strip()]

    @field_validator("default_tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return _dedupe([norm_tag(t) for t in v])


class Settings(BaseModel):
    onboarded: bool = False
    daily_reminder: bool = False
    reminder_time: str = Field(default="21:00", pattern=TIME_RE)
    weekly_reminder: bool = False
    weekly_day: int = Field(default=6, ge=0, le=6, description="0 = Monday … 6 = Sunday")
    weekly_time: str = Field(default="18:00", pattern=TIME_RE)
    week_starts_on: int = Field(default=1, ge=0, le=1, description="0 = Sunday, 1 = Monday")
    default_template_id: str | None = Field(default=None, max_length=40)
    show_prompt: bool = True
    # What normal chats, search and Drive AI read (to_text): an outline
    # (dates, titles, moods, feelings, tags) always; a short excerpt of each
    # recent entry only when this is on. Off for new journals; files saved
    # before the default changed keep the value they stored.
    share_excerpts: bool = False
    # Lists show titles only (for journaling where others can see the screen).
    hide_previews: bool = False
    custom_prompts: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("custom_prompts")
    @classmethod
    def _prompts(cls, v: list[str]) -> list[str]:
        return [p.strip()[:300] for p in v if p and p.strip()]


class JournalData(BaseModel):
    entries: list[Entry] = Field(default_factory=list, max_length=MAX_ENTRIES)
    templates: list[Template] = Field(default_factory=list, max_length=MAX_TEMPLATES)
    settings: Settings = Field(default_factory=Settings)


BUILTIN_TEMPLATES: list[dict] = [
    {
        "id": "morning-pages",
        "name": "Morning pages",
        "description": "Three pages of stream-of-consciousness, first thing (Julia Cameron). No editing, no judging.",
        "body": "",
        "prompts": ["Write whatever is in your head — keep the pen moving until you hit 750 words."],
        "target_words": 750,
        "default_tags": ["morning-pages"],
    },
    {
        "id": "gratitude",
        "name": "Three good things",
        "description": "Three things that went well and why (Seligman's Three Good Things).",
        "body": "## Why they mattered\n\n",
        "prompts": [
            "What went well today, however small?",
            "What part did you — or someone else — play in it?",
        ],
        "gratitude_slots": 3,
        "default_tags": ["gratitude"],
    },
    {
        "id": "daily-review",
        "name": "Daily review",
        "description": "Wins, challenges and what's next.",
        "body": "## Wins\n\n\n## Challenges\n\n\n## Tomorrow\n\n",
        "prompts": ["What are you proud of today?", "What got in the way?", "What's the one thing that matters tomorrow?"],
        "default_tags": ["review"],
    },
    {
        "id": "weekly-reflection",
        "name": "Weekly reflection",
        "description": "Look back on the week and set an intention for the next one.",
        "body": "## Highlights\n\n\n## What was hard\n\n\n## What I learned\n\n\n## More of / less of\n\n\n## Intention for next week\n\n",
        "prompts": ["What moment from this week do you want to remember?", "What would make next week feel good?"],
        "default_tags": ["weekly"],
    },
    {
        "id": "evening",
        "name": "Evening wind-down",
        "description": "Settle the day so your mind can rest.",
        "body": "## How I'm feeling\n\n\n## Something kind I did, or someone did\n\n\n## What I'm letting go of tonight\n\n\n## Tomorrow I'll…\n\n",
        "prompts": ["What's still on your mind that you can set down for tonight?"],
        "default_tags": ["evening"],
    },
    {
        "id": "thought-record",
        "name": "Thought record",
        "description": "A CBT thought record: catch a thought, weigh the evidence, find a more balanced view.",
        "body": (
            "## Situation\n\n\n## Automatic thought\n\n\n## Emotions (0–100%)\n- \n\n"
            "## Evidence for\n\n\n## Evidence against\n\n\n## Balanced thought\n\n\n## Emotions now (0–100%)\n- \n"
        ),
        "prompts": [
            "What went through your mind just before you felt this way?",
            "If a friend had this thought, what would you tell them?",
            "Is there another way to look at this?",
        ],
        "default_tags": ["thought-record"],
    },
    {
        "id": "self-compassion",
        "name": "Self-compassion break",
        "description": "Kristin Neff's three steps: mindfulness, common humanity, kindness.",
        "body": "## What's hard right now\n\n\n## Others feel this too\n\n\n## What I'd say to a good friend\n\n",
        "prompts": ["This is a moment of difficulty. What do you need right now?"],
        "default_tags": ["self-compassion"],
    },
]


def builtin_templates() -> list[dict]:
    return [{**t, "builtin": True} for t in BUILTIN_TEMPLATES]
