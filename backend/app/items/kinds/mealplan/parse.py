"""Parsing recipes: ingredient lines, schema.org ``Recipe`` JSON-LD, ISO-8601
durations, and recipes pasted as plain text."""
from __future__ import annotations

import html as htmllib
import json
import re
from typing import Any

from app.items.kinds.mealplan import foods, units

# ------------------------------------------------------------- quantities

_UNICODE_FRACTIONS = {
    "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
    "⅙": 1 / 6, "⅚": 5 / 6, "⅐": 1 / 7, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅑": 1 / 9, "⅒": 0.1,
}
_WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "half": 0.5, "a half": 0.5, "quarter": 0.25,
    "a quarter": 0.25, "dozen": 12, "a dozen": 12, "a couple": 2, "couple": 2, "a few": 3, "few": 3,
    "several": 3,
}

# One number: "1", "1.5", "1,5", "1/2", "1 1/2", "1½", "½".
_NUM = r"(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|\d+\s+\d+\s*/\s*\d+|\d+\s*/\s*\d+|\d+(?:[.,]\d+)?\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]|\d+(?:[.,]\d+)?|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])"
_RANGE_SEP = r"\s*(?:-|–|—|to|or)\s*"
_QTY_RE = re.compile(rf"^({_NUM})(?:{_RANGE_SEP}({_NUM}))?")


def parse_number(s: str) -> float | None:
    s = s.strip()
    # "1,500" is fifteen hundred; "1,5" (a decimal comma) is one and a half.
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", s):
        s = s.replace(",", "")
    s = s.replace(",", ".")
    if not s:
        return None
    total = 0.0
    m = re.fullmatch(r"(\d+)\s+(\d+)\s*/\s*(\d+)", s)
    if m:
        d = int(m.group(3))
        return int(m.group(1)) + (int(m.group(2)) / d if d else 0)
    m = re.fullmatch(r"(\d+)\s*/\s*(\d+)", s)
    if m:
        d = int(m.group(2))
        return int(m.group(1)) / d if d else None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)?\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])", s)
    if m:
        if m.group(1):
            total += float(m.group(1))
        return total + _UNICODE_FRACTIONS[m.group(2)]
    try:
        return float(s)
    except ValueError:
        return None


def _take_qty(s: str) -> tuple[float | None, float | None, str]:
    """Leading quantity (and range) off ``s``."""
    m = _QTY_RE.match(s)
    if m:
        q = parse_number(m.group(1))
        q2 = parse_number(m.group(2)) if m.group(2) else None
        rest = s[m.end():]
        # "1 1/2" can mis-split as "1" + " 1/2" when spaced oddly — handled by _NUM order.
        if q2 is not None and q is not None and q2 <= q:
            q2 = None
        return q, q2, rest
    low = s.lower()
    for word in sorted(_WORD_NUMBERS, key=len, reverse=True):
        if low.startswith(word + " ") or low.startswith(word + "-"):
            rest = s[len(word):]
            q = float(_WORD_NUMBERS[word])
            # "a pinch of" / "half a cup"
            rest = re.sub(r"^\s*(?:a|an)\s+", " ", rest) if word == "half" else rest
            return q, None, rest
    return None, None, s


def _take_unit(s: str) -> tuple[str, str]:
    """Leading unit off ``s`` ("" when the next word isn't one)."""
    t = s.lstrip()
    if not t:
        return "", s
    # One-letter spoons are case-sensitive: "1 T sugar" vs "1 t salt".
    m = re.match(r"^(T|t|Tb|TB)\.?(?=\s)", t)
    if m:
        return units.unit_key(m.group(1)), t[m.end():]
    low = t.lower()
    for alias in units.ALIASES_BY_LENGTH:
        if low.startswith(alias):
            after = t[len(alias):]
            if after.startswith("."):
                after = after[1:]
            if after == "" or not after[0].isalnum():
                return units.unit_key(alias), after
    return "", s


_SIZE_RE = re.compile(rf"^\s*\(?\s*({_NUM})\s*-?\s*([a-zA-Z]+\.?(?:\s?oz)?)\s*\)?")
_CONTAINERS = {"can", "jar", "package", "bag", "box", "bottle", "sachet", "stick", "loaf"}
_UNIT_TAIL = {"clove", "cloves", "stalk", "stalks", "sprig", "sprigs", "fillet", "fillets", "rasher", "rashers", "slice", "slices", "head", "heads", "bunch", "bunches"}


