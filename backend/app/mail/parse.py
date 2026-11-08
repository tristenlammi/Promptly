"""Turning a raw email into what the app shows. Everything in a message is written
by a stranger, so nothing here trusts it: HTML is cut down to harmless tags, remote
images are switched off until you ask, and the page itself runs in a sandbox."""
from __future__ import annotations

import base64
import email
import hashlib
import html
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any

import bleach
from bleach.css_sanitizer import CSSSanitizer

MAX_INLINE_IMAGE = 2 * 1024 * 1024
_TAGS = frozenset({
    "a", "abbr", "b", "blockquote", "br", "center", "code", "col", "colgroup", "dd", "div", "dl", "dt", "em", "font",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strike",
    "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul",
})
_ATTRS = {
    "*": ["style", "align", "valign", "dir", "width", "height", "bgcolor", "color", "colspan", "rowspan", "cellpadding", "cellspacing", "border", "face", "size"],
    "a": ["href", "title"],
    "img": ["src", "alt", "title", "data-remote-src"],
}
_CSS = CSSSanitizer(allowed_css_properties=[
    "background-color", "border", "border-bottom", "border-collapse", "border-color", "border-left", "border-radius",
    "border-right", "border-spacing", "border-style", "border-top", "border-width", "color", "direction", "display",
    "font", "font-family", "font-size", "font-style", "font-weight", "height", "letter-spacing", "line-height", "list-style",
    "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "max-width", "min-width", "padding",
    "padding-bottom", "padding-left", "padding-right", "padding-top", "text-align", "text-decoration", "text-indent",
    "text-transform", "vertical-align", "white-space", "width", "word-break",
])
# Each of these, run with plain ``re.sub``, rescans to the end of the message from
# every place a match fails, so a stranger can send a page that takes minutes per
# megabyte. The helpers below give the same result, but each skips the places that
# are already known to fail.
_DROPPED = ("script", "style", "head", "title", "iframe", "object", "embed", "svg", "math", "template", "noscript")
_DROP_OPEN = re.compile(rf"<({'|'.join(_DROPPED)})\b", re.IGNORECASE)
_DROP_CLOSE = {tag: re.compile(rf"</{tag}\s*>", re.IGNORECASE) for tag in _DROPPED}
_IMG_OPEN = re.compile(r"<img\b", re.IGNORECASE)
_TAG_SRC = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_BLOCK_END = re.compile(r"<(br|/p|/div|/tr|/li|/h[1-6])\b[^>]*>", re.IGNORECASE)
_ANY_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")

# bleach reads HTML with html5lib, which is plain Python and slower than linear on
# shapes a stranger can send: thousands of attributes in one tag, elements nested
# thousands deep, thousands of siblings that each hold something, bold left open
# again and again, a long run of stray "<" or "&". At 1 MB those take from 20 seconds
# to minutes, holding up the mail worker (or, sending, the whole app). An email past
# any of these limits is shown as plain text instead, like Gmail's "message clipped".
# Real mail is far inside them (Gmail itself clips at 102 KB); together they keep the
# slowest page that fits to about a second here (see test_mail_parse.py).
MAX_HTML = 256 * 1024
# Every "<", "&" and NUL starts a tag or a new piece of text, so this also caps how
# badly anything not counted below can go: about two seconds.
_MAX_MARKS = 20_000
_MAX_ATTR_WORK = 2_000_000  # attributes in a tag, squared, summed over the tags
_MAX_DEPTH_WORK = 1_500_000  # elements open at each tag, summed over the tags
_MAX_WIDTH_WORK = 40_000_000  # for each element, its children times those with children
# A formatting tag that's closed by the block around it, not by its own end tag, is
# copied into every later block (bold, then a hundred paragraphs: a hundred bolds),
# which costs the most of all.
_MAX_FORMAT_WORK = 50_000  # such formatting tags at each tag, summed over the tags
_FORMATTING = frozenset("a b big code em font i nobr s small strike strong tt u".split())
# Opening one of these closes a paragraph, and the formatting inside it.
_CLOSES_P = frozenset(
    "address article aside blockquote center dd details dialog dir div dl dt fieldset figcaption figure footer form "
    "h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p plaintext pre section summary table ul xmp".split()
)
# Tags read the way html5lib reads them, so attributes can't hide from the count: only
# these five are spaces, "/" also separates, and only a value after "=" is quoted.
_HWS = "\t\n\f\r "
_VALUE = rf"""(?:[{_HWS}]*=[{_HWS}]*(?:"[^"]*"|'[^']*'|[^{_HWS}>]*))?"""
_ATTR = re.compile(rf"[^{_HWS}/>][^{_HWS}/>=]*{_VALUE}")
_TAG = re.compile(rf"<(/?)([A-Za-z][^{_HWS}/>]*)((?:[{_HWS}/]+|[^{_HWS}/>][^{_HWS}/>=]*{_VALUE})*)")
_VOID = frozenset("area base basefont bgsound br col embed frame hr image img input keygen link menuitem meta param source track wbr".split())
# Opening one of these closes the last one still open, so a page that never closes
# its paragraphs or cells isn't counted as nested.
_PEERS = frozenset("dd dt li optgroup option p rb rp rt td th tr".split())


