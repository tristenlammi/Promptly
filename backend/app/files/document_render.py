"""Render a Drive Document's Y.js CRDT to sanitised HTML + plain text.

The Hocuspocus collab server POSTs the full merged Y.Doc to
``POST /api/documents/{id}/snapshot`` whenever an editor session goes
idle. This module takes those raw bytes, walks the ``y-prosemirror``
XmlFragment, and produces:

* HTML suitable for preview, download, and sharing — sanitised via
  ``bleach`` with an allowlist that matches the editor's schema.
* Plain text for the ``content_text`` column that backs Drive's FTS
  index.

The reference implementation for y-prosemirror's wire shape is the
upstream JS library:
https://github.com/yjs/y-prosemirror — each ProseMirror block node is
stored as a ``Y.XmlElement`` whose tag *is* the PM node name
(``paragraph``, ``bulletList``, ``codeBlock`` and so on), attrs are
stored as XML attributes, and text runs are ``Y.XmlText`` leaves
carrying mark-format annotations. We translate those names into the
matching HTML tags before letting ``bleach`` enforce the final
allowlist.

Kept deliberately focused on the extension set the editor ships with
(see ``frontend/src/components/files/documents/extensions.ts``) — an
unknown node name is wrapped in a ``<div>`` and still yields
searchable text rather than blowing up.
"""
from __future__ import annotations

import html
import logging
from typing import Any

import bleach

logger = logging.getLogger("promptly.files.document_render")


# --------------------------------------------------------------------
# ProseMirror / TipTap → HTML node mapping
# --------------------------------------------------------------------
# Each entry answers "given this PM node name, render it as which HTML
# tag?". None means "render children only, no wrapping element". The
# ``render`` callable, when present, builds the opening tag for nodes
# whose attributes need translating (headings pick an H-level,
# codeblocks carry a language class, etc.).
_BLOCK_MAP: dict[str, str | None] = {
    "doc": None,  # root — children rendered directly
    "paragraph": "p",
    "blockquote": "blockquote",
    "horizontalRule": "hr",
    "bulletList": "ul",
    "orderedList": "ol",
    "listItem": "li",
    "taskList": "ul",
    "taskItem": "li",
    "codeBlock": "pre",
    "details": "details",
    "detailsSummary": "summary",
    "detailsContent": "div",
    "table": "table",
    "tableRow": "tr",
    "tableCell": "td",
    "tableHeader": "th",
    "image": "img",
    "hardBreak": "br",
    "audio": "audio",
    "youtube": "div",
    "emoji": "span",
    "text": None,
}


# Bleach allowlist. Matches the editor's node + mark set; anything
# outside this gets silently dropped, so a compromised client can't
# persist arbitrary HTML through the snapshot pipeline.
_ALLOWED_TAGS = [
    "a",
    "audio",
    "blockquote",
    "br",
    "code",
    "div",
    "details",
    "em",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "iframe",  # YouTube privacy embed; attrs filter below pins the host.
    "img",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "s",
    "source",
    "span",
    "strong",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
]


def _youtube_src_ok(tag: str, name: str, value: str) -> bool:
    if name != "src":
        return False
    # Pin to the privacy-preserving host. Matches the editor's
    # ``nocookie: true`` default.
    return value.startswith("https://www.youtube-nocookie.com/embed/") or value.startswith(
        "https://www.youtube.com/embed/"
    )


def _iframe_attr_ok(tag: str, name: str, value: str) -> bool:
    # Static attributes survive unchanged; only the ``src`` attribute
    # needs host pinning so ProseMirror can't persist an arbitrary
    # third-party iframe through a compromised client.
    if name in {"width", "height", "frameborder", "allow", "allowfullscreen", "title"}:
        return True
    if name == "src":
        return _youtube_src_ok(tag, name, value)
    return False


_ALLOWED_ATTRS: dict[str, Any] = {
    "*": ["class", "id", "style", "data-checked", "data-type", "dir", "lang"],
    "a": ["href", "title", "target", "rel"],
    "audio": ["controls", "preload", "src"],
    "img": ["src", "alt", "title", "width", "height"],
    "source": ["src", "type"],
    "iframe": _iframe_attr_ok,
    "td": ["colspan", "rowspan"],
    "th": ["colspan", "rowspan"],
    "code": ["class"],
    "pre": ["class"],
    "mark": ["style"],
    "span": ["style"],
}

# Protocol allowlist for href / src. Data URLs are intentionally *not*
# allowed on <a> so a document can't smuggle an inline HTML payload.
_ALLOWED_PROTOCOLS = ["http", "https", "mailto", "tel"]