_DESCRIPTORS = {
    "boneless", "skinless", "large", "small", "medium", "fresh", "ripe", "firm", "unsalted", "salted", "raw",
    "lean", "extra-virgin", "organic", "free-range", "skin-on", "bone-in", "thick", "thin", "dry", "dried",
    "sweet", "hot", "mild", "smoked", "plain", "whole", "low-fat", "full-fat", "light", "dark",
}
_JUICE_RE = re.compile(
    r"^(juice|zest|zest and juice|juice and zest|grated zest)\s+of\s+(\d+(?:[.,]\d+)?|½|one|two|three|a|an|half|half a)\s+"
    r"(lemons?|limes?|oranges?|grapefruits?)\b(.*)$",
    re.I,
)


def parse_ingredient(line: str) -> dict[str, Any]:
    """"1 ½ cups (200 g) plain flour, sifted" → ``{qty: 1.5, unit: "cup",
    item: "plain flour", note: "200 g, sifted", …}``. Never raises."""
    raw = htmllib.unescape(re.sub(r"<[^>]+>", " ", line or ""))
    s = " ".join(raw.replace(" ", " ").split())
    s = re.sub(r"^[\-–—•*·▢□☐✓✔\s]+", "", s)
    s = re.sub(r"(\d)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])", r"\1 \2", s)  # "1½" → "1 ½"
    s = s.replace("⁄", "/")  # fraction slash
    out: dict[str, Any] = {"qty": None, "qty_max": None, "unit": "", "item": "", "note": "", "optional": False, "group": ""}
    notes: list[str] = []
    if not s:
        return out

    m = _JUICE_RE.match(s)
    if m:
        n = m.group(2).lower()
        q = 0.5 if n.startswith("half") or n == "½" else float(_WORD_NUMBERS.get(n, 0) or parse_number(n) or 1)
        fruit = m.group(3).lower()
        fruit = fruit[:-1] if fruit.endswith("s") else fruit
        extra = m.group(4).strip(" ,")
        out.update(qty=q, item=fruit, note=", ".join(x for x in (m.group(1).lower(), extra) if x)[:300])
        return out

    qty, qty_max, rest = _take_qty(s)
    # "2 x 400g tins" / "2 × 400 g cans"
    rest = re.sub(r"^\s*[x×]\s+", " ", rest) if qty is not None else rest
    unit, after = _take_unit(rest)
    if unit in units.UNITS and qty is not None:
        # "400g/14oz chickpeas": the same amount in the other system → note.
        m = re.match(rf"^\s*/\s*({_NUM})\s*", after)
        if m:
            u2, tail2 = _take_unit(after[m.end():])
            if u2 in units.UNITS:
                notes.append(f"{units.fmt_number(parse_number(m.group(1)) or 0)} {units.unit_label(u2, 2)}")
                after = tail2
        # "1 lb 4 oz", "1 cup 2 tbsp": one amount written in two units.
        m = re.match(rf"^\s+({_NUM})\s*", after)
        if m:
            u2, tail2 = _take_unit(after[m.end():])
            q2 = parse_number(m.group(1))
            if u2 in units.UNITS and units.dimension(u2) == units.dimension(unit) and u2 != unit and q2:
                qty = qty + units.to_base(q2, u2) / units.UNITS[unit][1]
                after = tail2
        # "400g can chickpeas", "500 ml bottle passata": a pack size.
        m = re.match(r"^\s*(cans?|tins?|jars?|packs?|packets?|packages?|bags?|box(?:es)?|bottles?)(?![a-z])\.?\s*(?:of\s+)?", after, re.I)
        if m and after[m.end():].strip():
            notes.append(f"{units.fmt_number(qty)} {units.unit_label(unit, 2)} {units.unit_label(units.unit_key(m.group(1)), 1)}")
            qty, qty_max, unit = 1.0, None, units.unit_key(m.group(1))
            after = " " + after[m.end():]
    # A pack size before or after the unit: "1 (14 oz) can", "2 x 400g tins", "1 can (400 g)".
    size_note = ""
    m = _SIZE_RE.match(after if unit else rest)
    if m and units.unit_key(m.group(2)) in units.UNITS:
        size_note = f"{units.fmt_number(parse_number(m.group(1)) or 0)} {units.unit_label(units.unit_key(m.group(2)), 2)}"
        tail = (after if unit else rest)[m.end():]
        if not unit:
            unit2, tail2 = _take_unit(tail)
            if unit2:
                unit, after = unit2, tail2
                notes.append(f"{size_note} {units.unit_label(unit, 1)}".strip())
            elif qty is not None and "(" in m.group(0):
                notes.append(size_note)
                after = tail
            else:
                # "400g chickpeas": the size *is* the amount.
                if qty is None:
                    qty = parse_number(m.group(1))
                    unit = units.unit_key(m.group(2))
                    after = tail
                else:
                    after = rest
        else:
            notes.append(size_note)
            after = tail
    elif not unit:
        after = rest
    if qty is None and unit:
        qty = 1.0  # "pinch of salt"
    item = after.strip()
    item = re.sub(r"^(?:of|x)\s+", "", item, flags=re.I)

    # Parentheticals → notes.
    for p in re.findall(r"\(([^)]*)\)", item):
        if p.strip():
            notes.append(p.strip())
    item = re.sub(r"\s*\([^)]*\)", "", item).strip()
    # "item, prep note" — but "boneless, skinless chicken" is all item.
    if "," in item:
        parts = [x.strip() for x in item.split(",")]
        head = parts.pop(0)
        while parts and head and all(w.lower() in _DESCRIPTORS for w in head.split()):
            head = f"{head} {parts.pop(0)}".strip()
        item = head
        if parts and ", ".join(parts).strip():
            notes.append(", ".join(p for p in parts if p))
    # " - note" / " – note"
    m = re.search(r"\s+[–—-]\s+", item)
    if m:
        notes.append(item[m.end():].strip())
        item = item[: m.start()].strip()
    # "to taste", "for garnish" at the end of the item
    m = re.search(r"\s+(to taste|for (?:garnish|serving|frying|greasing|the pan|dusting)|as needed|if needed)$", item, re.I)
    if m:
        notes.insert(0, m.group(1))
        item = item[: m.start()].strip()
    # "3 garlic cloves" → 3 clove garlic
    if not unit and qty is not None:
        words = item.split()
        if len(words) >= 2 and words[-1].lower() in _UNIT_TAIL:
            unit = units.unit_key(words[-1])
            item = " ".join(words[:-1])

    note = ", ".join(n for n in notes if n)
    if re.search(r"\boptional\b", note + " " + item, re.I):
        out["optional"] = True
        note = re.sub(r"\s*,?\s*\(?optional\)?\s*,?", " ", note, flags=re.I).strip(" ,")
        item = re.sub(r"\s*\(?\boptional\b\)?", "", item, flags=re.I).strip(" ,")
    if not item and note:
        item, note = note, ""
    # "8 oz milk" means fluid ounces (US recipes write it that way).
    if unit == "oz" and foods.oz_means_fluid(foods.ingredient_key(item)):
        unit = "floz"
    out.update(qty=_tidy(qty), qty_max=_tidy(qty_max), unit=unit, item=item[:200], note=note[:300])
    return out