def _drop_with_content(raw: str, replacement: str) -> str:
    """Remove ``<script>…</script>`` and the like, contents and all. Like
    ``<(script|…)\\b.*?</\\1\\s*>``, but once a kind of tag has no closing tag left
    in the message, its later openings are skipped instead of each rescanning."""
    out: list[str] = []
    kept = at = 0
    unclosed: set[str] = set()
    while (opening := _DROP_OPEN.search(raw, at)) is not None:
        tag = opening.group(1).lower()
        closing = None if tag in unclosed else _DROP_CLOSE[tag].search(raw, opening.end())
        if closing is None:
            unclosed.add(tag)
            at = opening.end()
            continue
        out += [raw[kept:opening.start()], replacement]
        kept = at = closing.end()
    out.append(raw[kept:])
    return "".join(out)


def _sub_img_src(raw: str, replace: Any) -> str:
    """``_TAG_SRC.sub(replace, raw)``. When an ``<img`` has no usable ``src`` before
    its ``>``, no other ``<img`` before that ``>`` has one either, so skip past it."""
    out: list[str] = []
    kept = at = 0
    while (opening := _IMG_OPEN.search(raw, at)) is not None:
        match = _TAG_SRC.match(raw, opening.start())
        if match is None:
            close = raw.find(">", opening.start())
            at = len(raw) if close < 0 else close + 1
            continue
        out += [raw[kept:match.start()], replace(match)]
        kept = at = match.end()
    out.append(raw[kept:])
    return "".join(out)


def _sub_tags(pattern: re.Pattern[str], replacement: str, raw: str) -> str:
    """For a pattern whose every match ends in ``>``: nothing after the last ``>``
    can match, so don't let each ``<`` there rescan to the end."""
    end = raw.rfind(">") + 1
    return pattern.sub(replacement, raw[:end]) + raw[end:]


from . import invites  # noqa: E402


@dataclass
class Parsed:
    message_id: str = ""
    in_reply_to: str = ""
    references: str = ""
    subject: str = ""
    from_name: str = ""
    from_addr: str = ""
    to: list[dict[str, str]] = field(default_factory=list)
    cc: list[dict[str, str]] = field(default_factory=list)
    sent_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    text: str = ""
    html: str = ""
    # There was HTML, but too much to clean quickly, so only ``text`` is shown.
    html_clipped: bool = False
    snippet: str = ""
    attachments: list[dict[str, Any]] = field(default_factory=list)
    unsubscribe: str = ""
    reply_to: str = ""
    invite: dict[str, Any] | None = None


def _clean_header(value: Any) -> str:
    # A header can't carry a line break into anything built from it.
    return _SPACE.sub(" ", str(value or "")).strip()


def _people(msg: EmailMessage, name: str) -> list[dict[str, str]]:
    return [
        {"name": _clean_header(n)[:320], "addr": a.strip()[:320]}
        for n, a in getaddresses([str(v) for v in msg.get_all(name, [])])
        if a and "@" in a
    ][:200]


def html_to_text(raw: str) -> str:
    cleaned = _drop_with_content(raw, " ")
    cleaned = _sub_tags(_BLOCK_END, "\n", cleaned)
    cleaned = _sub_tags(_ANY_TAG, " ", cleaned)
    text = html.unescape(cleaned)
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t\xa0]+", " ", text)).strip()


