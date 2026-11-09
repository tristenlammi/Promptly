"""A note's body: a small TipTap document, kept tidy, and its plain text.

The editor's schema is deliberately small (paragraphs, H1/H2, bold, italic,
underline, links). What's saved is cleaned to that schema here, so nothing
else — scripts, odd node types, ``javascript:`` links — is ever stored, and
whatever writes a note (web, phone, chat, an import) gets the same result.
Each block may carry a short stable ``id`` (the client merges by it after a
409).
"""
from __future__ import annotations

import json
import re
from typing import Any

MAX_TEXT = 20_000  # characters of plain text in one note's body
MAX_DOC_BYTES = 400_000  # the saved JSON, generously above MAX_TEXT
_MAX_DEPTH = 12

BLOCKS = {"paragraph", "heading"}
MARKS = {"bold", "italic", "underline", "link"}
_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_SAFE_HREF = re.compile(r"^(https?://|mailto:|/(?!/))", re.IGNORECASE)


class BodyError(ValueError):
    """The body can't be saved (→ 400, message for the person)."""


def _text_of(node: Any, depth: int = 0) -> str:
    if depth > _MAX_DEPTH or not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return str(node.get("text") or "")
    if node.get("type") == "hardBreak":
        return "\n"
    return "".join(_text_of(c, depth + 1) for c in node.get("content") or [] if isinstance(c, dict))


def _marks(raw: Any) -> list[dict]:
    out: list[dict] = []
    for m in raw or []:
        if not isinstance(m, dict) or m.get("type") not in MARKS:
            continue
        if m["type"] == "link":
            href = str((m.get("attrs") or {}).get("href") or "").strip()
            if not href or len(href) > 2000 or not _SAFE_HREF.match(href):
                continue
            out.append({"type": "link", "attrs": {"href": href}})
        else:
            out.append({"type": m["type"]})
    return out


def _inline(nodes: Any) -> list[dict]:
    out: list[dict] = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t == "text":
            s = str(n.get("text") or "")
            if not s:
                continue
            node: dict[str, Any] = {"type": "text", "text": s}
            marks = _marks(n.get("marks"))
            if marks:
                node["marks"] = marks
            out.append(node)
        elif t == "hardBreak":
            out.append({"type": "hardBreak"})
        else:
            # Anything else inline (a mention chip, an image…) keeps its words.
            s = _text_of(n)
            if s:
                out.append({"type": "text", "text": s})
    return out


def _block_attrs(n: dict, heading: bool) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    raw = n.get("attrs") or {}
    bid = raw.get("id")
    if isinstance(bid, str) and _ID.match(bid):
        attrs["id"] = bid
    if heading:
        level = raw.get("level")
        attrs["level"] = level if level in (1, 2) else 2
    return attrs


def _blocks(nodes: Any, depth: int = 0) -> list[dict]:
    out: list[dict] = []
    if depth > _MAX_DEPTH:
        return out
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t in BLOCKS:
            block: dict[str, Any] = {"type": t}
            attrs = _block_attrs(n, t == "heading")
            if attrs:
                block["attrs"] = attrs
            content = _inline(n.get("content"))
            if content:
                block["content"] = content
            out.append(block)
        elif isinstance(n.get("content"), list) and any(isinstance(c, dict) and c.get("type") not in ("text", "hardBreak") for c in n["content"]):
            # A wrapper (a list, a quote…): its blocks, flattened.
            out.extend(_blocks(n["content"], depth + 1))
        else:
            s = _text_of(n)
            if s:
                out.append({"type": "paragraph", "content": [{"type": "text", "text": s}]})
    return out


def clean_doc(doc: Any) -> dict[str, Any] | None:
    """``doc`` reduced to the notes schema, or None for an empty body."""
    if doc is None:
        return None
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        raise BodyError("The note's text isn't in a form Promptly can save.")
    try:
        size = len(json.dumps(doc, ensure_ascii=False))
    except (TypeError, ValueError) as e:
        raise BodyError("The note's text isn't in a form Promptly can save.") from e
    if size > MAX_DOC_BYTES:
        raise BodyError("This note is too long. Use Open as document for long writing.")
    blocks = _blocks(doc.get("content"))
    if not blocks or all(not b.get("content") for b in blocks):
        return None
    return {"type": "doc", "content": blocks}


def doc_text(doc: dict[str, Any] | None) -> str:
    """The body as plain text: one line per block."""
    if not doc:
        return ""
    return "\n".join(_text_of(b) for b in doc.get("content") or []).strip("\n")


def text_doc(text: str) -> dict[str, Any] | None:
    """A body from plain text: a paragraph per line."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return None
    return {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": ln}]} if ln else {"type": "paragraph"} for ln in lines],
    }


def checked_text(text: str) -> str:
    """Refuse a body over the limit (the message says what to do instead)."""
    if len(text) > MAX_TEXT:
        raise BodyError("This note is too long. Use Open as document for long writing.")
    return text


__all__ = ["BodyError", "MAX_TEXT", "checked_text", "clean_doc", "doc_text", "text_doc"]
