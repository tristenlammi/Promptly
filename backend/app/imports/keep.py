"""Google Keep in a Takeout, and notes in a Promptly export (Notes N1.6).

Google doesn't document Keep's Takeout format. What it is in practice
(read from real exports by the open-source importers — Obsidian's Importer
``formats/keep``, Joplin's Keep plugin, and the scripts people share):

* ``Takeout/Keep/`` holds, for each note, ``<name>.json`` and
  ``<name>.html`` (the same note as a page), its pictures and recordings
  beside them under their own names, and a ``Labels.txt`` listing every
  label.
* A note's JSON: ``title``, ``textContent`` (``textContentHtml`` too in
  newer exports) or ``listContent`` ``[{text, textHtml?, isChecked}]``,
  ``color`` (``DEFAULT``, ``RED``, ``ORANGE``, ``YELLOW``, ``GREEN``,
  ``TEAL``, ``BLUE``, ``CERULEAN`` — dark blue —, ``PURPLE``, ``PINK``,
  ``BROWN``, ``GRAY``), ``isPinned``, ``isArchived``, ``isTrashed``,
  ``labels [{name}]``, ``attachments [{filePath, mimetype}]``,
  ``annotations [{source: "WEBLINK", url, title, description}]``,
  ``sharees [{email, isOwner, type}]``, ``createdTimestampUsec`` and
  ``userEditedTimestampUsec`` (microseconds).
* An attachment's ``filePath`` is a name in the same folder; sometimes the
  file's extension differs from it (``.jpeg`` named, ``.jpg`` written), so a
  file with the same stem is taken.
* Older exports had only the ``.html``: it's read for what it shows
  (title, text or ticked items, colour class, labels, pictures,
  archived/pinned marks) when there's no ``.json`` for that note.

Everything is read tolerantly: a missing field is a default, an unknown
one is ignored, a JSON that isn't a note is skipped. Keep's trash is left
out (reported). Each note keeps an ``import_ref`` (``keep:<created µs>``),
so importing the same Takeout again skips what's already in.

A **Promptly export** writes ``Promptly/Notes/notes.json`` in the same
shape plus a ``promptly`` block (exact colour, list indents, the formatted
body, transcripts, where each attachment is in the export) — read here
too, so an export comes back whole.
"""
from __future__ import annotations

import html as _html
import json
import re
from html.parser import HTMLParser
from typing import Any, Callable

MAX_ITEMS = 1000
MAX_TEXT = 20_000
MAX_TITLE = 300
MAX_ITEM_TEXT = 1000
JSON_MAX = 4 * 1024 * 1024  # one Keep note's JSON (notes are ≤20 000 characters)
NOTES_JSON_MAX = 256 * 1024 * 1024  # a Promptly export's notes.json

KEEP_PRODUCT = re.compile(r"^(google[ _-]?)?keep$", re.IGNORECASE)

# Keep's colour names → Promptly's palette (Keep's own, in the same order).
COLORS = {
    "default": "default", "white": "default", "none": "default",
    "red": "coral", "orange": "peach", "yellow": "sand", "green": "mint", "teal": "sage",
    "blue": "fog", "cerulean": "storm", "dark_blue": "storm", "darkblue": "storm",
    "purple": "dusk", "pink": "blossom", "brown": "clay", "gray": "chalk", "grey": "chalk",
}
# And back (what an export writes as Keep's ``color``).
KEEP_COLOR = {
    "default": "DEFAULT", "coral": "RED", "peach": "ORANGE", "sand": "YELLOW", "mint": "GREEN", "sage": "TEAL",
    "fog": "BLUE", "storm": "CERULEAN", "dusk": "PURPLE", "blossom": "PINK", "clay": "BROWN", "chalk": "GRAY",
}
_PALETTE = set(KEEP_COLOR)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".avif"}
AUDIO_EXTS = {".3gp", ".3gpp", ".amr", ".m4a", ".mp3", ".aac", ".ogg", ".opus", ".wav", ".webm", ".flac", ".mp4"}