def sanitize_document_html(raw: str) -> str:
    """Run untrusted HTML through the document allowlist.

    Called both on snapshot render (before we overwrite the file
    blob on disk) and on preview fetch (defence in depth, in case
    an older blob predates an allowlist tightening).
    """
    cleaned = bleach.clean(
        raw,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )
    return cleaned


# --------------------------------------------------------------------
# Y.Doc → HTML walker
# --------------------------------------------------------------------
def _render_marks(text: str, formats: dict[str, Any] | None) -> str:
    """Wrap ``text`` in the mark tags specified by ``formats``.

    ProseMirror serialises its marks as a dict of mark-name → attrs
    (plus a boolean for empty-attrs marks like ``bold``). We wrap
    the innermost-first so ``<strong><em>x</em></strong>`` round-
    trips cleanly.
    """
    escaped = html.escape(text)
    if not formats:
        return escaped

    open_tags: list[str] = []
    close_tags: list[str] = []

    # Iterate in a stable order so repeated renders produce the
    # same bytes (useful for diffable FTS snapshots).
    for mark_name in sorted(formats.keys()):
        attrs = formats[mark_name]
        if mark_name == "bold":
            open_tags.append("<strong>")
            close_tags.append("</strong>")
        elif mark_name == "italic":
            open_tags.append("<em>")
            close_tags.append("</em>")
        elif mark_name == "underline":
            open_tags.append("<u>")
            close_tags.append("</u>")
        elif mark_name == "strike":
            open_tags.append("<s>")
            close_tags.append("</s>")
        elif mark_name == "code":
            open_tags.append("<code>")
            close_tags.append("</code>")
        elif mark_name == "highlight":
            color = (attrs or {}).get("color") if isinstance(attrs, dict) else None
            if color:
                open_tags.append(
                    f'<mark style="background-color:{html.escape(str(color))}">'
                )
            else:
                open_tags.append("<mark>")
            close_tags.append("</mark>")
        elif mark_name == "link":
            href = (attrs or {}).get("href") if isinstance(attrs, dict) else None
            if href:
                open_tags.append(
                    f'<a href="{html.escape(str(href))}" rel="noopener noreferrer" target="_blank">'
                )
                close_tags.append("</a>")

    return "".join(open_tags) + escaped + "".join(reversed(close_tags))


def _render_element(node: Any) -> str:
    """Recursively render a Y.XmlElement / Y.XmlText to HTML."""
    # Y.XmlText: a run of characters with per-chunk mark data.
    # pycrdt exposes chunks via ``diff()`` — each entry is a
    # ``(text, formats)`` pair. Falling back to ``to_py()`` if the
    # runtime shape changes in a future pycrdt release.
    diff_fn = getattr(node, "diff", None)
    if callable(diff_fn) and not hasattr(node, "children"):
        try:
            chunks = diff_fn()
        except Exception:  # noqa: BLE001
            chunks = None
        if chunks is not None:
            return "".join(_render_marks(text, fmt) for text, fmt in chunks)
        to_py = getattr(node, "to_py", None)
        if callable(to_py):
            return _render_marks(str(to_py() or ""), None)

    # Y.XmlElement: has a tag + attributes + children.
    tag_name = getattr(node, "name", None) or getattr(node, "tag", None) or ""
    attrs = dict(getattr(node, "attributes", None) or {})
    children = list(getattr(node, "children", []) or [])

    inner = "".join(_render_element(c) for c in children)
    return _wrap(tag_name, attrs, inner)