def html_fits(raw: str) -> bool:
    """Whether ``safe_html`` can clean this quickly. One pass over the tags, guessing
    on the high side how much work html5lib will do."""
    if len(raw) > MAX_HTML or raw.count("<") + raw.count("&") + raw.count("\x00") > _MAX_MARKS:
        return False
    attr_work = depth_work = width_work = format_work = depth = copied = 0
    # How deep: an end tag closes only its own element here, so nothing html5lib
    # might keep open is let off.
    still_open: dict[str, int] = {}
    # Who holds whom: closing an element closes what's inside it, as html5lib mostly
    # does. Each open element is [name, children, children with children, formatting].
    stack: list[list[Any]] = [["", 0, 0, None]]
    on_stack: dict[str, int] = {}
    # Formatting tags not closed by their own end tag, by tag and attributes, and how
    # many of those are still open. html5lib copies the rest, up to three alike.
    unclosed: dict[tuple[str, str], int] = {}
    held: dict[tuple[str, str], int] = {}
    unclosed_by_name: dict[str, list[tuple[str, str]]] = {}

    def recount(key: tuple[str, str], more_unclosed: int, more_held: int) -> None:
        nonlocal copied
        copied -= max(0, min(3, unclosed.get(key, 0)) - held.get(key, 0))
        unclosed[key] = unclosed.get(key, 0) + more_unclosed
        held[key] = held.get(key, 0) + more_held
        copied += max(0, min(3, unclosed[key]) - held[key])

    def pop() -> int:
        name, children, parents, key = stack.pop()
        on_stack[name] -= 1
        if key:
            recount(key, 0, -1)
        if children:
            stack[-1][2] += 1
        return children * parents

    def close(name: str) -> int:
        work = 0
        while stack[-1][0] != name:
            work += pop()
        return work + pop()

    for tag in _TAG.finditer(raw):
        attrs = len(_ATTR.findall(tag.group(3)))
        attr_work += attrs * attrs
        name = tag.group(2).lower()
        if tag.group(1):
            if on_stack.get(name):
                width_work += close(name)
            if still_open.get(name):
                still_open[name] -= 1
                depth -= 1
            if unclosed_by_name.get(name):
                recount(unclosed_by_name[name].pop(), -1, 0)
        else:
            if name in _PEERS and on_stack.get(name):
                width_work += close(name)
            if name in _CLOSES_P and on_stack.get("p"):
                width_work += close("p")
            stack[-1][1] += 1
            if name not in _VOID:
                key = (name, tag.group(3).strip()) if name in _FORMATTING else None
                stack.append([name, 0, 0, key])
                on_stack[name] = on_stack.get(name, 0) + 1
                if key:
                    unclosed_by_name.setdefault(name, []).append(key)
                    recount(key, 1, 1)
                if not (name in _PEERS and still_open.get(name)):
                    still_open[name] = still_open.get(name, 0) + 1
                    depth += 1
        depth_work += depth
        format_work += copied
        if attr_work > _MAX_ATTR_WORK or depth_work > _MAX_DEPTH_WORK or width_work > _MAX_WIDTH_WORK or format_work > _MAX_FORMAT_WORK:
            return False
    while len(stack) > 1:
        width_work += pop()
    return width_work + stack[0][1] * stack[0][2] <= _MAX_WIDTH_WORK


def safe_html(raw: str, inline: dict[str, str] | None = None) -> str:
    """Only harmless tags. A remote image becomes ``data-remote-src``, so loading
    it (and telling the sender you opened this) is your decision."""
    inline = inline or {}

    def image(match: re.Match[str]) -> str:
        whole, source = match.group(0), html.unescape(match.group(2).strip())
        if source.lower().startswith("cid:"):
            data = inline.get(source[4:].strip("<>"))
            return whole.replace(match.group(2), data or "")
        if source.lower().startswith(("http://", "https://")):
            return whole[: match.start(2) - match.start(0) - len("src=") - 1] + f"data-remote-src={match.group(1)}{match.group(2)}{match.group(1)}"
        return whole.replace(match.group(2), "")

    prepared = _sub_img_src(_drop_with_content(raw, ""), image)
    cleaned = bleach.clean(
        prepared,
        tags=_TAGS,
        attributes=_ATTRS,
        protocols=["http", "https", "mailto", "tel", "data"],
        strip=True,
        strip_comments=True,
        css_sanitizer=_CSS,
    )
    # ``data:`` is only for the pictures embedded above, never a link.
    return re.sub(r"""href\s*=\s*(["'])\s*data:.*?\1""", 'href="#"', cleaned, flags=re.IGNORECASE | re.DOTALL)