def color_of(raw: Any) -> str:
    v = str(raw or "").strip().lower()
    if v in _PALETTE:
        return v
    return COLORS.get(v, "default")


def _usec(raw: Any) -> float | None:
    """Keep's microseconds → epoch seconds (None for nothing sensible)."""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    secs = v / 1_000_000 if v > 1e14 else v / 1000 if v > 1e11 else v  # µs, else ms, else s
    return secs if 0 < secs < 4_102_444_800 else None  # before 2100


def _ext(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return ("." + base.rsplit(".", 1)[-1].lower()) if "." in base else ""


def kind_for(name: str, mime: str | None) -> str | None:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("audio/"):
        return "audio"
    ext = _ext(name)
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    return None


def is_keep_note(d: Any) -> bool:
    """A Keep note's JSON (not some other JSON that happens to be there)."""
    if not isinstance(d, dict):
        return False
    has_body = any(k in d for k in ("textContent", "listContent", "textContentHtml"))
    has_keep = any(k in d for k in ("createdTimestampUsec", "userEditedTimestampUsec", "isPinned", "isArchived", "isTrashed", "color"))
    return has_body and has_keep


# ------------------------------------------------------------------ notes


def _s(v: Any, limit: int) -> str:
    return str(v)[:limit] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def _links_paragraph(title: str, url: str) -> dict[str, Any]:
    text = title.strip() or url
    return {"type": "paragraph", "content": [{"type": "text", "text": text[:500], "marks": [{"type": "link", "attrs": {"href": url}}]}]}


def _plain_paragraph(text: str) -> dict[str, Any]:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]} if text else {"type": "paragraph"}


