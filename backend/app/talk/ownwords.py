"""Only your own words go to another person (Talk phase 2, WP-T9).

A message to someone (``post_to_room``), or a reply to an email from the car,
must say what you said this turn: at least :data:`NEEDED` of its words, after
normalising, are words you used. Everything else is refused with
:data:`REFUSED`. That stops the model, or an email, a web page or someone
else's message it just read, from putting words in your mouth while you can't
read them first.

Allowed on top of your words: a greeting ("Hi"), the recipient's name, "you"
and "your" for the "her", "him" and "them" you said ("tell Mum I love her" ->
"I love you"), and, on a trip, the arrival-time phrase ("I'll be there about
5:40"), which the trip supplies.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

NEEDED = 0.8
REFUSED = "I'll only send your own words."
PARKED = "Let's do that when you're parked."
CAR_REPLY_WORDS = 25

_NUMBERS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18", "nineteen": "19", "twenty": "20",
    "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60",
}
_SAME = {"mins": "minutes", "min": "minute", "hrs": "hours", "hr": "hour", "ok": "okay", "u": "you", "im": "im"}
_GREETINGS = {"hi", "hey", "hello", "hiya"}
# "you"/"your" in a message stand for the person you spoke of.
_SWAPS = {"you": {"her", "him", "them", "you"}, "your": {"her", "his", "their", "your"}, "youre": {"shes", "hes", "theyre", "youre"}}
# Said around an arrival time.
_ARRIVAL_WORDS = {
    "ill", "i", "will", "be", "there", "about", "around", "at", "by", "arriving", "arrive", "get", "getting", "home",
    "in", "should", "well", "we", "im", "eta", "pm", "am", "the", "soon",
}


def words(text: str) -> list[str]:
    """Lower case, no punctuation or apostrophes, numbers as digits ("ten" -> "10",
    "5:40" -> "5", "40")."""
    t = str(text or "").lower().replace("’", "'").replace("'", "")
    out: list[str] = []
    for w in re.findall(r"[a-z0-9]+", t):
        w = _NUMBERS.get(w, w)
        out.append(_SAME.get(w, w))
    return out


def _arrival_tokens(at: str | None) -> set[str]:
    """The numbers of an arrival time: "5:40 PM" -> {"5", "40"}."""
    return {w for w in words(at or "") if w.isdigit()}


def own(message: str, said: str, *, to: str | None = None, arrival: str | None = None) -> bool:
    """Is ``message`` the person's own words (``said``, this turn)?"""
    have = set(words(said))
    mine = words(message)
    allowed = _GREETINGS | set(words(to or ""))
    times = _arrival_tokens(arrival)
    if times and times <= set(mine):
        # The trip's arrival time is in it: the words around it come with it.
        allowed |= times | _ARRIVAL_WORDS
    counted = [w for w in mine if w not in allowed or w in have]
    if not counted:
        return True
    hits = sum(1 for w in counted if w in have or (w in _SWAPS and _SWAPS[w] & have))
    return hits / len(counted) >= NEEDED


def count(text: str) -> int:
    return len(words(text))


def first_sentence(text: str) -> bool:
    """One sentence at most (a reply from the car)."""
    parts = [p for p in re.split(r"(?<=[.!?])\s+", str(text or "").strip()) if p.strip()]
    return len(parts) <= 1


def all_in(items: Iterable[str], said: str) -> bool:
    """Every item's words were said (a list add)."""
    have = set(words(said))
    return all(set(words(i)) <= have for i in items)
