"""Spaced reviews: a learned concept's schedule, on the Flashcards FSRS engine
(``app.items.kinds.flashcards.fsrs``; nothing is copied here).

A concept gets a card when it is mastered; the card moves each time a review
step is answered. Study has no "learning steps" (the lesson was the
learning), so a card always goes straight to an interval in days.
"""
from __future__ import annotations

from datetime import datetime, tzinfo
from typing import Any

from app.items.kinds.flashcards import fsrs
from app.study import rules


def config(tz: tzinfo) -> fsrs.Config:
    return fsrs.Config(learning_steps=(), relearning_steps=(), tz=tz)


def due_of(card: dict[str, Any] | None) -> datetime | None:
    return fsrs.parse_moment(card["due"]) if card and card.get("due") else None


def first_card(concept_id: str, how: str, now: datetime, tz: tzinfo, old: dict[str, Any] | None = None) -> dict[str, Any]:
    """The card for a concept just mastered. ``how``: ``lesson``, ``test_out``
    or ``known``. One that was learned before and slipped keeps its history
    (``old``): its lapses still count."""
    cfg = config(tz)
    start = old if old and old.get("stability") else fsrs.new_srs(concept_id)
    return fsrs.review(start, rules.first_rating(how), now, cfg, concept_id)[0]


def rate(card: dict[str, Any] | None, concept_id: str, rating: int, now: datetime, tz: tzinfo) -> dict[str, Any]:
    """The card after a review answered ``rating`` (1 Again … 4 Easy)."""
    return fsrs.review(card or fsrs.new_srs(concept_id), rating, now, config(tz), concept_id)[0]


def days_until(card: dict[str, Any] | None, now: datetime, tz: tzinfo) -> int | None:
    """Study days from ``now`` until the card is due (0 or less = due)."""
    due = due_of(card)
    if due is None:
        return None
    cfg = config(tz)
    return fsrs.day_index(due, cfg) - fsrs.day_index(now, cfg)
