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
import re
from typing import Any

import bleach

logger = logging.getLogger("promptly.files.document_render")

# Colours allowed on a textStyle span (@tiptap/extension-color): hex,
# rgb()/rgba(), or a bare CSS colour keyword. Anything else is dropped so a
# ``style`` value can't smuggle arbitrary CSS through the snapshot.
_SAFE_COLOR = re.compile(
    r"^#[0-9a-fA-F]{3,8}$"
    r"|^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$"
    r"|^[a-zA-Z]{3,20}$"
)


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
    "figcaption",
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
    "sub",
    "summary",
    "sup",
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


# Inline styles the editor produces (R-223): text / highlight colour,
# alignment, font family and size, and table / image widths. bleach
# without a CSS sanitizer blanked every ``style`` (colours "randomly
# disappeared" from previews, exports and restores); instead each
# declaration is checked here and a style with anything else is dropped.
_LENGTH = r"\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|%)"
_STYLE_VALUE = {
    "color": _SAFE_COLOR,
    "background-color": _SAFE_COLOR,
    "text-align": re.compile(r"^(left|right|center|justify|start|end)$"),
    "font-family": re.compile(r"^[A-Za-z0-9 ,'\"-]{1,120}$"),
    "font-size": re.compile(rf"^{_LENGTH}$"),
    "width": re.compile(rf"^{_LENGTH}$"),
    "min-width": re.compile(rf"^{_LENGTH}$"),
}
_STYLE_DANGER = re.compile(r"[\\/*<>@{}]|url\s*\(|expression|&#", re.I)


def safe_style(value: str) -> bool:
    """True when every declaration in ``value`` is an allowed property with
    a safe value (no ``url()``, ``expression``, comments or escapes)."""
    if not value or len(value) > 500 or _STYLE_DANGER.search(value):
        return False
    decls = [d.strip() for d in value.split(";") if d.strip()]
    if not decls:
        return False
    for decl in decls:
        prop, sep, val = decl.partition(":")
        prop, val = prop.strip().lower(), val.strip()
        pattern = _STYLE_VALUE.get(prop)
        if not sep or pattern is None or not pattern.match(val):
            return False
    return True


_COMMON_ATTRS = {
    "class",
    "id",
    "data-checked",
    "data-type",
    "data-variant",  # callout colour
    "data-align",  # image / figure alignment
    "data-latex",  # maths source
    "data-caption",
    "data-user-id",  # @-mentioned person
    # A suggestion (suggestion mode): ins | del, its id, who and when.
    "data-suggest",
    "data-id",
    "data-author",
    "data-author-id",
    "data-at",
    "dir",
    "lang",
}

_PER_TAG = {
    "a": {"href", "title", "target", "rel"},
    "audio": {"controls", "preload", "src"},
    "img": {"src", "alt", "title", "width", "height"},
    "source": {"src", "type"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}


def _attr_ok(tag: str, name: str, value: str) -> bool:
    if tag == "iframe":
        return _iframe_attr_ok(tag, name, value)
    if name in _PER_TAG.get(tag, ()):
        return True
    if name == "style":
        return safe_style(value)
    return name in _COMMON_ATTRS


# One callable for every tag (bleach consults a tag's own entry *instead
# of* "*", so per-tag lists would bypass the style check).
_ALLOWED_ATTRS: Any = _attr_ok


class _StyleSanitizer:
    """bleach 6 empties every ``style`` unless it's given a CSS sanitizer;
    it only calls ``sanitize_css``. Styles reaching here already passed
    :func:`safe_style` in the attribute filter — keep them as written."""

    def sanitize_css(self, style: str) -> str:
        return style if safe_style(style) else ""


_CSS_SANITIZER = _StyleSanitizer()

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
        css_sanitizer=_CSS_SANITIZER,
        strip=True,
        strip_comments=True,
    )
    return cleaned


# --------------------------------------------------------------------
# Y.Doc → HTML walker
# --------------------------------------------------------------------
def _text_style(attrs: dict[str, Any]) -> str:
    parts = []
    for key, prop in (("color", "color"), ("fontFamily", "font-family"), ("fontSize", "font-size")):
        val = attrs.get(key)
        if val is None or val == "":
            continue
        decl = f"{prop}:{str(val).strip()}"
        if safe_style(decl):
            parts.append(decl)
    return ";".join(parts)