def _tidy(q: float | None) -> float | None:
    if q is None:
        return None
    return round(q, 4)


def _is_heading(line: str) -> str | None:
    """"For the sauce:" / "SAUCE" / "## Topping" → the group name."""
    s = line.strip().strip("#*_ ").strip()
    if not s or len(s) > 60:
        return None
    if s.endswith(":") and not re.match(r"^\d", s):
        return s[:-1].strip()[:80] or None
    if re.match(r"^for (the )?[a-z ]+$", s, re.I) and len(s.split()) <= 5:
        return s[:80]
    return None


def parse_ingredient_lines(lines: list[str]) -> list[dict[str, Any]]:
    """Lines → structured ingredients, with "For the sauce:" headings as
    groups. Blank lines are skipped."""
    out: list[dict[str, Any]] = []
    group = ""
    for line in lines:
        if not line or not line.strip():
            continue
        h = _is_heading(line)
        if h is not None:
            group = h
            continue
        ing = parse_ingredient(line)
        if not ing["item"]:
            continue
        ing["group"] = group
        ing["aisle"] = foods.aisle_for(ing["item"])
        out.append(ing)
    return out


# --------------------------------------------------------------- durations

_ISO_DUR = re.compile(
    r"^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?"
    r"(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$",
    re.I,
)