def _text_of(part: EmailMessage) -> str:
    try:
        return str(part.get_content())
    except (LookupError, ValueError, UnicodeError):
        payload = part.get_payload(decode=True) or b""
        return payload.decode("utf-8", "replace")


def _strip_quoted(text: str) -> str:
    lines = []
    for line in text.splitlines():
        if line.startswith(">") or re.match(r"^On .+ wrote:\s*$", line):
            break
        lines.append(line)
    return "\n".join(lines) or text


def message_id_of(raw_headers: bytes) -> str:
    """Read the same way as ``parse``, so the two can be compared."""
    msg = email.message_from_bytes(raw_headers, policy=policy.default)
    return _clean_header(msg.get("Message-ID"))[:500]


def parse(raw: bytes) -> Parsed:
    msg: EmailMessage = email.message_from_bytes(raw, policy=policy.default)  # type: ignore[assignment]
    out = Parsed()
    out.message_id = _clean_header(msg.get("Message-ID"))[:500]
    out.in_reply_to = _clean_header(msg.get("In-Reply-To"))[:500]
    out.references = _clean_header(msg.get("References"))[:8000]
    out.subject = _clean_header(msg.get("Subject"))[:2000]
    senders = _people(msg, "From")
    if senders:
        out.from_name, out.from_addr = senders[0]["name"], senders[0]["addr"]
    out.to, out.cc = _people(msg, "To"), _people(msg, "Cc")
    out.unsubscribe = _clean_header(msg.get("List-Unsubscribe"))[:1000]
    answer_to = _people(msg, "Reply-To")
    out.reply_to = answer_to[0]["addr"][:320] if answer_to else ""
    try:
        when = parsedate_to_datetime(str(msg.get("Date")))
        out.sent_at = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        pass

    plain, rich = "", ""
    inline: dict[str, str] = {}
    attachments: list[dict[str, Any]] = []
    for index, part in enumerate(msg.walk()):
        if part.is_multipart():
            continue
        kind = part.get_content_type()
        disposition = part.get_content_disposition()
        name = part.get_filename()
        cid = _clean_header(part.get("Content-ID")).strip("<>")
        if kind == "text/plain" and not name and disposition != "attachment" and not plain:
            plain = _text_of(part)
        elif kind == "text/html" and not name and disposition != "attachment" and not rich:
            rich = _text_of(part)
        else:
            payload = part.get_payload(decode=True) or b""
            if kind in ("text/calendar", "application/ics") and out.invite is None:
                out.invite = invites.parse_ics(payload)
                # The invite shows as a card; a stray invite.ics chip would just be noise.
                if out.invite is not None:
                    continue
            if cid and kind.startswith("image/") and kind != "image/svg+xml" and len(payload) <= MAX_INLINE_IMAGE:
                inline[cid] = f"data:{kind};base64,{base64.b64encode(payload).decode()}"
                if disposition != "attachment":
                    continue
            attachments.append({"part": index, "name": _clean_header(name)[:255] or "attachment", "mime": kind[:120], "size": len(payload)})
    out.text = plain or html_to_text(rich)
    if rich and html_fits(rich):
        out.html = safe_html(rich, inline)
    else:
        out.html_clipped = bool(rich)
    out.attachments = attachments[:100]
    out.snippet = _SPACE.sub(" ", _strip_quoted(out.text))[:240].strip()
    return out


def attachment_bytes(raw: bytes, part_index: int) -> tuple[str, str, bytes] | None:
    msg = email.message_from_bytes(raw, policy=policy.default)
    for index, part in enumerate(msg.walk()):
        if index == part_index and not part.is_multipart():
            return _clean_header(part.get_filename()) or "attachment", part.get_content_type(), part.get_payload(decode=True) or b""
    return None


def thread_key(account_id: Any, root: str) -> str:
    return hashlib.sha1(f"{account_id}:{root}".encode()).hexdigest()


def message_ids(*headers: str) -> list[str]:
    return [m for h in headers for m in re.findall(r"<[^<>\s]+>", h)]
