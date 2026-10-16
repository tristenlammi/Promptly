"""Turning what someone said into exactly one command, or nothing.

The design rule here is **refuse to guess**. This matcher sits in front
of actions that turn off lights and, eventually, unlock doors — a fuzzy
match that is right 95% of the time is not a feature, it's a 1-in-20
chance of doing something nobody asked for. So:

* Matching is exact, after normalisation. No edit distance, no fuzzy
  scoring, no "did you mean".
* Slots capture a span, they don't loosen the rest of the phrase.
* Two commands matching equally well is a *no match*, not a coin flip.

Normalisation does the work that fuzziness would otherwise be asked to
do: case, punctuation, filler words and spacing are all levelled, so
"Promptly, please turn the garage lights off!" and "turn the garage
lights off" are the same utterance without anything being guessed.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable

from app.commands.constants import (
    LEADING_FILLER,
    MAX_SLOT_WORDS,
    MAX_SLOTS_PER_PHRASE,
    NEAR_MATCH_THRESHOLD,
    SLOT_CONNECTIVES,
    SLOT_NAME_MAX,
    TRAILING_FILLER,
)

_SLOT_RE = re.compile(r"\{([a-z0-9_]{1,%d})\}" % SLOT_NAME_MAX, re.IGNORECASE)
# Braces are slot *syntax*, not punctuation — spared here so a slotted
# phrase survives normalisation intact. (An earlier version swapped them
# for sentinel characters first, which this very regex then ate.)
_PUNCT_RE = re.compile(r"[^\w\s{}]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


# Spoken numbers arrive as digits. Measured on this machine: Whisper
# transcribes "twenty twenty five" as "2025" and "channel four" as
# "channel 4" — so a phrase someone WROTE as words would silently never
# fire when spoken, while matching fine when typed. That's the worst
# shape of bug here: it looks like voice is broken rather than like the
# phrase is wrong, and the matcher's refusal to guess means there's no
# near-miss to fall back on.
#
# This is canonicalisation, not fuzzy matching — the same move as
# lowercasing. "channel four" and "channel 4" are one utterance written
# two ways, and both sides land in the same form.
_NUMBER_WORDS: dict[str, int] = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}


def _numbers_to_digits(text: str) -> str:
    """Rewrite number words as digits, joining tens+unit pairs.

    Stops at 99 on purpose. Beyond that the written forms get ambiguous
    ("twenty twenty five" is a year, not 20 + 25) and Whisper emits
    digits for them anyway, so guessing would create mismatches rather
    than fix them. Write large numbers as digits in your phrases.
    """
    tokens = text.split(" ")
    out: list[str] = []
    i = 0
    while i < len(tokens):
        value = _NUMBER_WORDS.get(tokens[i])
        if value is None:
            out.append(tokens[i])
            i += 1
            continue
        # "twenty five" -> 25. Only a round ten followed by a unit; the
        # punctuation pass has already turned "twenty-five" into two
        # tokens, so both spellings land here.
        if value >= 20 and value % 10 == 0 and i + 1 < len(tokens):
            unit = _NUMBER_WORDS.get(tokens[i + 1])
            if unit is not None and 1 <= unit <= 9:
                out.append(str(value + unit))
                i += 2
                continue
        out.append(str(value))
        i += 1
    return " ".join(out)


def normalise(text: str) -> str:
    """Level an utterance so equivalent phrasings compare equal.

    Lowercase, strip accents and punctuation, collapse whitespace,
    rewrite number words as digits, then peel filler off both ends.
    Applied identically to stored phrases and to incoming speech, so the
    two can be compared with ``==``.
    """
    if not text:
        return ""
    # NFKD + drop combining marks: "café" and "cafe" should not be two
    # different commands, and speech-to-text is inconsistent about them.
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    lowered = stripped.lower()
    cleaned = _PUNCT_RE.sub(" ", lowered)
    cleaned = _WS_RE.sub(" ", cleaned).strip()
    cleaned = _numbers_to_digits(cleaned)
    return _strip_filler(cleaned)


def _clean_word(raw: str) -> list[str]:
    """One raw word as the normalised words it becomes ("O'Brien's" →
    o, brien, s; "21.5" → 21, 5)."""
    decomposed = unicodedata.normalize("NFKD", raw)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return _PUNCT_RE.sub(" ", stripped.lower()).split()


def _aligned(text: str) -> tuple[str, list[tuple[int, int]]]:
    """``normalise(text)`` plus, for each normalised word, the span of raw
    (whitespace-separated) words it came from — so a slot captured from
    the normalised form can be read back from what was actually said."""
    raw = text.split()
    words: list[tuple[str, int, int]] = []
    for i, r in enumerate(raw):
        for w in _clean_word(r):
            words.append((w, i, i))
    # Number words → digits, as _numbers_to_digits does, keeping spans.
    merged: list[tuple[str, int, int]] = []
    i = 0
    while i < len(words):
        w, a, b = words[i]
        value = _NUMBER_WORDS.get(w)
        if value is None:
            merged.append((w, a, b))
            i += 1
            continue
        if value >= 20 and value % 10 == 0 and i + 1 < len(words):
            unit = _NUMBER_WORDS.get(words[i + 1][0])
            if unit is not None and 1 <= unit <= 9:
                merged.append((str(value + unit), a, words[i + 1][2]))
                i += 2
                continue
        merged.append((str(value), a, b))
        i += 1
    joined = " ".join(w for w, _, _ in merged)
    kept = _strip_filler(joined)
    if not kept:
        return "", []
    kept_words = kept.split(" ")
    tokens = [w for w, _, _ in merged]
    for start in range(len(tokens) - len(kept_words) + 1):
        if tokens[start : start + len(kept_words)] == kept_words:
            spans = [(a, b) for _, a, b in merged[start : start + len(kept_words)]]
            return kept, spans
    return kept, []


def _original_slot(text: str, normalised: str, spans: list[tuple[int, int]], start: int, end: int) -> str | None:
    """The words the user actually said for a slot captured at
    ``normalised[start:end]``. Slot values used to be the normalised text,
    so "21.5" reached the tool as "21 5", "O'Brien's" as "o brien s" and
    "café" as "cafe" (R-162)."""
    if not spans:
        return None
    first = normalised.count(" ", 0, start)
    last = first + normalised[start:end].strip().count(" ")
    if last >= len(spans):
        return None
    raw = text.split()
    value = " ".join(raw[spans[first][0] : spans[last][1] + 1])
    words = [w for r in value.split() for w in _clean_word(r)]
    if words and all(w in _NUMBER_WORDS for w in words):
        # "twenty one" is a number to the tool — the digits, not the words.
        return normalised[start:end].strip()
    # Only the edges: keep "21.5" and "O'Brien's", drop "garage," / "door?".
    value = value.strip().strip(",;:!?\"“”()").rstrip(".")
    return value or None


def _strip_filler(text: str) -> str:
    """Peel wake words and politeness off both ends, repeatedly.

    Repeated because real utterances stack them: "hey promptly, could
    you please …" is three layers deep before the actual instruction.
    """
    changed = True
    while changed:
        changed = False
        for prefix in LEADING_FILLER:
            if text == prefix:
                return ""
            if text.startswith(prefix + " "):
                text = text[len(prefix) + 1 :]
                changed = True
                break
        for suffix in TRAILING_FILLER:
            if text == suffix:
                return ""
            if text.endswith(" " + suffix):
                text = text[: -(len(suffix) + 1)]
                changed = True
                break
    return text.strip()


def slot_names(phrase: str) -> list[str]:
    return [m.group(1).lower() for m in _SLOT_RE.finditer(phrase or "")]


def compile_phrase(phrase: str) -> re.Pattern[str] | None:
    """Build the regex for a slotted phrase, or ``None`` if it has none.

    Slots capture a non-greedy run of at least one character. Everything
    around them is escaped literally — a slot widens exactly one span
    and nothing else, which is what keeps this from drifting into fuzzy
    matching by the back door.
    """
    normalised = normalise(phrase)
    names = slot_names(normalised)
    if not names:
        return None
    if len(names) > MAX_SLOTS_PER_PHRASE or len(set(names)) != len(names):
        # Too many slots, or a repeated name we couldn't bind
        # unambiguously. Treat as unusable rather than half-working.
        return None

    out: list[str] = ["^"]
    cursor = 0
    for match in _SLOT_RE.finditer(normalised):
        out.append(re.escape(normalised[cursor : match.start()]))
        # Bounded to a handful of words. ``.+?`` let one slot swallow a
        # whole clause — "kitchen and the bathroom" arriving as a
        # single room name — which reaches Home Assistant as an
        # entity that cannot exist.
        out.append(
            rf"(?P<{match.group(1).lower()}>\S+(?:\s+\S+){{0,{MAX_SLOT_WORDS - 1}}})"
        )
        cursor = match.end()
    out.append(re.escape(normalised[cursor:]))
    out.append("$")
    try:
        return re.compile("".join(out))
    except re.error:
        return None


def _slots_are_sane(captured: dict[str, str | None]) -> bool:
    """Refuse a capture that is obviously a list rather than a name.

    "turn off the kitchen and the bathroom lights" fits the shape of
    "turn off the {room} lights" perfectly — the pattern can't tell the
    difference, but the *meaning* is two rooms, and acting on one made-up
    name is worse than not acting.
    """
    for value in captured.values():
        if not value:
            continue
        padded = f" {value.strip()} "
        if any(word in padded for word in SLOT_CONNECTIVES):
            return False
    return True


@dataclass
class MatchCandidate:
    """A command as the matcher sees it — id plus its phrasings."""

    command_id: object
    phrases: list[str]
    enabled: bool = True


@dataclass
class MatchResult:
    command_id: object
    # Slot captures, ready to merge into the action arguments.
    slots: dict[str, str] = field(default_factory=dict)
    # ``exact`` beats ``slot``; used to break ties before refusing.
    kind: str = "exact"


def near_matches(
    utterance: str, candidates: Iterable[MatchCandidate]
) -> list[tuple[object, float]]:
    """Commands that *nearly* matched, best first.

    This never causes an action. Its only job is to turn a silent miss
    into a question — "did you mean Kitchen Lamp Off?" — because the
    matcher's refusal to guess is only defensible if the user can find
    out why nothing happened.

    Scored by token overlap rather than edit distance, so the most
    common near miss — the same words in a different order — scores
    1.0. That's the case worth catching: "turn off the lights" against a
    phrase written "turn the lights off".

    The threshold is high on purpose. A wrong suggestion still hijacks a
    turn the model should have answered, so this errs toward saying
    nothing.
    """
    said = set(normalise(utterance).split())
    if not said:
        return []

    scored: dict[object, float] = {}
    for cand in candidates:
        if not cand.enabled:
            continue
        for phrase in cand.phrases or []:
            # Slot placeholders aren't words the user said; comparing
            # against "{room}" would penalise every slotted phrase.
            words = set(
                w
                for w in normalise(_SLOT_RE.sub(" ", phrase)).split()
                if w
            )
            if not words:
                continue
            overlap = len(said & words) / len(said | words)
            if overlap >= NEAR_MATCH_THRESHOLD:
                best = scored.get(cand.command_id, 0.0)
                scored[cand.command_id] = max(best, overlap)

    return sorted(scored.items(), key=lambda pair: -pair[1])


def match(
    utterance: str,
    candidates: Iterable[MatchCandidate],
    *,
    tied: list | None = None,
) -> MatchResult | None:
    """The one command this utterance means, or ``None``.

    Exact matches beat slot matches — "turn off the lights" should hit a
    command defined with those exact words rather than one defined as
    "turn off the {room} lights" with an empty-ish capture.

    Ambiguity inside a tier returns ``None``. Two commands claiming the
    same phrase is a mistake in the library, and the honest response is
    to do nothing and say so, not to pick the lower id. Pass ``tied`` to
    learn which commands tied, so History can say so (R-163).
    """
    said = normalise(utterance)
    if not said:
        return None
    aligned, spans = _aligned(utterance)
    if aligned != said:
        spans = []  # can't line them up — fall back to the normalised words

    exact: list[MatchResult] = []
    slotted: list[MatchResult] = []

    for cand in candidates:
        if not cand.enabled:
            continue
        for phrase in cand.phrases or []:
            pattern = compile_phrase(phrase)
            if pattern is None:
                if normalise(phrase) and normalise(phrase) == said:
                    exact.append(
                        MatchResult(command_id=cand.command_id, kind="exact")
                    )
                continue
            found = pattern.match(said)
            if found and _slots_are_sane(found.groupdict()):
                slots: dict[str, str] = {}
                for k, v in (found.groupdict() or {}).items():
                    if not v or not v.strip():
                        continue
                    slots[k] = (
                        _original_slot(utterance, said, spans, found.start(k), found.end(k))
                        or v.strip()
                    )
                slotted.append(
                    MatchResult(command_id=cand.command_id, slots=slots, kind="slot")
                )

    for tier in (exact, slotted):
        if not tier:
            continue
        # Several phrases on the SAME command matching is fine; several
        # different commands matching is the ambiguity we refuse.
        distinct = {r.command_id for r in tier}
        if len(distinct) == 1:
            return tier[0]
        if tied is not None:
            tied.extend(dict.fromkeys(r.command_id for r in tier))
        return None
    return None