def parse_duration(value: Any) -> int | None:
    """Minutes from "PT1H30M", "P0DT0H20M", "PT90M", "1 hour 15 mins", 45."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    s = str(value).strip()
    m = _ISO_DUR.match(s)
    if m and any(m.groups()):
        y, mo, w, d, h, mi, sec = (float(g) if g else 0.0 for g in m.groups())
        mins = (((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60) + mi + sec / 60
        mins = int(round(mins))
        return mins if 0 < mins <= 60 * 24 * 14 else None
    total = 0.0
    found = False
    for num, unit in re.findall(r"(\d+(?:[.,]\d+)?|[½¼¾])\s*(days?|d\b|hours?|hrs?|h\b|minutes?|mins?|m\b)", s, re.I):
        n = parse_number(num) or 0
        u = unit.lower()
        found = True
        if u.startswith("d"):
            total += n * 1440
        elif u.startswith("h"):
            total += n * 60
        else:
            total += n
    if found and total > 0:
        return int(round(total))
    if re.fullmatch(r"\d+", s):
        return int(s) or None
    return None


# ----------------------------------------------------------------- JSON-LD

_LD_RE = re.compile(r"<script[^>]*type\s*=\s*[\"']?application/ld\+json[\"']?[^>]*>(.*?)</script>", re.I | re.S)


def _clean(s: Any, limit: int = 3000) -> str:
    if s is None:
        return ""
    if isinstance(s, list):
        s = " ".join(str(x) for x in s if x)
    if isinstance(s, dict):
        s = s.get("text") or s.get("name") or ""
    t = str(s)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = htmllib.unescape(htmllib.unescape(t))
    t = t.replace(" ", " ")
    t = "\n".join(" ".join(line.split()) for line in t.splitlines())
    return t.strip()[:limit]


def _types(node: dict) -> list[str]:
    t = node.get("@type") or node.get("type") or []
    if isinstance(t, str):
        t = [t]
    return [str(x).rsplit("/", 1)[-1].rsplit(":", 1)[-1].lower() for x in t if x]


def find_recipes(obj: Any, depth: int = 0) -> list[dict]:
    """Every schema.org Recipe node in parsed JSON-LD (through @graph,
    mainEntity, lists, nested objects)."""
    if depth > 8:
        return []
    out: list[dict] = []
    if isinstance(obj, list):
        for x in obj:
            out.extend(find_recipes(x, depth + 1))
    elif isinstance(obj, dict):
        if "recipe" in _types(obj):
            return [obj]
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and k not in ("author", "publisher", "review", "aggregateRating", "video"):
                out.extend(find_recipes(v, depth + 1))
    return out


def _loads_lenient(raw: str) -> Any:
    s = raw.strip()
    s = re.sub(r"^\s*(?://\s*)?<!\[CDATA\[", "", s)
    s = re.sub(r"(?://\s*)?\]\]>\s*$", "", s).strip().rstrip(";")
    try:
        return json.loads(s, strict=False)
    except json.JSONDecodeError:
        pass
    # Trailing commas, a common hand-written JSON-LD mistake.
    try:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", s), strict=False)
    except json.JSONDecodeError:
        return None


def jsonld_blocks(page: str) -> list[Any]:
    out = []
    for raw in _LD_RE.findall(page or ""):
        data = _loads_lenient(raw)
        if data is not None:
            out.append(data)
    return out


def _steps(instr: Any, depth: int = 0) -> list[str]:
    if depth > 5 or instr is None:
        return []
    if isinstance(instr, str):
        text = _clean(instr, 20000)
        parts = [p for p in re.split(r"\n+", text) if p.strip()]
        if len(parts) <= 1:
            # "1. Do this. 2. Do that." on one line
            numbered = re.split(r"(?:^|\s)(?:step\s*)?\d{1,2}[.)]\s+", text, flags=re.I)
            numbered = [p.strip() for p in numbered if p.strip()]
            if len(numbered) > 1:
                parts = numbered
        return [_strip_step_number(p) for p in parts if _strip_step_number(p)]
    if isinstance(instr, list):
        out: list[str] = []
        for x in instr:
            out.extend(_steps(x, depth + 1))
        return out
    if isinstance(instr, dict):
        types = _types(instr)
        if "howtosection" in types or "itemlistelement" in instr:
            name = _clean(instr.get("name"), 120)
            inner = _steps(instr.get("itemListElement") or instr.get("steps") or [], depth + 1)
            if name and inner:
                inner[0] = f"{name}: {inner[0]}"
            return inner
        text = instr.get("text") or instr.get("description") or instr.get("name")
        return _steps(text, depth + 1) if text else []
    return []


def _strip_step_number(s: str) -> str:
    return re.sub(r"^\s*(?:step\s*\d+\s*[:.)-]?|\d{1,2}\s*[.)]|\d{1,2}\s*:)\s*", "", s.strip(), flags=re.I).strip()


def _yield(v: Any) -> tuple[float, str]:
    """(servings, yield text) from recipeYield."""
    if isinstance(v, list):
        for x in v:
            n, t = _yield(x)
            if n:
                return n, t
        return 0, ""
    if isinstance(v, (int, float)):
        return float(v), ""
    s = _clean(v, 100)
    m = re.search(r"(\d+(?:[.,]\d+)?)", s)
    if m:
        return float(m.group(1).replace(",", ".")), s
    return 0, s


def _image(v: Any) -> str:
    if isinstance(v, list):
        for x in v:
            u = _image(x)
            if u:
                return u
        return ""
    if isinstance(v, dict):
        return _image(v.get("url") or v.get("contentUrl") or "")
    s = str(v or "").strip()
    return s if s.startswith(("http://", "https://")) and len(s) <= 2000 else ""


def _num(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(v))
    return float(m.group(1).replace(",", ".")) if m else None


def _nutrition(n: Any) -> dict | None:
    if not isinstance(n, dict):
        return None
    out: dict[str, float] = {}
    cal = _num(n.get("calories"))
    if cal is not None:
        if "kj" in str(n.get("calories")).lower() and "kcal" not in str(n.get("calories")).lower():
            cal = cal / 4.184
        out["calories"] = round(cal)
    for src, dst in (("proteinContent", "protein_g"), ("carbohydrateContent", "carbs_g"), ("fatContent", "fat_g"),
                     ("fiberContent", "fiber_g"), ("sugarContent", "sugar_g"), ("saturatedFatContent", "saturated_fat_g")):
        v = _num(n.get(src))
        if v is not None:
            if "mg" in str(n.get(src)).lower():
                v = v / 1000
            out[dst] = round(v, 1)
    sod = _num(n.get("sodiumContent"))
    if sod is not None:
        raw = str(n.get("sodiumContent")).lower()
        out["sodium_mg"] = round(sod * 1000 if re.search(r"\d\s*g\b", raw) and "mg" not in raw else sod)
    return out or None


def _tags(*vals: Any) -> list[str]:
    out: list[str] = []
    for v in vals:
        items = v if isinstance(v, list) else re.split(r"[,;|]", str(v or ""))
        for x in items:
            t = _clean(x, 40).lower().strip(" #")
            if t and t not in out and len(t) <= 40:
                out.append(t)
    return out[:15]


def recipe_from_jsonld(node: dict, url: str = "") -> dict:
    """A schema.org Recipe → a recipe draft in this item's shape."""
    servings, yield_text = _yield(node.get("recipeYield") or node.get("yield"))
    lines = node.get("recipeIngredient") or node.get("ingredients") or []
    if isinstance(lines, str):
        lines = [x for x in re.split(r"\n+", lines) if x.strip()]
    lines = [_clean(x, 400) for x in lines if x]
    cuisine = node.get("recipeCuisine")
    if isinstance(cuisine, list):
        cuisine = cuisine[0] if cuisine else ""
    prep = parse_duration(node.get("prepTime"))
    cook = parse_duration(node.get("cookTime"))
    total = parse_duration(node.get("totalTime"))
    if total is None and (prep or cook):
        total = (prep or 0) + (cook or 0)
    notes = _clean(node.get("description"), 2000)
    if yield_text and not re.fullmatch(r"\d+(?:\s*servings?)?", yield_text, re.I):
        made = yield_text if re.match(r"^(makes|yields?|serves)\b", yield_text, re.I) else f"Makes {yield_text}"
        notes = (f"{made.rstrip('.')}. " + notes).strip()
    source = node.get("url") if isinstance(node.get("url"), str) and node.get("url", "").startswith("http") else url
    return {
        "title": _clean(node.get("name") or node.get("headline"), 200) or "Imported recipe",
        "servings": servings if 0 < servings <= 100 else 4,
        "ingredients": parse_ingredient_lines(lines)[:120],
        "steps": [s[:3000] for s in _steps(node.get("recipeInstructions"))][:80],
        "prep_min": prep,
        "cook_min": cook,
        "total_min": total,
        "tags": _tags(node.get("recipeCategory"), node.get("keywords")),
        "cuisine": _clean(cuisine, 60),
        "source_url": (source or "")[:1000],
        "image_url": _image(node.get("image") or node.get("thumbnailUrl")),
        "notes": notes[:5000],
        "nutrition": _nutrition(node.get("nutrition")),
    }


