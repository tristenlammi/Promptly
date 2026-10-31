"""The shape of a ``.cards`` file. Every field has a default so old files
keep loading; every list is bounded so a file stays well under 8 MB.

Size budget (8 MB): 20k cards × ~350 B scheduling + text, plus a review
log of up to 100k entries (~90 B each, compact keys). The file's byte
limit usually bites first: the shell then offers "Archive older data"
(``SPEC.archive`` moves old review-log entries to a new file; scheduling
lives on the cards, so nothing about the schedule is lost). Past the
entry cap the oldest entries are dropped as a last resort — and counted
in ``log_trimmed`` (shown in Stats and ``to_text``), never silently.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .cloze import review_keys
from .fsrs import DEFAULT_WEIGHTS

MAX_CARDS = 20_000
MAX_DECKS = 500
MAX_LOG = 100_000
HEX = r"^#[0-9A-Fa-f]{6}$"
TIME = r"^([01]\d|2[0-3]):[0-5]\d$"

CardType = Literal["basic", "reversed", "cloze", "typein"]
SrsState = Literal["new", "learning", "review", "relearning"]


class Srs(BaseModel):
    """One review item: a card's front (``f``), reverse (``r``) or cloze
    number (``c1``, ``c2``…) — each is scheduled on its own."""

    k: str = Field(default="f", max_length=8)
    state: SrsState = "new"
    stability: float | None = Field(default=None, ge=0, le=1_000_000)
    difficulty: float | None = Field(default=None, ge=0, le=11)
    due: str | None = Field(default=None, max_length=40)  # ISO moment
    last_review: str | None = Field(default=None, max_length=40)
    reps: int = Field(default=0, ge=0, le=1_000_000)
    lapses: int = Field(default=0, ge=0, le=1_000_000)
    step: int | None = Field(default=None, ge=0, le=50)


class Card(BaseModel):
    id: str = Field(max_length=40)
    deck_id: str = Field(max_length=40)
    type: CardType = "basic"
    front: str = Field(default="", max_length=8000)  # Markdown + $math$; cloze text for cloze cards
    back: str = Field(default="", max_length=8000)  # the answer; "extra" shown under a cloze
    note: str = Field(default="", max_length=4000)  # source, mnemonic, explanation — shown after the answer
    tags: list[str] = Field(default_factory=list, max_length=30)
    flagged: bool = False
    suspended: bool = False
    buried_until: str | None = Field(default=None, max_length=10)  # study day (YYYY-MM-DD) it's hidden until (exclusive)
    created: str = Field(default="", max_length=40)
    modified: str = Field(default="", max_length=40)
    srs: list[Srs] = Field(default_factory=list, max_length=99)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for t in v:
            t = "".join(t.split())[:60]
            if t and t.lower() not in (x.lower() for x in out):
                out.append(t)
        return out

    @model_validator(mode="after")
    def _items(self) -> "Card":
        """One review item per key the content yields — kept when the key
        survives an edit (its history stays), added new, dropped when gone."""
        keys = review_keys(self.type, self.front)
        have = {s.k: s for s in self.srs}
        self.srs = [have.get(k) or Srs(k=k) for k in keys]
        return self


class Deck(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=120)  # this level only; the path is parent::…::name
    parent_id: str | None = Field(default=None, max_length=40)
    description: str = Field(default="", max_length=2000)
    color: str = Field(default="#5B6DD9", pattern=HEX)
    created: str = Field(default="", max_length=40)
    # Anki-style own daily limits (None = only the file-wide ones apply).
    # A deck's limit covers its subdecks; every limit on the way up applies.
    new_per_day: int | None = Field(default=None, ge=0, le=9999)
    max_reviews_per_day: int | None = Field(default=None, ge=0, le=99_999)


class Log(BaseModel):
    """One answer. Compact keys: card, review item, time, rating 1–4, state
    before (n/l/r/x), elapsed study days, scheduled days, duration ms."""

    c: str = Field(max_length=40)
    k: str = Field(default="f", max_length=8)
    t: str = Field(max_length=40)
    r: int = Field(ge=1, le=4)
    s: Literal["n", "l", "r", "x"] = "n"
    e: int = Field(default=0, ge=0, le=100_000)
    i: float = Field(default=0, ge=0, le=100_000)
    d: int = Field(default=0, ge=0, le=3_600_000)

    @field_validator("e", "d", mode="before")
    @classmethod
    def _clamp_int(cls, v, info):  # noqa: ANN001, ANN206
        """Clock skew between devices (or travelling west) can make the last
        review look "ahead" of this one → a negative elapsed. A review is
        never refused for that: clamp into range."""
        hi = 100_000 if info.field_name == "e" else 3_600_000
        try:
            n = int(round(float(v)))
        except (TypeError, ValueError):
            return 0
        return min(max(n, 0), hi)

    @field_validator("i", mode="before")
    @classmethod
    def _clamp_ivl(cls, v):  # noqa: ANN001, ANN206
        try:
            x = float(v)
        except (TypeError, ValueError):
            return 0.0
        return min(max(x, 0.0), 100_000.0) if x == x else 0.0


class Settings(BaseModel):
    desired_retention: float = Field(default=0.9, ge=0.7, le=0.99)
    new_per_day: int = Field(default=20, ge=0, le=9999)
    max_reviews_per_day: int = Field(default=200, ge=0, le=99_999)
    learning_steps: list[float] = Field(default_factory=lambda: [1.0, 10.0], max_length=10)  # minutes
    relearning_steps: list[float] = Field(default_factory=lambda: [10.0], max_length=10)
    maximum_interval: int = Field(default=36500, ge=1, le=36500)  # days
    fuzz: bool = True
    rollover_hour: int = Field(default=4, ge=0, le=23)
    new_mix: Literal["mixed", "before", "after"] = "mixed"  # new cards among reviews
    bury_siblings: bool = True  # one review item per card per day
    leech_threshold: int = Field(default=8, ge=2, le=100)  # lapses
    leech_action: Literal["tag", "suspend"] = "tag"
    weights: list[float] = Field(default_factory=lambda: list(DEFAULT_WEIGHTS), max_length=21)
    show_intervals: bool = True
    reminder_enabled: bool = True
    reminder_time: str = Field(default="19:00", pattern=TIME)
    streak_nudge: bool = False
    streak_nudge_time: str = Field(default="21:00", pattern=TIME)
    exam_date: str | None = Field(default=None, max_length=10)  # an upcoming exam (YYYY-MM-DD), for planning
    onboarded: bool = False

    @field_validator("learning_steps", "relearning_steps")
    @classmethod
    def _steps(cls, v: list[float]) -> list[float]:
        out = [round(float(x), 2) for x in v]
        if any(x <= 0 or x > 60 * 24 * 7 for x in out):
            raise ValueError("steps are minutes between 0 and 10080")
        return out

    @field_validator("weights")
    @classmethod
    def _weights(cls, v: list[float]) -> list[float]:
        if len(v) != 21:
            return list(DEFAULT_WEIGHTS)
        if v[20] <= 0:
            raise ValueError("w20 (decay) must be positive")
        return [float(x) for x in v]


class FlashcardsData(BaseModel):
    settings: Settings = Field(default_factory=Settings)
    decks: list[Deck] = Field(default_factory=list, max_length=MAX_DECKS)
    cards: list[Card] = Field(default_factory=list, max_length=MAX_CARDS)
    review_log: list[Log] = Field(default_factory=list, max_length=MAX_LOG)
    # How many of the oldest review-log entries were dropped at the cap
    # (shown to the person — archive instead to keep them).
    log_trimmed: int = Field(default=0, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _cap_log(cls, v):  # noqa: ANN001, ANN206 — never refuse a save for history, but say so
        if isinstance(v, dict) and isinstance(v.get("review_log"), list) and len(v["review_log"]) > MAX_LOG:
            extra = len(v["review_log"]) - MAX_LOG
            v = {**v, "review_log": v["review_log"][extra:]}
            try:
                v["log_trimmed"] = int(v.get("log_trimmed") or 0) + extra
            except (TypeError, ValueError):
                v["log_trimmed"] = extra
        return v

    @model_validator(mode="after")
    def _integrity(self) -> "FlashcardsData":
        ids = {d.id for d in self.decks}
        # A parent that's gone (or a loop) makes a deck top-level.
        parent = {d.id: d.parent_id for d in self.decks}
        for d in self.decks:
            if d.parent_id is not None and (d.parent_id not in ids or d.parent_id == d.id):
                d.parent_id = None
                parent[d.id] = None
        for d in self.decks:
            seen, cur = {d.id}, parent.get(d.id)
            while cur is not None:
                if cur in seen:
                    d.parent_id = None
                    parent[d.id] = None
                    break
                seen.add(cur)
                cur = parent.get(cur)
        # A card whose deck is gone lands in "Default".
        if any(c.deck_id not in ids for c in self.cards):
            if "default" not in ids:
                self.decks.append(Deck(id="default", name="Default"))
                ids.add("default")
            for c in self.cards:
                if c.deck_id not in ids:
                    c.deck_id = "default"
        return self