def _align_attr(attrs: dict[str, Any]) -> str:
    align = attrs.get("textAlign")
    if align and str(align) in ("center", "right", "justify"):
        return f' style="text-align:{align}"'
    return ""


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
        elif mark_name == "subscript":
            open_tags.append("<sub>")
            close_tags.append("</sub>")
        elif mark_name == "superscript":
            open_tags.append("<sup>")
            close_tags.append("</sup>")
        elif mark_name == "mention":
            # @person chip; ``data-user-id`` says who (R-232).
            uid = (attrs or {}).get("userId") if isinstance(attrs, dict) else None
            uid_attr = f' data-user-id="{html.escape(str(uid))}"' if uid and re.fullmatch(r"[0-9a-fA-F-]{36}", str(uid)) else ""
            open_tags.append(f'<span class="doc-mention" data-type="mention"{uid_attr}>')
            close_tags.append("</span>")
        elif mark_name == "textStyle":
            # Colour, font family and size ride on TextStyle. Only values
            # the style allowlist accepts are emitted.
            style = _text_style(attrs if isinstance(attrs, dict) else {})
            if style:
                open_tags.append(f'<span style="{html.escape(style)}">')
                close_tags.append("</span>")
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
        return f"<h{level}{_align_attr(attrs)}>{inner}</h{level}>"

    if tag_name == "paragraph":
        return f"<p{_align_attr(attrs)}>{inner}</p>"

    # Table cells keep their spans and widths (merged cells used to come
    # out as plain cells in previews, exports and the Word download).
    if tag_name in ("tableCell", "tableHeader"):
        cell = "th" if tag_name == "tableHeader" else "td"
        bits = [f"<{cell}"]
        for key in ("colspan", "rowspan"):
            try:
                n = int(float(attrs.get(key) or 1))
            except (TypeError, ValueError):
                n = 1
            if n > 1:
                bits.append(f' {key}="{min(n, 100)}"')
        widths = attrs.get("colwidth")
        if isinstance(widths, str):
            widths = [w for w in widths.split(",") if w.strip()]
        try:
            total = sum(int(float(w)) for w in widths or [] if w is not None)
        except (TypeError, ValueError):
            total = 0
        if total > 0:
            bits.append(f' style="width:{min(total, 4000)}px"')
        return "".join(bits) + f">{inner}</{cell}>"

    if tag_name == "pageBreak":
        return '<div class="doc-page-break" data-type="page-break"></div>'

    # Maths: the LaTeX source, for the reader to render (and as text for
    # search and exports).
    if tag_name in ("inlineMath", "blockMath"):
        esc = html.escape(str(attrs.get("latex") or ""))
        if tag_name == "inlineMath":
            return f'<span class="doc-math" data-type="inline-math" data-latex="{esc}">{esc}</span>'
        return f'<div class="doc-math" data-type="block-math" data-latex="{esc}">{esc}</div>'

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

    # Image: attrs.src / alt / title, plus width (resize), caption and
    # alignment; a captioned or aligned image becomes a <figure>.
    if tag_name == "image":
        src = attrs.get("src", "")
        alt = attrs.get("alt", "")
        title = attrs.get("title", "")
        parts = [f'<img src="{html.escape(str(src))}"']
        if alt:
            parts.append(f' alt="{html.escape(str(alt))}"')
        if title:
            parts.append(f' title="{html.escape(str(title))}"')
        try:
            width = int(float(attrs.get("width") or 0))
        except (TypeError, ValueError):
            width = 0
        if width > 0:
            parts.append(f' width="{min(width, 4000)}"')
        parts.append(" />")
        img = "".join(parts)
        caption = str(attrs.get("caption") or "").strip()
        align = str(attrs.get("align") or "")
        if not caption and align not in ("left", "right"):
            return img
        align_attr = f' data-align="{align}"' if align in ("left", "center", "right") else ""
        cap = f"<figcaption>{html.escape(caption)}</figcaption>" if caption else ""
        return f'<figure class="doc-figure"{align_attr}>{img}{cap}</figure>'

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

    # Multi-column layout — flex row + equal columns via CSS.
    if tag_name == "columns":
        return f'<div class="doc-columns" data-type="columns">{inner}</div>'
    if tag_name == "column":
        return f'<div class="doc-column" data-type="column">{inner}</div>'

    # Callout box — variant drives the colour/icon in CSS. Mirror the
    # editor's renderHTML so the collab snapshot matches a manual save.
    if tag_name == "callout":
        variant = str(attrs.get("variant") or "info")
        if variant not in ("info", "warning", "success", "danger"):
            variant = "info"
        return (
            f'<div class="doc-callout" data-type="callout" '
            f'data-variant="{variant}">{inner}</div>'
        )

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
