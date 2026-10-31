"""Reading cards from other apps' text exports.

* **CSV / TSV** — ``front, back[, tags[, deck[, note]]]``; a header row
  (front/back/term/definition/question/answer/tags/deck/note) is detected
  and may reorder columns.
* **Quizlet** — its export text: a term/definition separator (tab, comma
  or custom) and a card separator (new line, semicolon or custom).
* **Anki** — "Notes in Plain Text" (``.txt``): ``#separator:``, ``#html:``,
  ``#tags column:``, ``#deck column:``, ``#notetype column:`` headers;
  HTML is turned into Markdown-ish text; ``{{c1::…}}`` makes cloze cards.
"""
from __future__ import annotations

import csv
import html
import io
import re
from typing import Literal

from .cloze import CLOZE_RE

Format = Literal["auto", "csv", "tsv", "quizlet", "anki"]
HEADER_WORDS = {
    "front": "front", "question": "front", "term": "front", "prompt": "front", "word": "front",
    "back": "back", "answer": "back", "definition": "back", "meaning": "back",
    "tags": "tags", "tag": "tags", "deck": "deck", "note": "note", "extra": "note", "notes": "note",
}
SEPARATORS = {"tab": "\t", "comma": ",", "semicolon": ";", "pipe": "|", "colon": ":", "space": " "}
MAX_ROWS = 10_000


def _html_to_text(s: str) -> str:
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(div|p|li)>", "\n", s)
    s = re.sub(r"(?i)<(b|strong)>(.*?)</\1>", r"**\2**", s, flags=re.S)
    s = re.sub(r"(?i)<(i|em)>(.*?)</\1>", r"*\2*", s, flags=re.S)
    s = re.sub(r"(?i)<img[^>]*>", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    # Anki's MathJax delimiters → $…$
    s = s.replace("\\(", "$").replace("\\)", "$").replace("\\[", "$$").replace("\\]", "$$")
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _tags(raw: str) -> list[str]:
    return [t for t in re.split(r"[\s,]+", raw or "") if t][:30]


def _card(front: str, back: str, tags: list[str] | None = None, deck: str | None = None, note: str = "", typ: str | None = None) -> dict | None:
    front, back = (front or "").strip(), (back or "").strip()
    if not front:
        return None
    is_cloze = bool(CLOZE_RE.search(front))
    t = typ or ("cloze" if is_cloze else "basic")
    if t != "cloze" and not back:
        return None
    return {"type": t, "front": front, "back": back, "tags": tags or [], "deck": deck or None, "note": (note or "").strip()}


def detect(text: str) -> str:
    head = text.lstrip()[:2000]
    if re.search(r"(?m)^#(separator|html|tags column|deck column|notetype column|columns):", head):
        return "anki"
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    if "\t" in first:
        return "tsv"
    return "csv"


def _rows_to_cards(rows: list[list[str]]) -> tuple[list[dict], int]:
    skipped = 0
    cols = {"front": 0, "back": 1, "tags": 2, "deck": 3, "note": 4}
    if rows:
        head = [c.strip().lower() for c in rows[0]]
        if head and all(h in HEADER_WORDS for h in head if h) and any(HEADER_WORDS.get(h) == "front" for h in head):
            cols = {}
            for i, h in enumerate(head):
                if h in HEADER_WORDS and HEADER_WORDS[h] not in cols:
                    cols[HEADER_WORDS[h]] = i
            rows = rows[1:]
    out = []

    def cell(r: list[str], name: str) -> str:
        i = cols.get(name)
        return r[i] if i is not None and i < len(r) else ""

    for r in rows[:MAX_ROWS]:
        c = _card(cell(r, "front"), cell(r, "back"), _tags(cell(r, "tags")), cell(r, "deck").strip() or None, cell(r, "note"))
        if c:
            out.append(c)
        elif any(x.strip() for x in r):
            skipped += 1
    return out, skipped


def parse(text: str, fmt: Format = "auto", term_sep: str | None = None, card_sep: str | None = None) -> tuple[list[dict], int, str]:
    """(cards, rows skipped, format used). Each card: type, front, back, tags, deck, note."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    if fmt == "auto":
        fmt = "quizlet" if (term_sep or card_sep) else detect(text)
    if fmt == "quizlet":
        ts = SEPARATORS.get(term_sep or "tab", term_sep or "\t")
        cs = {"newline": "\n", "blankline": "\n\n", **SEPARATORS}.get(card_sep or "newline", card_sep) or "\n"
        cards, skipped = [], 0
        for chunk in text.split(cs)[:MAX_ROWS]:
            if not chunk.strip():
                continue
            term, sep, definition = chunk.partition(ts)
            c = _card(term, definition) if sep else None
            if c:
                cards.append(c)
            else:
                skipped += 1
        return cards, skipped, "quizlet"
    if fmt == "anki":
        return (*_parse_anki(text), "anki")
    delim = "\t" if fmt == "tsv" else ","
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    cards, skipped = _rows_to_cards(rows)
    return cards, skipped, fmt


def _parse_anki(text: str) -> tuple[list[dict], int]:
    sep, is_html = "\t", True
    tags_col = deck_col = type_col = None
    body: list[str] = []
    for ln in text.split("\n"):
        m = re.match(r"^#([a-z ]+):(.*)$", ln)
        if m and not body:
            key, val = m.group(1).strip(), m.group(2).strip()
            if key == "separator":
                sep = SEPARATORS.get(val.lower(), val[:1] or "\t")
            elif key == "html":
                is_html = val.lower() == "true"
            elif key == "tags column" and val.isdigit():
                tags_col = int(val) - 1
            elif key == "deck column" and val.isdigit():
                deck_col = int(val) - 1
            elif key == "notetype column" and val.isdigit():
                type_col = int(val) - 1
            continue
        body.append(ln)
    rows = list(csv.reader(io.StringIO("\n".join(body)), delimiter=sep))
    skip = {i for i in (tags_col, deck_col, type_col) if i is not None}
    cards, skipped = [], 0
    for r in rows[:MAX_ROWS]:
        fields = [f for i, f in enumerate(r) if i not in skip]
        conv = (lambda s: _html_to_text(s)) if is_html else (lambda s: s.strip())
        front = conv(fields[0]) if fields else ""
        back = conv(fields[1]) if len(fields) > 1 else ""
        note = conv("\n".join(fields[2:])) if len(fields) > 2 else ""
        tags = _tags(r[tags_col]) if tags_col is not None and tags_col < len(r) else []
        deck = r[deck_col].strip() if deck_col is not None and deck_col < len(r) else None
        notetype = (r[type_col] if type_col is not None and type_col < len(r) else "").lower()
        typ = None
        if "reverse" in notetype:
            typ = "reversed"
        elif "type" in notetype and "cloze" not in notetype:
            typ = "typein"
        if CLOZE_RE.search(front):
            typ = "cloze"
            back, note = (back + ("\n" + note if note else "")).strip(), ""
        c = _card(front, back, tags, deck, note, typ)
        if c:
            cards.append(c)
        elif any(x.strip() for x in r):
            skipped += 1
    return cards, skipped