def note_from_keep(d: dict[str, Any], *, ref: str, resolve: Callable[[str, str | None], dict[str, Any] | None]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(the note to make, what's worth telling about it) from one Keep JSON.

    ``resolve(filePath, mimetype)`` finds an attachment's file (a plan
    entry) or returns None when it isn't in the archive."""
    extra = d.get("promptly") if isinstance(d.get("promptly"), dict) else {}
    tell: dict[str, Any] = {"missing": 0, "cut": False, "shared": False}
    title = _s(d.get("title"), MAX_TITLE).strip()
    items_raw = d.get("listContent") if isinstance(d.get("listContent"), list) else None
    has_text = isinstance(d.get("textContent"), str) and bool(d["textContent"].strip())
    kind = "list" if items_raw is not None and not has_text else "text"
    if extra.get("kind") in ("text", "list"):
        kind = extra["kind"]

    items: list[dict[str, Any]] = []
    if kind == "list":
        src = extra.get("items") if isinstance(extra.get("items"), list) else (items_raw or [])
        for it in src:
            if not isinstance(it, dict):
                continue
            text = _s(it.get("text"), 100_000)
            if not text.strip() and isinstance(it.get("textHtml"), str):
                text = _strip_html(it["textHtml"])
            text = " ".join(text.replace("\r", "\n").split("\n")).strip()
            if not text:
                continue
            if len(text) > MAX_ITEM_TEXT:
                text, tell["cut"] = text[:MAX_ITEM_TEXT], True
            items.append({
                "text": text,
                "checked": it.get("isChecked") is True or it.get("checked") is True,
                "indent": bool(it.get("isIndented") or it.get("indent")),
            })
        if len(items) > MAX_ITEMS:
            items, tell["cut"] = items[:MAX_ITEMS], True

    body_doc: dict[str, Any] | None = None
    text = ""
    if kind == "text":
        if isinstance(extra.get("body_doc"), dict):
            body_doc = extra["body_doc"]
        text = _s(d.get("textContent"), 1_000_000).replace("\r\n", "\n").replace("\r", "\n")
        if not text and isinstance(d.get("textContentHtml"), str):
            text = _strip_html(d["textContentHtml"])
        if items_raw and not extra:
            # Text and a list in one note (odd, but possible): the items as lines after it.
            lines = [("[x] " if i.get("isChecked") is True else "[ ] ") + _s(i.get("text"), MAX_ITEM_TEXT) for i in items_raw if isinstance(i, dict)]
            text = (text.rstrip("\n") + "\n\n" if text.strip() else "") + "\n".join(lines)
        if len(text) > MAX_TEXT - 500:
            text, tell["cut"] = text[: MAX_TEXT - 500], True

    # Links Keep found in the note, and who it was shared with (not added
    # as people here: they're Keep's, not this server's).
    extra_blocks: list[dict[str, Any]] = []
    if not extra:
        for a in d.get("annotations") if isinstance(d.get("annotations"), list) else []:
            if not isinstance(a, dict):
                continue
            url = _s(a.get("url"), 2000).strip()
            if not url.lower().startswith(("http://", "https://")) or url in text:
                continue
            label = _s(a.get("title"), 300).strip()
            if kind == "text":
                extra_blocks.append(_links_paragraph(label, url))
            elif len(items) < MAX_ITEMS:
                items.append({"text": (f"{label} {url}" if label else url)[:MAX_ITEM_TEXT], "checked": False, "indent": False})
        sharees = [
            _s(s.get("email"), 200).strip()
            for s in (d.get("sharees") if isinstance(d.get("sharees"), list) else [])
            if isinstance(s, dict) and not s.get("isOwner") and _s(s.get("email"), 200).strip()
        ]
        if sharees:
            tell["shared"] = True
            if kind == "text":
                extra_blocks.append(_plain_paragraph("Shared in Keep with " + ", ".join(sharees) + "."))

    if kind == "text" and body_doc is None and (text.strip() or extra_blocks):
        lines = text.split("\n")
        while lines and not lines[-1].strip():
            lines.pop()
        body_doc = {"type": "doc", "content": [_plain_paragraph(ln) for ln in lines]}
        if extra_blocks:
            if body_doc["content"]:
                body_doc["content"].append(_plain_paragraph(""))
            body_doc["content"].extend(extra_blocks)

    labels: list[str] = []
    raw_labels = extra.get("labels") if isinstance(extra.get("labels"), list) else d.get("labels")
    for lb in raw_labels if isinstance(raw_labels, list) else []:
        name = lb.get("name") if isinstance(lb, dict) else lb
        name = _s(name, 200).strip().lstrip("#")
        if name and name.casefold() not in {x.casefold() for x in labels}:
            labels.append(name)

    attachments: list[dict[str, Any]] = []
    raw_atts = extra.get("attachments") if isinstance(extra.get("attachments"), list) else d.get("attachments")
    for a in raw_atts if isinstance(raw_atts, list) else []:
        if not isinstance(a, dict):
            continue
        path = _s(a.get("path") or a.get("filePath"), 1000).strip()
        mime = _s(a.get("mimetype") or a.get("mime"), 100).strip() or None
        if not path:
            continue
        found = resolve(path, mime)
        if found is None:
            tell["missing"] += 1
            continue
        k = kind_for(found.get("name") or path, mime)
        if k is None:
            tell["missing"] += 1
            continue
        att = {**found, "kind": k}
        if isinstance(a.get("transcript"), str) and a["transcript"].strip():
            att["transcript"] = a["transcript"][:400_000]
        attachments.append(att)

    created = _usec(d.get("createdTimestampUsec"))
    edited = _usec(d.get("userEditedTimestampUsec")) or created
    note = {
        "ref": str(extra.get("ref") or ref)[:200],
        "id": _s(extra.get("id"), 64) or None,
        "kind": kind,
        "title": title,
        "body_doc": body_doc,
        "items": items,
        "color": color_of(extra.get("color") or d.get("color")),
        "pinned": d.get("isPinned") is True,
        "archived": d.get("isArchived") is True,
        "trashed": d.get("isTrashed") is True,
        "labels": labels[:50],
        "created": created,
        "edited": edited,
        "attachments": attachments,
    }
    return note, tell


def _strip_html(raw: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", raw)
    text = re.sub(r"<[^>]+>", "", text)
    return _html.unescape(text).strip("\n")


# ------------------------------------------------------------------ HTML


class _KeepHtml(HTMLParser):
    """What an old Keep export's page says about its note (best effort)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[set[str]] = []
        self.color = "DEFAULT"
        self.title: list[str] = []
        self.content: list[str] = []
        self.items: list[dict[str, Any]] = []
        self.labels: list[str] = []
        self.files: list[str] = []
        self.archived = False
        self.pinned = False
        self.trashed = False
        self._item: dict[str, Any] | None = None
        self._label: list[str] | None = None

    def _in(self, cls: str) -> bool:
        return any(cls in s for s in self.stack)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        classes = set((a.get("class") or "").split())
        if tag in ("br", "img", "audio", "source", "input", "meta", "link", "hr"):
            if tag == "br" and self._in("content") and self._item is None:
                self.content.append("\n")
            if tag in ("img", "audio", "source") and a.get("src") and not str(a["src"]).startswith(("data:", "http:", "https:")):
                self.files.append(str(a["src"]))
            if tag == "audio" and a.get("src") is None:
                pass
            return
        self.stack.append(classes)
        if "note" in classes:
            for c in classes - {"note"}:
                if c.upper() in {k.upper() for k in COLORS}:
                    self.color = c
        if "archived" in classes:
            self.archived = True
        if "pinned" in classes:
            self.pinned = True
        if "trashed" in classes:
            self.trashed = True
        if "listitem" in classes:
            self._item = {"text": [], "checked": "checked" in classes}
        if "label-name" in classes:
            self._label = []
        if tag in ("p", "div", "li") and self._in("content") and self._item is None and self.content and "content" not in classes:
            self.content.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("br", "img", "audio", "source", "input", "meta", "link", "hr"):
            return
        if not self.stack:
            return
        classes = self.stack.pop()
        if "listitem" in classes and self._item is not None:
            text = " ".join("".join(self._item["text"]).split())
            if text:
                self.items.append({"text": text, "isChecked": self._item["checked"]})
            self._item = None
        if "label-name" in classes and self._label is not None:
            name = "".join(self._label).strip()
            if name:
                self.labels.append(name)
            self._label = None

    def handle_data(self, data: str) -> None:
        if self._label is not None:
            self._label.append(data)
        elif self._item is not None:
            if not self._in("bullet"):
                self._item["text"].append(data)
        elif self._in("title") and not self._in("content"):
            self.title.append(data)
        elif self._in("content"):
            self.content.append(data)


def keep_json_from_html(raw: bytes) -> dict[str, Any] | None:
    """An old export's note page as Keep JSON (None if it isn't one)."""
    try:
        text = raw.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None
    if 'class="note' not in text and "class='note" not in text:
        return None
    p = _KeepHtml()
    try:
        p.feed(text)
        p.close()
    except Exception:  # noqa: BLE001 — a page we can't read is skipped
        return None
    out: dict[str, Any] = {
        "title": " ".join("".join(p.title).split()),
        "color": p.color.upper(),
        "isArchived": p.archived,
        "isPinned": p.pinned,
        "isTrashed": p.trashed,
        "labels": [{"name": n} for n in p.labels],
        "attachments": [{"filePath": f, "mimetype": ""} for f in p.files],
    }
    if p.items:
        out["listContent"] = p.items
    else:
        body = re.sub(r"\n{3,}", "\n\n", "".join(p.content)).strip("\n")
        out["textContent"] = body
    if not out["title"] and not p.items and not out.get("textContent") and not p.files:
        return None
    return out


# ------------------------------------------------------------------ a Takeout


def _stem(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0] if "." in base else base


def plan_keep(
    members: list[Any], jsons: dict[str, Any], htmls: dict[str, bytes]
) -> tuple[list[dict[str, Any]], dict[str, Any], set[str]]:
    """Notes from a Takeout's Keep folder(s).

    ``members``: every archive member under a Keep product (``Member``);
    ``jsons``/``htmls``: their parsed ``.json`` / raw ``.html`` by path.
    Returns (notes, report, the member paths used as attachments)."""
    by_folder: dict[str, list[Any]] = {}
    for m in members:
        folder = m.path.rpartition("/")[0]
        by_folder.setdefault(folder, []).append(m)

    notes: list[dict[str, Any]] = []
    used: set[str] = set()
    report = {
        "notes": 0, "lists": 0, "pinned": 0, "archived": 0, "trashed": 0, "with_pictures": 0, "with_recordings": 0,
        "labels": [], "missing_attachments": 0, "shared": 0, "cut": 0, "unreadable": 0,
    }
    labels: dict[str, str] = {}
    refs: set[str] = set()
    for folder, fmembers in sorted(by_folder.items()):
        exact = {m.path.rsplit("/", 1)[-1]: m for m in fmembers}
        lower = {k.lower(): m for k, m in exact.items()}
        by_stem: dict[str, list[Any]] = {}
        for k, m in exact.items():
            if not k.lower().endswith((".json", ".html", ".txt")):
                by_stem.setdefault(_stem(k).lower(), []).append(m)

        def resolve(path: str, mime: str | None, _exact=exact, _lower=lower, _by_stem=by_stem):  # noqa: ANN001, ANN202
            name = path.replace("\\", "/").rsplit("/", 1)[-1]
            m = _exact.get(name) or _lower.get(name.lower())
            if m is None:
                same = _by_stem.get(_stem(name).lower()) or []
                want = kind_for(name, mime)
                same = [x for x in same if kind_for(x.path, None) == want] or same
                m = same[0] if same else None
            if m is None:
                return None
            used.add(m.path)
            return {"part": m.part, "member": m.name, "name": m.path.rsplit("/", 1)[-1], "size": m.size}

        stems_with_json = {_stem(m.path).lower() for m in fmembers if m.path.lower().endswith(".json")}
        sources: list[tuple[str, dict[str, Any]]] = []
        for m in sorted(fmembers, key=lambda x: x.path):
            low = m.path.lower()
            if low.endswith(".json"):
                d = jsons.get(m.path)
                if is_keep_note(d):
                    sources.append((m.path, d))
                elif d is not None or m.path in jsons:
                    report["unreadable"] += 1
            elif low.endswith(".html") and _stem(m.path).lower() not in stems_with_json and m.path in htmls:
                d = keep_json_from_html(htmls[m.path])
                if d is not None:
                    sources.append((m.path, d))
        for path, d in sources:
            if d.get("isTrashed") is True:
                report["trashed"] += 1
                continue
            created = d.get("createdTimestampUsec")
            ref = f"keep:{int(float(created))}" if _usec(created) else f"keep:file:{path.rsplit('/', 1)[-1]}"
            if ref in refs:
                ref = f"{ref}:{path.rsplit('/', 1)[-1]}"[:200]
            refs.add(ref)
            note, tell = note_from_keep(d, ref=ref, resolve=resolve)
            if note["kind"] == "text" and not note["title"] and not note["body_doc"] and not note["attachments"]:
                continue  # an empty note
            notes.append(note)
            report["notes"] += 1
            report["lists"] += note["kind"] == "list"
            report["pinned"] += note["pinned"] and not note["archived"]
            report["archived"] += note["archived"]
            report["with_pictures"] += any(a["kind"] == "image" for a in note["attachments"])
            report["with_recordings"] += any(a["kind"] == "audio" for a in note["attachments"])
            report["missing_attachments"] += tell["missing"]
            report["shared"] += bool(tell["shared"])
            report["cut"] += bool(tell["cut"])
            for lb in note["labels"]:
                labels.setdefault(lb.casefold(), lb)
    report["labels"] = sorted(labels.values(), key=str.casefold)[:200]
    return notes, report, used


def read_notes_json(raw: bytes) -> list[dict[str, Any]]:
    """A Promptly export's notes.json (a list of Keep-shaped notes)."""
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return []
    if isinstance(data, dict):
        data = data.get("notes")
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


__all__ = [
    "COLORS", "JSON_MAX", "KEEP_COLOR", "KEEP_PRODUCT", "NOTES_JSON_MAX", "color_of", "is_keep_note", "keep_json_from_html",
    "kind_for", "note_from_keep", "plan_keep", "read_notes_json",
]