def _wrap(tag_name: str, attrs: dict[str, Any], inner: str) -> str:
    """Translate a PM node + its attrs into an HTML element string."""
    # Doc root — render children without a wrapper.
    if tag_name in ("doc", "", "text"):
        return inner

    # Heading: attrs.level picks h1..h6.
    if tag_name == "heading":
        try:
            level = int(attrs.get("level", 1))
        except (TypeError, ValueError):
            level = 1
        level = max(1, min(6, level))
        return f"<h{level}>{inner}</h{level}>"

    # Code block: lowlight passes ``language`` via attrs.
    if tag_name == "codeBlock":
        language = attrs.get("language")
        if language:
            lang = html.escape(str(language))
            return f'<pre><code class="language-{lang}">{inner}</code></pre>'
        return f"<pre><code>{inner}</code></pre>"

    # Task item: carries ``checked`` in attrs.
    if tag_name == "taskItem":
        checked = bool(attrs.get("checked", False))
        state = "true" if checked else "false"
        return f'<li data-type="taskItem" data-checked="{state}">{inner}</li>'

    if tag_name == "taskList":
        return f'<ul data-type="taskList">{inner}</ul>'

    # Ordered list: attrs.start / type.
    if tag_name == "orderedList":
        bits = ["<ol"]
        start = attrs.get("start")
        if start and str(start) != "1":
            bits.append(f' start="{html.escape(str(start))}"')
        bits.append(">")
        bits.append(inner)
        bits.append("</ol>")
        return "".join(bits)

    # Image: attrs.src / alt / title.
    if tag_name == "image":
        src = attrs.get("src", "")
        alt = attrs.get("alt", "")
        title = attrs.get("title", "")
        parts = [f'<img src="{html.escape(str(src))}"']
        if alt:
            parts.append(f' alt="{html.escape(str(alt))}"')
        if title:
            parts.append(f' title="{html.escape(str(title))}"')
        parts.append(" />")
        return "".join(parts)

    # Audio (custom node view): attrs.src + optional controls.
    if tag_name == "audio":
        src = attrs.get("src", "")
        return (
            f'<audio controls preload="metadata" src="{html.escape(str(src))}"></audio>'
        )

    # YouTube embed: wrap the privacy-enhanced iframe in a div so
    # the preview can style the aspect ratio.
    if tag_name == "youtube":
        src = str(attrs.get("src", ""))
        # Only privacy-preserving embeds survive the allowlist
        # filter; anything else will be stripped by bleach later.
        if src and not src.startswith("https://www.youtube"):
            src = ""
        return (
            '<div class="youtube-embed" data-type="youtube">'
            f'<iframe src="{html.escape(src)}" frameborder="0" '
            'allow="accelerometer; encrypted-media; picture-in-picture" '
            "allowfullscreen></iframe>"
            "</div>"
        )

    # Emoji (MIT dataset): attrs.emoji is the unicode glyph.
    if tag_name == "emoji":
        glyph = attrs.get("emoji") or attrs.get("name") or ""
        return f'<span data-type="emoji">{html.escape(str(glyph))}</span>'

    # Details / summary block.
    if tag_name in ("details", "detailsSummary", "detailsContent"):
        mapped = _BLOCK_MAP.get(tag_name, "div") or "div"
        return f"<{mapped}>{inner}</{mapped}>"

    # Fall back to the declared block mapping.
    html_tag = _BLOCK_MAP.get(tag_name)
    if html_tag is None:
        # Unknown wrapper — inline children without a tag.
        return inner

    # Self-closing block tags.
    if html_tag in ("hr", "br"):
        return f"<{html_tag} />"

    return f"<{html_tag}>{inner}</{html_tag}>"


# --------------------------------------------------------------------
# Public helpers used by the router
# --------------------------------------------------------------------
def render_html_from_update(update_bytes: bytes) -> str:
    """Decode the Y.Doc update blob and render sanitised HTML."""
    doc = _apply_update(update_bytes)
    if doc is None:
        return ""
    try:
        # The TipTap Collaboration extension writes into the Y.Doc
        # under the fragment field configured on the Editor. Default
        # is ``default``; we match that here (and in the frontend).
        from pycrdt import XmlFragment  # type: ignore

        frag = doc.get("default", type=XmlFragment)
    except Exception:  # noqa: BLE001
        logger.exception("unable to load 'default' XmlFragment from doc update")
        return ""

    body = "".join(_render_element(child) for child in frag.children)
    return sanitize_document_html(body)


def extract_text_from_html(rendered_html: str) -> str:
    """Strip HTML tags from ``rendered_html`` for the FTS index.

    We intentionally collapse whitespace so phrase search works
    across line breaks introduced by block elements. ``<script>`` /
    ``<style>`` block contents are dropped entirely (both tag *and*
    inner text) because their bodies are code, not prose — leaving
    them in would pollute the FTS column with false hits.
    """
    if not rendered_html:
        return ""

    import re

    # Bleach's ``strip=True`` drops the tags but keeps inner text.
    # Remove ``<script>`` / ``<style>`` subtrees *before* stripping
    # so their bodies never reach the FTS column.
    pre = re.sub(
        r"<(script|style)\b[^>]*>.*?</\1\s*>",
        " ",
        rendered_html,
        flags=re.DOTALL | re.IGNORECASE,
    )
    stripped = bleach.clean(
        pre, tags=[], attributes={}, strip=True, strip_comments=True
    )
    return " ".join(stripped.split())


def _apply_update(update_bytes: bytes):
    """Instantiate a new Y.Doc and apply the update, or return None."""
    try:
        from pycrdt import Doc  # type: ignore
    except ImportError:  # pragma: no cover
        logger.warning(
            "pycrdt not installed; snapshot render is a no-op. "
            "Install requirements.txt to enable document snapshots."
        )
        return None

    try:
        doc = Doc()
        doc.apply_update(update_bytes)
        return doc
    except Exception:  # noqa: BLE001
        logger.exception("pycrdt failed to apply update")
        return None


__all__ = [
    "render_html_from_update",
    "extract_text_from_html",
    "sanitize_document_html",
]
