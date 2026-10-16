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

GFM extras the importers and templates rely on (R-314): tables and
``~~strike~~`` via markdown-it's own rules; ``- [ ]`` task items and leading
YAML front matter (Obsidian properties — dropped) handled in this module.
Images (``![alt](https://…)``) become the editor's image blocks (R-229).
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("promptly.files.document_build")

# YAML front matter (Obsidian / Jekyll properties): a ``---`` fence on the very
# first line, closed by ``---`` or ``...`` on its own line. Without stripping,
# markdown-it reads the fences as an <hr> + setext <h2> (R-314).
_FRONT_MATTER_RE = re.compile(
    r"\A\ufeff?---[ \t]*\r?\n(?:.*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)

# GFM task marker at the start of a list item's first paragraph: ``[ ]`` /
# ``[x]`` followed by whitespace or the end of the item (``- [ ]`` alone is an
# empty task — templates seed those).
_TASK_MARKER_RE = re.compile(r"\A\[([ xX])\](?:[ \t]+|\Z)")


# Front matter is a YAML *mapping*: its first real line is ``key: …``. Checking
# that keeps a note that merely opens with an ``---`` rule (automation output
# does) from losing everything up to its next rule.
_YAML_KEY_RE = re.compile(r"\A[\"']?[\w][\w .\"'-]*:(?:\s|\Z)")


def _strip_front_matter(text: str) -> str:
    """Drop a leading YAML front-matter block, if there is one."""
    m = _FRONT_MATTER_RE.match(text)
    if not m:
        return text
    body = m.group(0).splitlines()[1:-1]
    first = next((ln.strip() for ln in body if ln.strip()), "")
    if first and not _YAML_KEY_RE.match(first):
        return text
    return text[m.end():]


def _task_marker(item: Any) -> tuple[bool, int] | None:
    """``(checked, marker_len)`` when ``item`` (a list_item) is a GFM task.

    The marker must open the item's *first* paragraph — a ``[ ]`` mid-sentence
    stays literal text, as in GFM."""
    kids = item.children or []
    if not kids or kids[0].type != "paragraph":
        return None
    inline = next((c for c in kids[0].children or [] if c.type == "inline"), None)
    first = (inline.children or [None])[0] if inline is not None else None
    if first is None or first.type != "text":
        return None
    m = _TASK_MARKER_RE.match(first.content)
    if not m:
        return None
    return m.group(1) in "xX", m.end()


def _fill_inline(el: Any, inline_node: Any, skip: int = 0) -> None:
    """Append a Y.XmlText run to ``el`` carrying ``inline_node``'s marked text.

    ``skip`` drops that many leading characters of the first text run (the
    ``[ ] `` of a task item)."""
    from pycrdt import XmlText

    xt = XmlText()
    el.children.append(xt)
    pending_skip = [skip]

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
                content = c.content
                if pending_skip[0]:
                    content = content[pending_skip[0]:]
                    pending_skip[0] = 0
                ins(content, marks)
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


_SAFE_IMAGE_SRC = re.compile(r"^(https?://|/api/documents/)", re.I)


class _Run:
    """A slice of an inline node's children, walkable like the node."""

    def __init__(self, children: list[Any]) -> None:
        self.children = children


def _paragraph_with_images(parent: Any, inline: Any) -> None:
    """The editor's image is a block, so a Markdown paragraph holding
    pictures becomes text paragraphs and image nodes, in order (R-229)."""
    from pycrdt import XmlElement

    run: list[Any] = []

    def flush() -> None:
        texts = [c for c in run if not (c.type == "softbreak" or (c.type == "text" and not c.content.strip()))]
        if texts:
            el = XmlElement("paragraph")
            parent.children.append(el)
            _fill_inline(el, _Run(list(run)))
        run.clear()

    for c in inline.children or []:
        if c.type != "image":
            run.append(c)
            continue
        flush()
        src = str((c.attrs or {}).get("src", ""))
        if not _SAFE_IMAGE_SRC.match(src):
            continue  # data: / javascript: / relative paths aren't images we can show
        alt = "".join(ch.content for ch in (c.children or []) if ch.type == "text") or str(c.content or "")
        attrs = {"src": src}
        if alt:
            attrs["alt"] = alt
        title = (c.attrs or {}).get("title")
        if title:
            attrs["title"] = str(title)
        parent.children.append(XmlElement("image", attrs))
    flush()


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
        inline = next((c for c in node.children or [] if c.type == "inline"), None)
        if inline is not None and any(c.type == "image" for c in inline.children or []):
            _paragraph_with_images(parent, inline)
            return
        el = XmlElement("paragraph")
        parent.children.append(el)
        for c in node.children:
            if c.type == "inline":
                _fill_inline(el, c)
    elif t == "bullet_list":
        # GFM task items → taskList / taskItem(checked). The editor's taskList
        # holds only taskItems, so a mixed list (Obsidian allows one) splits
        # into consecutive bulletList / taskList runs, keeping item order.
        el = None
        el_is_task = None
        for c in node.children:
            marker = _task_marker(c) if c.type == "list_item" else None
            if el is None or el_is_task != (marker is not None):
                el_is_task = marker is not None
                el = XmlElement("taskList" if el_is_task else "bulletList")
                parent.children.append(el)
            if marker is None:
                _build_block(el, c)
                continue
            checked, skip = marker
            item = XmlElement("taskItem", {"checked": checked})
            el.children.append(item)
            # First child is the paragraph _task_marker matched (taskItem's
            # content is ``paragraph block*``); strip the marker from it.
            head, *rest = c.children
            para = XmlElement("paragraph")
            item.children.append(para)
            for ic in head.children or []:
                if ic.type == "inline":
                    _fill_inline(para, ic, skip=skip)
            for rc in rest:
                _build_block(item, rc)
    elif t == "ordered_list":
        el = XmlElement("orderedList")
        parent.children.append(el)
        for c in node.children:
            _build_block(el, c)
    elif t == "list_item":
        el = XmlElement("listItem")
        parent.children.append(el)
        for c in node.children:
            _build_block(el, c)
        # A bare "- " (templates seed them) parses with no children, but
        # listItem's content is ``paragraph block*`` — give it an empty one.
        if not node.children:
            para = XmlElement("paragraph")
            el.children.append(para)
            para.children.append(XmlText())
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
    elif t == "table":
        # GFM table → the editor's table / tableRow / tableHeader|tableCell,
        # each cell holding one paragraph. Templates and automation notes
        # with tables used to arrive as literal "| a | b |" text (V3).
        el = XmlElement("table")
        parent.children.append(el)
        for section in node.children or []:  # thead / tbody
            for tr in section.children or []:
                row = XmlElement("tableRow")
                el.children.append(row)
                for cell in tr.children or []:
                    cel = XmlElement("tableHeader" if cell.type == "th" else "tableCell")
                    row.children.append(cel)
                    para = XmlElement("paragraph")
                    cel.children.append(para)
                    for c in cell.children or []:
                        if c.type == "inline":
                            _fill_inline(para, c)
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
        # The commonmark preset leaves GFM tables and ~~strike~~ off; task
        # items and front matter are handled here (no mdit-py-plugins dep).
        md = MarkdownIt("commonmark").enable(["table", "strikethrough"])
        tree = SyntaxTreeNode(md.parse(_strip_front_matter(text or "")))
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
