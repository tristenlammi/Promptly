"""Cloze deletions — ``{{c1::answer}}`` / ``{{c1::answer::hint}}`` — and the
review items a card yields. Mirrored in ``frontend/.../flashcards/cards.ts``.

A cloze card makes one review item per cloze *number*: ``{{c1::Paris}} is
the capital of {{c2::France}}`` → ``c1`` and ``c2``; two deletions sharing
``c1`` are hidden together.
"""
from __future__ import annotations

import re

CLOZE_RE = re.compile(r"\{\{c(\d{1,2})::(.*?)(?:::(.*?))?\}\}", re.S)
OPEN_RE = re.compile(r"\{\{c\d+::")


class ClozeError(ValueError):
    pass


def cloze_numbers(text: str) -> list[int]:
    return sorted({int(m.group(1)) for m in CLOZE_RE.finditer(text or "") if int(m.group(1)) >= 1})


def validate_cloze(text: str) -> list[int]:
    """The cloze numbers in ``text``, or :class:`ClozeError` saying what's wrong."""
    text = text or ""
    matches = list(CLOZE_RE.finditer(text))
    if not matches:
        raise ClozeError("A cloze card needs at least one deletion like {{c1::answer}}.")
    if len(OPEN_RE.findall(text)) != len(matches):
        raise ClozeError("A cloze deletion isn't closed, or one is nested inside another (use {{c1::…}} side by side).")
    for m in matches:
        n = int(m.group(1))
        if n < 1:
            raise ClozeError("Cloze numbers start at c1.")
        if not m.group(2).strip():
            raise ClozeError(f"{{{{c{n}::…}}}} has an empty answer.")
    leftover = CLOZE_RE.sub("", text)
    if "{{c" in leftover and "::" in leftover:
        raise ClozeError("Some cloze syntax isn't well formed.")
    return cloze_numbers(text)


def review_keys(card_type: str, front: str) -> list[str]:
    if card_type == "reversed":
        return ["f", "r"]
    if card_type == "cloze":
        nums = cloze_numbers(front)
        return [f"c{n}" for n in nums] or ["c1"]
    return ["f"]


def render_plain(text: str, active: int | None = None, reveal: bool = True) -> str:
    """Plain text of a cloze side: the active number as ``[…]`` (or its hint)
    unless revealed, other deletions shown as their answers."""

    def sub(m: re.Match) -> str:
        n, ans, hint = int(m.group(1)), m.group(2), m.group(3)
        if active is not None and n == active and not reveal:
            return f"[{hint}]" if hint else "[…]"
        return ans

    return CLOZE_RE.sub(sub, text or "")
