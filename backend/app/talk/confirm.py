"""Is a spoken answer to "add the dentist on Thursday?" a yes, a no, or neither?

One matcher for everything that waits for a spoken yes (WP-T3): Talk's
read-backs and the phone's ``/api/assistant``. A port of the web overlay's
``frontend/src/lib/spokenConfirm.ts`` (R-131), which replaced a regex
anchored only at the start ("Okay, cancel that" and "Do it later" both ran
the command). The safe reading of anything unclear is no:

* **yes** only when the whole answer is made of yes-words and has a real yes
  in it ("yes please", "okay, do it", "go ahead"). "Please" or "it" alone
  isn't one, and any stop word anywhere ("sure, wait no") makes it not a yes.
* **a bare no** when it's only a no ("no", "nope, never mind", "don't").
  Nothing else to say, so there's nothing for the model to do.
* anything else (``None``): not a yes, so whatever was waiting doesn't
  happen, and the words go to the model as what they want instead ("no, I
  meant Friday").
"""
from __future__ import annotations

import re
import unicodedata
from typing import Literal

# How long a read-back waits for its answer once it has been said, like the
# web overlay's PENDING_TTL_MS. An answer after this is a new request.
ASK_TTL_S = 20.0

# Any of these anywhere means not a yes.
STOP_WORDS = frozenset(
    {"no", "nope", "nah", "not", "dont", "cancel", "stop", "wait", "hold", "never", "later", "abort", "negative"}
)
# Words a yes may be built from ("yes please", "okay do it", "go ahead").
YES_WORDS = frozenset(
    {
        "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "affirmative",
        "absolutely", "definitely", "please", "go", "ahead", "do", "it", "for", "that", "thing",
    }
)
# At least one of these, or a phrase below: "it" or "please" alone isn't a yes.
CORE_YES = frozenset(
    {"yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "affirmative", "absolutely", "definitely"}
)
CORE_PHRASES = ("go ahead", "do it", "go for it")
# What a bare no may be made of, besides the stop words: "no thanks",
# "never mind", "don't do it", "not now".
_NO_FILLER = frozenset(
    {"thanks", "thank", "you", "mind", "that", "it", "do", "now", "please", "leave", "forget", "actually", "ok", "okay", "oh"}
)

_ACCENTS = re.compile(r"[̀-ͯ]")
_APOSTROPHES = re.compile(r"[‘’']")
_NOT_WORDS = re.compile(r"[^a-z0-9 ]+")


def normalise_answer(text: str) -> str:
    """Lower case, no accents, apostrophes dropped ("don't" -> "dont"), only
    letters, digits and single spaces."""
    t = unicodedata.normalize("NFKD", (text or "").lower())
    t = _ACCENTS.sub("", t)
    t = _APOSTROPHES.sub("", t)
    t = _NOT_WORDS.sub(" ", t)
    return " ".join(t.split())


def is_yes(utterance: str) -> bool:
    said = normalise_answer(utterance)
    if not said:
        return False
    words = said.split(" ")
    if any(w in STOP_WORDS for w in words):
        return False
    if not all(w in YES_WORDS for w in words):
        return False
    return any(w in CORE_YES for w in words) or any(p in said for p in CORE_PHRASES)


def is_bare_no(utterance: str) -> bool:
    """Just no, with nothing else to say: "no", "no thanks", "nope, never
    mind", "don't", "cancel that". ("No, Friday" isn't: it says something.)"""
    words = normalise_answer(utterance).split()
    if not words or len(words) > 5:
        return False
    if not any(w in STOP_WORDS for w in words):
        return False
    return all(w in STOP_WORDS or w in _NO_FILLER for w in words)


Answer = Literal["yes", "no"]


def answer(utterance: str) -> Answer | None:
    """``"yes"``, ``"no"`` (a bare no), or None: something else was said."""
    if is_yes(utterance):
        return "yes"
    if is_bare_no(utterance):
        return "no"
    return None
