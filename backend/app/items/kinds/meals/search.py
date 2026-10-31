"""Food search that finds the basics: "eggs" → "Egg, whole", "bananas" →
"Banana", "yoghurt" → "Yogurt", "aubergine" → "Eggplant", "yog" → "Yogurt".

Both the query and the food's name/brand go through the same steps —
lower-case, accents off, split into words, regional spellings and a small
synonym map to one canonical word, then a crude plural/singular stem — and a
query word matches a food word when it's equal, or a prefix of it (3+
letters, for type-ahead). The frontend mirrors this exactly
(``frontend/src/items/kinds/meals/lib.ts`` — ``foodTokens`` / ``scoreFood``);
keep the two in step.
"""
from __future__ import annotations

import re
import unicodedata

# Regional spellings and everyday synonyms → one canonical word (AU / UK / US).
CANON: dict[str, str] = {
    # spellings
    "yoghurt": "yogurt",
    "yoghourt": "yogurt",
    "yogourt": "yogurt",
    "doughnut": "donut",
    "chilli": "chili",
    "chile": "chili",
    "flavour": "flavor",
    "flavoured": "flavored",
    "savoury": "savory",
    "colour": "color",
    "fibre": "fiber",
    "wholemeal": "wholewheat",
    "skimmed": "skim",
    "fillet": "filet",
    "omelette": "omelet",
    "catsup": "ketchup",
    # synonyms
    "aubergine": "eggplant",
    "courgette": "zucchini",
    "capsicum": "pepper",
    "prawn": "shrimp",
    "coriander": "cilantro",
    "rocket": "arugula",
    "beetroot": "beet",
    "mince": "ground",
    "minced": "ground",
    "biscuit": "cookie",
    "crisp": "chip",
    "porridge": "oatmeal",
    "maize": "corn",
    "sultana": "raisin",
    "garbanzo": "chickpea",
    "swede": "rutabaga",
    "rockmelon": "cantaloupe",
    "lolly": "candy",
    "cornflour": "cornstarch",
    "icing": "frosting",
    "spud": "potato",
    "tinned": "canned",
    "jello": "jelly",
    "kiwifruit": "kiwi",
}

# Plurals the suffix rules get wrong.
IRREGULAR: dict[str, str] = {
    "leaves": "leaf",
    "loaves": "loaf",
    "halves": "half",
    "knives": "knife",
    "teeth": "tooth",
    "geese": "goose",
    "mice": "mouse",
    "fungi": "fungus",
    "cacti": "cactus",
}

_WORD = re.compile(r"[a-z0-9]+")


def stem(w: str) -> str:
    """A crude, consistent singular: ``eggs``/``egg`` → ``egg``, ``berries``/
    ``berry`` → ``berry``, ``tomatoes`` → ``tomato``, ``cookies``/``cookie`` →
    ``cooky`` (internal only — both sides get the same treatment)."""
    if w in IRREGULAR:
        return IRREGULAR[w]
    if len(w) > 4 and w.endswith("sses"):
        w = w[:-2]
    elif len(w) > 4 and w.endswith(("xes", "zes", "ches", "shes", "oes")):
        w = w[:-2]
    elif len(w) > 4 and w.endswith("ies"):
        w = w[:-3] + "y"
    elif len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        w = w[:-1]
    if len(w) > 3 and w.endswith("ie"):
        w = w[:-2] + "y"
    return w


def _fold(text: str) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in t if not unicodedata.combining(ch))


def tokens(text: str) -> list[str]:
    """The normalised words of a name / query."""
    out: list[str] = []
    for w in _WORD.findall(_fold(text)):
        s = stem(CANON.get(w, w))
        out.append(stem(CANON.get(s, s)))
    return out


def _match(q: str, words: list[str]) -> float:
    best = 0.0
    for w in words:
        if w == q:
            return 1.0
        if len(q) >= 3 and w.startswith(q):
            best = max(best, 0.85)
        elif len(w) >= 4 and q.startswith(w) and len(q) - len(w) <= 2:
            best = max(best, 0.7)  # "yogurts" typed past the stem
    return best


def score(name: str, brand: str, query: str) -> float:
    """0 = no match; higher is better. Name words count more than brand."""
    qs = tokens(query)
    if not qs:
        return 0.0
    name_w = tokens(name)
    words = name_w + tokens(brand or "")
    hits = [_match(q, words) for q in qs]
    matched = sum(1 for h in hits if h > 0)
    if matched == 0:
        return 0.0
    s = sum(hits) / len(qs)
    if matched == len(qs):
        s += 0.3
    if name_w and name_w[0] == qs[0]:
        s += 0.5  # "egg" → "Egg, whole" before "Scotch egg"
    elif name_w and len(qs[0]) >= 3 and name_w[0].startswith(qs[0]):
        s += 0.3
    return s
