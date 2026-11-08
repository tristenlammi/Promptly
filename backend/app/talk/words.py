"""What someone said, as far as turn-taking cares (WP-T2).

* **Self-echo filter:** the server knows exactly what Promptly is saying, so
  words in a partial that match what's being played are its own voice coming
  back through the microphone, not the person (WP-T0: browsers remove 16-24
  dB of echo, which on loud speakers still leaves enough to form a word now
  and then).
* **Backchannels:** "mm", "yeah", "uh-huh" while it talks are listening, not
  interrupting.
* **Stop words:** "stop", "wait", "hold on" interrupt on their own.
* **Goodbyes:** "that's all", "bye", "stop listening" end the conversation.
"""
from __future__ import annotations

import difflib
import re

_NORM = re.compile(r"[^\w']+", re.UNICODE)

BACKCHANNELS = frozenset(
    {
        "mm", "mmm", "mhm", "mmhmm", "hm", "hmm", "uh", "um", "uhm", "er", "erm", "ah", "oh", "ooh",
        "aha", "huh", "uhhuh", "yeah", "yep", "yup", "yes", "ya", "ok", "okay", "right", "sure", "alright",
        "cool", "nice", "wow", "true", "exactly", "totally", "gotcha", "see", "i",
    }
)
STOP_WORDS = frozenset({"stop", "wait", "pause", "quiet", "enough", "cancel", "shush", "shh", "hush"})
STOP_PHRASES = ("hold on", "hang on", "be quiet", "never mind", "that's enough", "one moment", "one second")
_GOODBYES = (
    "that's all", "that is all", "that'll be all", "that's everything", "bye", "bye bye", "goodbye",
    "good bye", "see you", "see ya", "stop listening", "i'm done", "we're done", "all done",
)
_POLITE = r"(?:ok|okay|alright|thanks|thank you|cheers|great|perfect|no|nope|that's it)"
_GOODBYE_RE = re.compile(
    r"^(?:" + _POLITE + r"\s+)*(?:" + "|".join(re.escape(g) for g in _GOODBYES) + r")"
    r"(?:\s+(?:" + _POLITE + r"|for now|promptly|then|now))*$"
)
_WAKE = re.compile(r"^\W*(?:(?:hey|hi|a|okay|ok)\W+)?promptly\b\W*", re.IGNORECASE)


def normalise(text: str) -> str:
    return " ".join(_NORM.sub(" ", (text or "").lower().replace("’", "'").replace("-", "")).split())


def tokens(text: str) -> list[str]:
    return normalise(text).split()


def without_wake_word(text: str) -> str:
    """People still start with "Hey Promptly" (the same rule as the phone's
    ``maps/assistant.py``)."""
    return _WAKE.sub("", (text or "").strip()).strip()


def is_goodbye(text: str) -> bool:
    return bool(_GOODBYE_RE.match(normalise(text)))


def _similar(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= 0.75


def echo_mask(heard: list[str], spoken: list[str]) -> list[bool]:
    """For each heard word, whether it is Promptly's own voice: matched, in
    order, against what it is saying (whisper may mangle a word or two of the
    echo, so near-misses count when most of the rest matches)."""
    if not heard or not spoken:
        return [False] * len(heard)
    mask = [False] * len(heard)
    sm = difflib.SequenceMatcher(None, heard, spoken, autojunk=False)
    for block in sm.get_matching_blocks():
        for i in range(block.a, block.a + block.size):
            mask[i] = True
    window = set(spoken)
    # A word heard as two ("to day") or two heard as one.
    for i in range(len(heard) - 1):
        if heard[i] + heard[i + 1] in window:
            mask[i] = mask[i + 1] = True
    pairs = {a + b for a, b in zip(spoken, spoken[1:])}
    for i, word in enumerate(heard):
        if not mask[i] and word in pairs:
            mask[i] = True
    if sum(mask) * 2 >= len(heard):
        for i, word in enumerate(heard):
            if not mask[i] and any(_similar(word, s) for s in window):
                mask[i] = True
    return mask


def real_words(text: str, spoken: str = "") -> list[str]:
    """The words that are really the person: not echo, not a backchannel."""
    heard = tokens(text)
    mask = echo_mask(heard, tokens(spoken))
    return [w for w, echo in zip(heard, mask) if not echo and w not in BACKCHANNELS]


def asks_to_stop(text: str, spoken: str = "") -> bool:
    heard = tokens(text)
    mask = echo_mask(heard, tokens(spoken))
    own = [w for w, echo in zip(heard, mask) if not echo]
    if any(w in STOP_WORDS for w in own):
        return True
    joined = " " + " ".join(own) + " "
    return any(f" {p} " in joined for p in STOP_PHRASES)


_THANKS = frozenset(
    {
        "got", "it", "thanks", "thank", "you", "that's", "fine", "good", "great", "perfect", "understood",
        "fair", "enough", "makes", "sense", "lovely", "brilliant", "noted", "all", "good", "cheers",
    }
)


def just_stop_or_thanks(text: str) -> bool:
    """Talk that stops it and wants no answer: "stop", "wait", "okay, got it",
    "thanks, that's fine"."""
    own = [w for w in tokens(text) if w not in BACKCHANNELS]
    if not own:
        return True
    rest = [w for w in own if w not in STOP_WORDS]
    if asks_to_stop(text) and all(w in _THANKS or w in {"hold", "hang", "on", "be", "never", "mind", "one", "moment", "second"} for w in rest):
        return True
    return all(w in _THANKS for w in own) and len(own) <= 4


def barges_in(text: str, spoken: str = "", *, min_words: int = 2) -> bool:
    """Whether a partial heard while Promptly talks should stop it: two real
    words that aren't its own echo or a backchannel, or a stop word."""
    return asks_to_stop(text, spoken) or len(real_words(text, spoken)) >= min_words
