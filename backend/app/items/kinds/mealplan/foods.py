"""Food knowledge: ingredient names → grocery keys, store aisles, allergen
and diet checks. Plain keyword tables — predictable and fast.

The tables live in ``foods.json`` next to this file. The frontend imports a
byte-identical copy (``frontend/src/items/kinds/mealplan/foods.json``) and
ports the matching below in ``foods.ts``, so the allergy warnings in the app
and the server's refusals agree. After editing the JSON, copy it over the
frontend file — ``tests/test_item_mealplan.py`` fails when they differ."""
from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).with_name("foods.json")
DATA: dict = json.loads(DATA_PATH.read_text(encoding="utf-8"))

# ------------------------------------------------------------- normalising

_FOLD = {"œ": "oe", "æ": "ae", "ß": "ss", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "’": "'", "‘": "'", "ʼ": "'"}


def normalize(text: str) -> str:
    """Lowercase, accents and ligatures folded ("Crème fraîche" → "creme
    fraiche", "Ĺabneh" → "labneh"), punctuation → spaces, single-spaced.
    Parenthesised words are kept (allergen checks must see them)."""
    s = unicodedata.normalize("NFKD", (text or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    for a, b in _FOLD.items():
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return " ".join(s.split())


def _clean_text(name: str) -> str:
    """:func:`normalize` without parentheticals — for names and keys."""
    return normalize(re.sub(r"\([^)]*\)", " ", name or ""))


# ------------------------------------------------------------------ aisles

AISLES: dict[str, str] = dict(DATA["aisles"])
AISLE_ORDER = list(AISLES)
_AISLE_WORDS: dict[str, list[str]] = DATA["aisle_words"]
# Word that changes the aisle whatever else matches.
_PRIORITY = [tuple(x) for x in DATA["aisle_priority"]]

_PHRASES: list[tuple[str, str]] = sorted(
    ((normalize(w), a) for a, ws in _AISLE_WORDS.items() for w in ws), key=lambda t: len(t[0]), reverse=True
)


def _has_phrase(text: str, word: str) -> bool:
    """``word`` in ``text`` as a whole word (plural allowed); a stem such
    as "strawberr" matches the start of a word."""
    if word.endswith(("err", "anchov")):
        return re.search(r"(?<![a-z])" + re.escape(word), text) is not None
    return re.search(r"(?<![a-z'])" + re.escape(word) + r"(?:s|es)?(?![a-z])", text) is not None


def aisle_for(name: str) -> str:
    """The store aisle for an ingredient name (``other`` when unsure)."""
    low = _clean_text(name)
    for word, aisle in _PRIORITY:
        if _has_phrase(low, word.strip()):
            if word == "dried ":
                for w, a in _PHRASES:
                    if a == "spices" and _has_phrase(low, w):
                        return "spices"
            return aisle
    for word, aisle in _PHRASES:
        if _has_phrase(low, word):
            return aisle
    return "other"




# ------------------------------------------------------------------ names

_PREP_WORDS = set(DATA["prep_words"])
_SINGULAR_EXCEPT = set(DATA["singular_except"])
_SINGULAR_MAP: dict[str, str] = DATA["singular_map"]
SYNONYMS: dict[str, str] = {normalize(k): v for k, v in DATA["synonyms"].items()}
LIQUIDS: dict[str, float] = DATA["liquids"]
FLUID_OZ = set(DATA["fluid_oz"])


def singular(word: str) -> str:
    w = word.lower()
    if w in _SINGULAR_MAP:
        return _SINGULAR_MAP[w]
    if w in _SINGULAR_EXCEPT or len(w) <= 3:
        return w
    if w.endswith("ies"):
        return w[:-3] + "y"
    if w.endswith("oes"):
        return w[:-2]
    if w.endswith(("ches", "shes", "xes", "sses", "zes")):
        return w[:-2]
    if w.endswith("ss") or w.endswith("us") or w.endswith("is"):
        return w
    if w.endswith("s"):
        return w[:-1]
    return w


def plural(word: str) -> str:
    w = word
    if not w:
        return w
    low = w.lower()
    if low.endswith(("rice", "flour", "sugar", "salt", "milk", "water", "oil", "butter", "cheese", "garlic", "pepper", "ginger", "cream", "yogurt", "spinach", "lettuce", "kale", "parsley", "coriander", "cilantro", "basil", "mint")):
        return w
    if low.endswith(("s", "x", "ch", "sh")):
        return w + "es" if not low.endswith("s") else w
    if low.endswith(("tomato", "potato", "mango")):
        return w + "es"
    if low.endswith("y") and len(low) > 1 and low[-2] not in "aeiou":
        return w[:-1] + "ies"
    if low.endswith("leaf"):
        return w[:-1] + "ves"
    return w + "s"




def _syn(words: list[str]) -> str:
    key = " ".join(words)
    return SYNONYMS.get(key, key)


def ingredient_key(name: str) -> str:
    """The grocery identity of an ingredient: "2 Large Onions, diced" and
    "onion" are both ``onion``; "extra-virgin olive oil" and "olive oil",
    "cheddar cheese" and "cheddar", "plain flour" and "flour" are one item
    (explicit synonyms — never a loose subset of words)."""
    text = _clean_text(name.split(",")[0] if "," in name else name)
    full = [w for w in text.split() if not w.replace("'", "").isdigit()]
    if full:
        whole = full[:-1] + [singular(full[-1])]
        if " ".join(whole) in SYNONYMS:
            return _syn(whole)[:80]
    words = [w for w in full if w not in _PREP_WORDS]
    if not words:
        words = text.split()[:3]
    if not words:
        return ""
    words[-1] = singular(words[-1])
    return _syn(words)[:80]


_SPOONISH = {"tsp", "tbsp", "pinch", "dash", "g", "mg"}


def grocery_key(item: str, unit: str = "", qty: float | None = None) -> str:
    """:func:`ingredient_key`, plus the one context rule a name can't carry:
    "½ tsp pepper" / "pepper, to taste" is black pepper, "1 pepper" a
    capsicum."""
    key = ingredient_key(item)
    if key == "pepper" and (unit in _SPOONISH or qty is None):
        return "black pepper"
    return key


def liquid_density(key: str) -> float | None:
    """g per ml for a liquid ingredient key (None when it isn't one)."""
    if key in LIQUIDS:
        return LIQUIDS[key]
    for w in sorted(LIQUIDS, key=len, reverse=True):
        if key.endswith(" " + w):
            return LIQUIDS[w]
    return None


def oz_means_fluid(key: str) -> bool:
    """"8 oz milk" is fluid ounces; "8 oz cheese" is weight."""
    if key in FLUID_OZ:
        return True
    return any(key.endswith(" " + w) for w in FLUID_OZ)


def display_name(key: str, qty: float | None = None, unitless: bool = True) -> str:
    if not key:
        return ""
    name = key
    if unitless and qty is not None and qty > 1 + 1e-9:
        parts = name.split(" ")
        parts[-1] = plural(parts[-1])
        name = " ".join(parts)
    return name[:1].upper() + name[1:]


# Never worth buying.
ALWAYS_HAVE = set(DATA["always_have"])
# Ignored when asking "what can I make".
BASIC_STAPLES = {
    "salt", "black pepper", "salt and pepper", "salt pepper", "water", "oil", "olive oil",
    "vegetable oil", "cooking spray", "sugar", "flour", "butter",
}


# --------------------------------------------------------------- allergens
#
# Each allergen has ``words`` (matched at the start of a word, so plurals and
# compounds count: "almond" → "almonds", "anchov" → "anchovies"), ``whole``
# words (matched whole, plural allowed: "bun" but not "bunch") and ``safe``
# phrases that are removed first ("coconut milk" for dairy, "nutmeg" for
# nuts). "<allergen> free <thing>" ("gluten-free pasta", "dairy-free
# cheese") is removed too — only that phrase, so "flour, or use gluten-free"
# still flags the flour. Matching runs on the item AND its note.

ALLERGENS: dict[str, tuple[list[str], list[str]]] = {
    k: ([normalize(w) for w in v["words"]], [normalize(w) for w in v["safe"]]) for k, v in DATA["allergens"].items()
}
WHOLE_WORDS: dict[str, list[str]] = {k: [normalize(w) for w in v.get("whole", [])] for k, v in DATA["allergens"].items()}
_ALLERGY_ALIASES: dict[str, str] = {normalize(k): v for k, v in DATA["allergy_aliases"].items()}
ALLERGY_GROUPS: dict[str, list[str]] = DATA["allergy_groups"]
_ALLERGY_NOISE = re.compile(r"^(?:allergic to|allergy to|allergies to|intolerant to|no)\s+|\s+(?:allergy|allergies|intolerance|intolerant|allergic)$")


@lru_cache(maxsize=512)
def _word_re(word: str, whole: bool) -> re.Pattern:
    tail = r"(?:s|es)?(?![a-z])" if whole else ""
    return re.compile(r"(?<![a-z])" + re.escape(word) + tail)


def _contains(text: str, word: str) -> bool:
    return _word_re(word, False).search(text) is not None


def _without(text: str, phrases: list[str]) -> str:
    for p in phrases:
        if p:
            text = re.sub(r"(?<![a-z])" + re.escape(p) + r"(?:s|es)?(?![a-z])", " ", text)
    return text


def _hits(texts: list[str], words: list[str], safe: list[str], whole: list[str] = (), free: list[str] = ()) -> list[str]:
    out = []
    free_re = None
    if free:
        alts = "|".join(re.escape(f) for f in sorted(set(free), key=len, reverse=True) if f)
        free_re = re.compile(r"(?<![a-z])(?:" + alts + r") free(?: [a-z']+)?(?![a-z])")
    for t in texts:
        low = " " + normalize(t) + " "
        if free_re is not None:
            low = free_re.sub(" ", low)
        low = _without(low, safe)
        if any(_word_re(w, False).search(low) for w in words if w) or any(_word_re(w, True).search(low) for w in whole if w):
            out.append(t)
    return out


def _matches(texts: list[str], words: list[str], safe: list[str]) -> list[str]:
    return _hits(texts, [normalize(w) for w in words], [normalize(s) for s in safe])


def allergy_key(allergy: str) -> str:
    a = normalize(allergy)
    a = _ALLERGY_NOISE.sub("", a).strip()
    return _ALLERGY_ALIASES.get(a, a)


def allergy_keys(allergy: str) -> list[str]:
    """The allergen tables an allergy (as the person wrote it) covers:
    "nuts" → tree nuts AND peanuts, "seafood" → fish and shellfish."""
    a = allergy_key(allergy)
    if not a:
        return []
    return list(ALLERGY_GROUPS.get(a, [a]))


def allergy_hits(texts: list[str], allergy: str) -> list[str]:
    """The ingredient texts that contain ``allergy`` (by its keyword table
    or, for one we don't know, the word itself)."""
    found: list[str] = []
    for a in allergy_keys(allergy):
        if a in ALLERGENS:
            words, safe = ALLERGENS[a]
            whole = WHOLE_WORDS.get(a, [])
        else:
            words, safe, whole = [singular(a)], [], []
        free = [a, *a.split(), *words, *whole]
        for t in _hits(texts, words, safe, whole, free):
            if t not in found:
                found.append(t)
    return [t for t in texts if t in found]


def ingredient_texts(ingredients: list[dict]) -> list[str]:
    """What allergen and diet checks read: each ingredient's item and its
    note ("butter, or ghee")."""
    return [(i.get("item") or "") + (f", {i['note']}" if i.get("note") else "") for i in ingredients]


def allergen_report(ingredients: list[dict], allergies: list[str]) -> dict[str, list[str]]:
    """{allergy as written: [ingredient texts that contain it]}."""
    texts = ingredient_texts(ingredients)
    return {a: h for a in allergies if (h := allergy_hits(texts, a))}


MEAT = ["chicken", "beef", "pork", "lamb", "turkey", "duck", "veal", "mince", "steak", "bacon", "ham", "sausage",
        "pancetta", "prosciutto", "salami", "chorizo", "pepperoni", "venison", "goat", "gelatin", "gelatine",
        "lard", "suet", "meatball", "brisket", "kangaroo", "rabbit", "chicken stock", "beef stock", "bone broth"]
PORK = ["pork", "bacon", "ham", "pancetta", "prosciutto", "salami", "chorizo", "pepperoni", "lard", "gelatin",
        "gelatine", "sausage"]
ALCOHOL = ["wine", "beer", "rum", "vodka", "brandy", "whisky", "whiskey", "sake", "mirin", "cider", "liqueur", "bourbon", "sherry", "port wine"]
HIGH_CARB = ["sugar", "flour", "rice", "pasta", "spaghetti", "noodle", "bread", "potato", "honey", "maple syrup",
             "oat", "quinoa", "couscous", "tortilla", "corn", "banana", "beans", "lentil", "chickpea"]
_VEG_SAFE = ["vegetable stock", "veggie", "plant-based", "plant based", "vegan", "meatless", "beyond", "impossible",
             "eggplant", "butternut", "coconut milk", "peanut butter", "sweet potato"]


def diet_conflicts(texts: list[str], diet: str) -> list[str]:
    """The ingredient texts that break ``diet`` (known diets only)."""
    d = " ".join(diet.lower().split())
    fish = ALLERGENS["fish"][0] + ALLERGENS["shellfish"][0]
    fish_whole = WHOLE_WORDS.get("fish", []) + WHOLE_WORDS.get("shellfish", [])

    def hits(words: list[str], whole: list[str] = ()) -> list[str]:
        return _hits(texts, [normalize(w) for w in words], [normalize(w) for w in _VEG_SAFE], list(whole))

    if d in ("vegetarian", "veggie", "lacto-ovo", "ovo-lacto"):
        return hits(MEAT + [w for w in fish if w != "worcestershire"] + ["fish sauce", "anchov"], fish_whole)
    if d in ("pescatarian", "pescetarian"):
        return hits(MEAT)
    if d in ("vegan", "plant-based", "plant based"):
        found = set(hits(MEAT + fish + ["honey"], fish_whole)) | set(allergy_hits(texts, "dairy")) | set(allergy_hits(texts, "egg"))
        return [t for t in texts if t in found]
    if d == "halal":
        return hits(PORK + ALCOHOL)
    if d == "kosher":
        out = hits(PORK + ALLERGENS["shellfish"][0])
        meat = hits([m for m in MEAT if m not in PORK and m not in ("gelatin", "gelatine")])
        dairy = allergy_hits(texts, "dairy")
        if meat and dairy:
            out.append(f"meat with dairy ({meat[0]} + {dairy[0]})")
        return out
    if d in ("keto", "ketogenic", "low carb", "low-carb"):
        return _matches(texts, HIGH_CARB, ["cauliflower rice", "sugar-free", "sugar free", "almond flour", "coconut flour", "green bean", "keto"])
    if d in ("gluten-free", "gluten free", "coeliac", "celiac"):
        return allergy_hits(texts, "gluten")
    if d in ("dairy-free", "dairy free", "lactose-free", "lactose free"):
        return allergy_hits(texts, "dairy")
    if d in ("nut-free", "nut free"):
        return allergy_hits(texts, "tree nut") + allergy_hits(texts, "peanut")
    if d == "no pork":
        return hits(PORK)
    if d in ("alcohol-free", "no alcohol"):
        return hits(ALCOHOL)
    return []
