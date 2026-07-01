"""Build a Drive Document's Y.js CRDT *from* Markdown.

The inverse of :mod:`app.files.document_render`: given Markdown text (an
automation's output), produce the ``yjs_update`` bytes for a fresh
``DocumentState`` so the note opens in the TipTap editor already populated.

We parse Markdown with ``markdown-it-py`` and translate its syntax tree into the
same ``y-prosemirror`` XmlFragment shape the editor reads — block nodes are
``Y.XmlElement`` whose tag is the PM node name (``paragraph``, ``heading``,
``bulletList`` …), inline runs are ``Y.XmlText`` leaves carrying mark formats
(``bold``/``italic``/``code``/``link`` …). Only the block + mark set the editor
ships is emitted; anything else degrades to plain paragraphs rather than failing.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("promptly.files.document_build")


def _fill_inline(el: Any, inline_node: Any) -> None:
    """Append a Y.XmlText run to ``el`` carrying ``inline_node``'s marked text."""
    from pycrdt import XmlText

    xt = XmlText()
    el.children.append(xt)

    def ins(text: str, marks: dict[str, Any]) -> None:
        if not text:
            return
        idx = len(str(xt))
        if marks:
            xt.insert(idx, text, marks)
        else:
            xt.insert(idx, text)

    def walk(node: Any, marks: dict[str, Any]) -> None:
        for c in node.children or []:
            t = c.type
            if t == "text":
                ins(c.content, marks)
            elif t == "code_inline":
                ins(c.content, {**marks, "code": True})
            elif t == "strong":
                walk(c, {**marks, "bold": True})
            elif t == "em":
                walk(c, {**marks, "italic": True})
            elif t == "s":
                walk(c, {**marks, "strike": True})
            elif t == "link":
                href = (c.attrs or {}).get("href", "")
                walk(c, {**marks, "link": {"href": str(href)}})
            elif t == "softbreak":
                ins(" ", marks)
            elif t == "hardbreak":
                ins("\n", marks)
            else:
                walk(c, marks)

    walk(inline_node, {})


def _build_block(parent: Any, node: Any) -> None:
    """Translate one Markdown block node onto ``parent.children``."""
    from pycrdt import XmlElement, XmlText

    t = node.type
    if t == "heading":
        try:
            level = str(max(1, min(6, int(node.tag[1]))))
        except (ValueError, IndexError):
            level = "1"
        el = XmlElement("heading", {"level": level})
        parent.children.append(el)
        for c in node.children:
            if c.type == "inline":
                _fill_inline(el, c)
    elif t == "paragraph":
        el = XmlElement("paragraph")
        parent.children.append(el)
        for c in node.children:
            if c.type == "inline":
                _fill_inline(el, c)
    elif t in ("bullet_list", "ordered_list"):
        el = XmlElement("bulletList" if t == "bullet_list" else "orderedList")
        parent.children.append(el)
        for c in node.children:
            _build_block(el, c)
    elif t == "list_item":
        el = XmlElement("listItem")
        parent.children.append(el)
        for c in node.children:
            _build_block(el, c)
    elif t == "blockquote":
        el = XmlElement("blockquote")
        parent.children.append(el)
        for c in node.children:
            _build_block(el, c)
    elif t in ("fence", "code_block"):
        info = (getattr(node, "info", "") or "").strip()
        attrs = {"language": info} if info else None
        el = XmlElement("codeBlock", attrs)
        parent.children.append(el)
        el.children.append(XmlText(node.content.rstrip("\n")))
    elif t == "hr":
        parent.children.append(XmlElement("horizontalRule"))
    else:
        # Unknown container — flatten its children so nothing is lost.
        for c in node.children or []:
            _build_block(parent, c)


def markdown_to_doc_update(text: str) -> bytes:
    """Markdown → the ``yjs_update`` bytes for a fresh DocumentState.

    Falls back to a single plain-text paragraph if parsing fails, so a note is
    always created with *something* rather than erroring the run."""
    from markdown_it import MarkdownIt
    from markdown_it.tree import SyntaxTreeNode
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    doc = Doc()
    frag = doc.get("default", type=XmlFragment)
    try:
        tree = SyntaxTreeNode(MarkdownIt().parse(text or ""))
        for node in tree.children:
            _build_block(frag, node)
    except Exception:  # noqa: BLE001 — never fail the run on a parse hiccup
        logger.warning("markdown→doc parse failed; falling back to plain text",
                       exc_info=True)
        frag = doc.get("default", type=XmlFragment)
    # A doc must have at least one block or the editor renders nothing.
    if not list(frag.children):
        p = XmlElement("paragraph")
        frag.children.append(p)
        p.children.append(XmlText((text or "").strip()))
    return doc.get_update()


__all__ = ["markdown_to_doc_update"]
