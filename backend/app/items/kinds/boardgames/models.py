"""Game Night — the shape of one ``.games`` file.

Everything has a default so old files keep loading; every list is bounded so
a file stays well under the 8 MB limit after years of game nights.

Scores: a seat (or a team) holds what was typed on the pad — ``scores`` per
score category, ``rounds`` per round, or a plain ``total`` — and, once the
play is finished, the computed ``score``, ``place`` and ``winner``. Stats
read the finished fields, so editing a game's scoring later never rewrites
history.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

Num = Annotated[int | float, Field(ge=-10_000_000, le=10_000_000)]
Hex = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
Day = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Id = Annotated[str, Field(min_length=1, max_length=48)]

WinCondition = Literal["high", "low", "winlose", "coop", "teams", "ranked"]
PadKind = Literal["categories", "rounds", "total"]

WIN_LABELS = {
    "high": "Highest score wins",
    "low": "Lowest score wins",
    "winlose": "Win / lose",
    "coop": "Co-operative (win or lose together)",
    "teams": "Teams",
    "ranked": "Ranked placement (finishing order)",
}


class Settings(BaseModel):
    me_player_id: str | None = Field(default=None, max_length=48)
    default_location: str = Field(default="", max_length=80)
    elo_k: int = Field(default=32, ge=4, le=100)
    confetti: bool = True
    keep_screen_on: bool = True
    onboarded: bool = False
    min_plays_for_best: int = Field(default=3, ge=1, le=50)


class Player(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=60)
    color: Hex = "#C2557A"
    favorite: bool = False
    archived: bool = False
    me: bool = False
    bgg_user: str = Field(default="", max_length=60)
    notes: str = Field(default="", max_length=500)
    created: str = Field(default="", max_length=40)


class ScoreCategory(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=60)
    hint: str = Field(default="", max_length=160)
    section: str = Field(default="", max_length=40)
    # Points = value × multiplier, negated when ``subtract`` (penalties
    # typed as positive numbers: "Unfinished tickets").
    multiplier: Num = 1
    subtract: bool = False
    step: Num = 1
    # Quick values for the number pad (Yahtzee: 0 / 25 for a full house).
    options: list[Num] = Field(default_factory=list, max_length=12)
    min: Num | None = None
    max: Num | None = None
    # Counts only when this other category (id) scored something — Yahtzee's
    # bonus needs a 50 in the Yahtzee box.
    requires: str | None = Field(default=None, max_length=48)


class BonusRule(BaseModel):
    """``points`` once the categories (raw points) reach ``threshold`` —
    Yahtzee's 35 for 63+ in the upper section."""

    id: Id
    name: str = Field(min_length=1, max_length=60)
    categories: list[str] = Field(default_factory=list, max_length=40)
    threshold: Num = 0
    points: Num = 0


class Scoring(BaseModel):
    win: WinCondition = "high"
    pad: PadKind = "total"
    categories: list[ScoreCategory] = Field(default_factory=list, max_length=40)
    bonuses: list[BonusRule] = Field(default_factory=list, max_length=10)
    rounds: int | None = Field(default=None, ge=1, le=100)
    target_score: Num | None = None
    tiebreaker: str = Field(default="", max_length=400)
    notes: str = Field(default="", max_length=600)  # end conditions, quirks
    factions: list[str] = Field(default_factory=list, max_length=40)


class Expansion(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=80)
    categories: list[ScoreCategory] = Field(default_factory=list, max_length=20)
    factions: list[str] = Field(default_factory=list, max_length=20)


class Game(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=100)
    year: int | None = Field(default=None, ge=-3000, le=2100)
    min_players: int = Field(default=1, ge=1, le=100)
    max_players: int = Field(default=8, ge=1, le=100)
    play_minutes: int | None = Field(default=None, ge=1, le=10_000)
    weight: float | None = Field(default=None, ge=1, le=5)
    categories: list[str] = Field(default_factory=list, max_length=12)
    bgg_id: int | None = Field(default=None, ge=1, le=10_000_000)
    template_id: str | None = Field(default=None, max_length=48)
    scoring: Scoring = Field(default_factory=Scoring)
    expansions: list[Expansion] = Field(default_factory=list, max_length=30)
    favorite: bool = False
    owned: bool = True
    notes: str = Field(default="", max_length=1000)
    created: str = Field(default="", max_length=40)


class Entry(BaseModel):
    """What a seat or a team scored (typed) plus the result once finished."""

    scores: dict[str, Num] = Field(default_factory=dict, max_length=60)
    rounds: list[Num | None] = Field(default_factory=list, max_length=100)
    total: Num | None = None  # a typed total (the "total" pad, or a quick log)
    tiebreak: int | None = Field(default=None, ge=0, le=100)  # lower wins a tie
    score: Num | None = None  # computed at finish
    place: int | None = Field(default=None, ge=1, le=100)
    winner: bool = False


class Team(Entry):
    id: Id
    name: str = Field(min_length=1, max_length=40)
    color: Hex = "#3B7DD8"


class Seat(Entry):
    player_id: Id
    team_id: str | None = Field(default=None, max_length=48)
    faction: str = Field(default="", max_length=60)
    first_play: bool = False
    note: str = Field(default="", max_length=200)


class Play(BaseModel):
    id: Id
    game_id: Id
    status: Literal["active", "finished"] = "finished"
    date: Day = "2000-01-01"
    started_at: str | None = Field(default=None, max_length=40)
    ended_at: str | None = Field(default=None, max_length=40)
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    location: str = Field(default="", max_length=80)
    notes: str = Field(default="", max_length=2000)
    seats: list[Seat] = Field(default_factory=list, max_length=30)
    teams: list[Team] = Field(default_factory=list, max_length=12)
    expansions: list[str] = Field(default_factory=list, max_length=30)
    coop_won: bool | None = None
    manual: bool = False  # results typed by hand (instant wins, house rules)
    round: int = Field(default=0, ge=0, le=100)  # the pad's current round (0-based)
    focus: int = Field(default=0, ge=0, le=30)  # whose turn on the pad
    timer_started_at: str | None = Field(default=None, max_length=40)
    timer_elapsed_s: int = Field(default=0, ge=0, le=10_000_000)
    tiebreak_note: str = Field(default="", max_length=200)
    created_at: str = Field(default="", max_length=40)


class GamesData(BaseModel):
    settings: Settings = Field(default_factory=Settings)
    players: list[Player] = Field(default_factory=list, max_length=500)
    games: list[Game] = Field(default_factory=list, max_length=1000)
    plays: list[Play] = Field(default_factory=list, max_length=6_000)  # ~1 KB each with scores: stays under 8 MB