def recipe_from_html(page: str, url: str = "") -> dict | None:
    """The first schema.org Recipe on a page, as a draft (None if none)."""
    for block in jsonld_blocks(page):
        recipes = find_recipes(block)
        for r in recipes:
            draft = recipe_from_jsonld(r, url)
            if draft["ingredients"] or draft["steps"]:
                return draft
    return None


def page_title(page: str) -> str:
    m = re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)", page or "", re.I)
    if not m:
        m = re.search(r"<title[^>]*>(.*?)</title>", page or "", re.I | re.S)
    return _clean(m.group(1), 200) if m else ""


# ---------------------------------------------------------------- pasted text

_SECTION_ING = re.compile(r"^\s*(?:#+\s*)?(ingredients?|you(?:'ll)? need|what you need)\s*:?\s*$", re.I)
_SECTION_STEPS = re.compile(r"^\s*(?:#+\s*)?(method|directions?|instructions?|steps|preparation|how to make( it)?)\s*:?\s*$", re.I)
_SECTION_NOTES = re.compile(r"^\s*(?:#+\s*)?(notes?|tips?|cook'?s notes?)\s*:?\s*$", re.I)


def recipe_from_text(text: str) -> dict:
    """A recipe someone pasted (a note, an email, a page copy)."""
    lines = [line.rstrip() for line in (text or "").replace("\r", "").split("\n")]
    title = ""
    servings: float = 0
    prep = cook = total = None
    ing_lines: list[str] = []
    steps: list[str] = []
    notes: list[str] = []
    section = ""
    urls = re.findall(r"https?://\S+", text or "")
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if _SECTION_ING.match(s):
            section = "ing"
            continue
        if _SECTION_STEPS.match(s):
            section = "steps"
            continue
        if _SECTION_NOTES.match(s):
            section = "notes"
            continue
        m = re.match(r"^(?:serves|servings|yield|makes)\s*:?\s*(\d+(?:[.,]\d+)?)", s, re.I)
        if m:
            servings = float(m.group(1).replace(",", "."))
            continue
        m = re.match(r"^(prep(?:aration)?|cook(?:ing)?|total)\s*(?:time)?\s*:?\s*(.+)$", s, re.I)
        if m and parse_duration(m.group(2)) and len(s) < 60:
            v = parse_duration(m.group(2))
            k = m.group(1).lower()
            if k.startswith("prep"):
                prep = v
            elif k.startswith("cook"):
                cook = v
            else:
                total = v
            continue
        if not title and not section:
            title = s.strip("# ").strip()[:200]
            continue
        if section == "ing":
            ing_lines.append(s)
        elif section == "steps":
            steps.append(s)
        elif section == "notes":
            notes.append(s)
        else:
            # No headings: short lines that start with an amount are
            # ingredients, sentences are steps.
            p = parse_ingredient(s)
            if (p["qty"] is not None or p["unit"]) and len(s) < 90:
                ing_lines.append(s)
            elif len(s) > 25:
                steps.append(s)
            else:
                ing_lines.append(s)
    # Steps written as wrapped paragraphs keep their numbering.
    merged: list[str] = []
    for st in steps:
        clean = _strip_step_number(st)
        if merged and not re.match(r"^\s*(?:step\s*)?\d{1,2}[.):]", st, re.I) and not merged[-1].endswith((".", "!", ")")):
            merged[-1] = f"{merged[-1]} {clean}"
        elif clean:
            merged.append(clean)
    if total is None and (prep or cook):
        total = (prep or 0) + (cook or 0)
    return {
        "title": title or "Pasted recipe",
        "servings": servings if 0 < servings <= 100 else 4,
        "ingredients": parse_ingredient_lines(ing_lines)[:120],
        "steps": [s[:3000] for s in merged][:80],
        "prep_min": prep,
        "cook_min": cook,
        "total_min": total,
        "tags": [],
        "cuisine": "",
        "source_url": urls[0][:1000] if urls else "",
        "image_url": "",
        "notes": "\n".join(notes)[:5000],
        "nutrition": None,
    }
