"""Finding facts by the words in them, alongside finding them by meaning.

An embedding is good at "what should I eat before my run" and poor at the things
people actually remember by: "Parcel 7534", "Marrow Constructions", "Priya". So the
two are ranked separately and fused. Runs in Python, over one person's facts, because
that's a small list and it needs no language configuration: it works the same in any
language, and with no embedder at all.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Hashable, Iterable, TypeVar

Id = TypeVar("Id", bound=Hashable)

_K1 = 1.2
_B = 0.75
# How much a rank counts for when fusing. 60 is the usual constant: it keeps one
# list's top result from drowning out agreement between the two.
_FUSE_K = 60

_STOPWORDS = frozenset(
    """a about after again all also am an and any are as at be because been before being but by can could did do does
    doing done for from get got had has have having he her here hers him his how i if in into is it its just like me
    more most my no nor not now of on once only or our out over own please she should so some such than that the their
    them then there these they this those to too up us user users very want was we were what when where which who whom
    why will with would yes you your""".split()
)
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")


def _stem(word: str) -> str:
    """Just enough for "rehearses" and "rehearse" to meet. Numbers stay whole."""
    if word.isdigit():
        return word
    for suffix, shortest in (("ies", 3), ("ing", 4), ("ed", 4), ("es", 3), ("s", 3)):
        if word.endswith(suffix) and len(word) - len(suffix) >= shortest:
            return word[: -len(suffix)]
    return word


def tokens(text: str) -> list[str]:
    out: list[str] = []
    for word in _WORD.findall((text or "").lower()):
        if _CJK.search(word):
            # No spaces to split on: overlapping pairs of characters find words well.
            out.extend(word[i : i + 2] for i in range(max(1, len(word) - 1)))
        elif word not in _STOPWORDS:
            out.append(_stem(word))
    return out


def keyword_ranking(query: str, documents: Iterable[tuple[Id, str]]) -> list[tuple[Id, float]]:
    """BM25: rare words count for more, and matching more of them beats repeating one."""
    wanted = set(tokens(query))
    docs = [(doc_id, Counter(tokens(content))) for doc_id, content in documents]
    if not wanted or not docs:
        return []
    average = sum(sum(c.values()) for _, c in docs) / len(docs) or 1.0
    holding = Counter(word for _, c in docs for word in wanted if word in c)
    scored: list[tuple[Id, float]] = []
    for doc_id, counts in docs:
        length = sum(counts.values())
        score = 0.0
        for word in wanted & counts.keys():
            idf = math.log(1 + (len(docs) - holding[word] + 0.5) / (holding[word] + 0.5))
            tf = counts[word]
            score += idf * tf * (_K1 + 1) / (tf + _K1 * (1 - _B + _B * length / average))
        if score > 0:
            scored.append((doc_id, score))
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored


def fuse(*rankings: list[Id]) -> dict[Id, float]:
    """Reciprocal rank fusion: scores from different scales can't be added, positions can."""
    fused: dict[Id, float] = {}
    for ranking in rankings:
        for place, doc_id in enumerate(ranking):
            fused[doc_id] = fused.get(doc_id, 0.0) + 1.0 / (_FUSE_K + place + 1)
    return fused
