"""Conversation import — parse external chat exports into Promptly rows.

Module naming note: ``import`` is a reserved keyword so we name the
module ``import_`` (trailing underscore, per PEP 8 guidance) and the
router imports it as ``from app.chat import import_ as importer``.

Supported source formats:

* **Promptly JSON** (``{"format": "promptly.conversation"}``) — round-trip
  of our own export. Single-conversation payloads and bulk wrappers
  (``{"format": "promptly.conversations", "conversations": [...]}``).
* **ChatGPT export** — OpenAI's account export ships a
  ``conversations.json`` file that is a *list* of conversation records
  (``[{"title": ..., "mapping": {...}}, ...]``). We parse the mapping
  tree into a linear message list following the ``parent -> children``
  pointers from each root.
* **Claude export** — Anthropic's export is a ZIP with
  ``conversations.json`` (list of chats, each with a flat
  ``chat_messages`` array). We handle either a raw JSON list or an
  object with a ``conversations`` key.
* **Plain Markdown** — anything else falls back to a permissive parser
  that splits on ``## User`` / ``## Assistant`` headings. Used for
  hand-crafted exports and for re-importing the human-readable
  Markdown Promptly itself produces.

Bulk uploads are the common case (a ChatGPT export can contain
hundreds of chats) so every parser returns a list of
:class:`ParsedConversation` records, even when the input only has
one. The router converts them to DB rows in a single transaction.

We deliberately avoid doing *anything* expensive in the parser layer
— no DB hits, no LLM calls, no downloads. The only side effect is
raising :class:`ImportError` on malformed input.
"""
from __future__ import annotations

import json
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Iterable


# ---------------------------------------------------------------------
# Typed result records — kept lean; the router layers ORM rows on top
# ---------------------------------------------------------------------


@dataclass
class ParsedMessage:
    """One message ready to be written to the DB.

    Attachments + sources are kept as raw JSON blobs — we don't try
    to re-resolve attachment ids against the ``user_files`` table on
    import, because the source export was made on a different install.
    The caller can either strip them (current default) or preserve
    them for manual reattachment later."""

    role: str
    content: str
    created_at: datetime | None = None
    sources: list[Any] | None = None
    attachments: list[Any] | None = None


@dataclass
class ParsedConversation:
    title: str | None
    messages: list[ParsedMessage] = field(default_factory=list)
    # Carry the *original* source label so the importer can tag
    # each row (and the client can surface it in the "what you just
    # imported" summary toast).
    source_format: str = "unknown"
    # Optional original created-at of the whole thread — used as the
    # ``created_at`` of the DB row when provided. Falls back to
    # ``now()`` otherwise.
    created_at: datetime | None = None


class ImportError(Exception):
    """Raised by the parsers on malformed / unrecognised input.

    Separate from the stdlib ``ImportError`` on purpose so a stray
    ``from app.chat.import_ import ImportError`` call site won't
    accidentally catch Python's own import-machinery failures."""


# ---------------------------------------------------------------------
# Entry points — auto-detect + dispatch
# ---------------------------------------------------------------------


def parse_upload(
    *, filename: str, content_type: str | None, data: bytes
) -> list[ParsedConversation]:
    """Route an uploaded file to the right parser.

    Strategy:
    1. If the payload is a ZIP, inspect the archive and look for a
       ``conversations.json`` (Claude / ChatGPT bundles).
    2. Otherwise, decode as UTF-8 and try JSON first — our native
       Promptly export, ChatGPT single-file export, and Claude raw
       JSON all shake out from the top-level keys.
    3. Fall back to the plain-Markdown parser.

    ``filename`` and ``content_type`` are hints only; the actual
    dispatch goes by sniffing the bytes so a wrong extension doesn't
    short-circuit a valid import.
    """
    lower = (filename or "").lower()

    # ---- ZIP handling ----
    if _looks_like_zip(data):
        return _parse_zip(data)

    # ---- Text path ----
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ImportError(
            "Couldn't decode the uploaded file as UTF-8 text."
        ) from exc

    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            # Don't give up yet — it might be *almost* JSON but really
            # a Markdown file that starts with ``{``. Only treat the
            # error as fatal if the file claims JSON by extension.
            if lower.endswith(".json"):
                raise ImportError(f"Invalid JSON: {exc.msg}") from exc
        else:
            return _dispatch_json(obj)

    # ---- Plain markdown ----
    return [_parse_markdown_transcript(text)]


# ---------------------------------------------------------------------
# ZIP archives (ChatGPT export, Claude export)
# ---------------------------------------------------------------------


def _looks_like_zip(data: bytes) -> bool:
    # "PK\x03\x04" (regular) and "PK\x05\x06" (empty archive sentinel).
    return len(data) >= 4 and data[:2] == b"PK" and data[2] in (3, 5, 7)


def _parse_zip(data: bytes) -> list[ParsedConversation]:
    try:
        zf = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ImportError("The uploaded file isn't a valid ZIP archive.") from exc

    # Look for the canonical ``conversations.json`` first — covers
    # both ChatGPT and Claude layouts. Fall back to the first .json
    # in the archive if nothing named that.
    candidates: list[str] = []
    for name in zf.namelist():
        base = name.rsplit("/", 1)[-1].lower()
        if base == "conversations.json":
            candidates.insert(0, name)  # prioritise
        elif base.endswith(".json"):
            candidates.append(name)

    if not candidates:
        raise ImportError(
            "ZIP archive didn't contain a conversations.json file."
        )

    with zf.open(candidates[0]) as fp:
        try:
            obj = json.load(fp)
        except json.JSONDecodeError as exc:
            raise ImportError(f"conversations.json is invalid: {exc.msg}") from exc

    return _dispatch_json(obj)


# ---------------------------------------------------------------------
# JSON dispatch — detect which tool produced the file
# ---------------------------------------------------------------------


def _dispatch_json(obj: Any) -> list[ParsedConversation]:
    # Promptly native shapes.
    if isinstance(obj, dict) and obj.get("format") == "promptly.conversation":
        return [_parse_promptly_conversation(obj)]
    if isinstance(obj, dict) and obj.get("format") == "promptly.conversations":
        convs = obj.get("conversations") or []
        if not isinstance(convs, list):
            raise ImportError(
                "Promptly bulk export is missing the 'conversations' array."
            )
        return [_parse_promptly_conversation(c) for c in convs]

    # ChatGPT: top-level list of {title, mapping}.
    if isinstance(obj, list):
        if obj and isinstance(obj[0], dict) and "mapping" in obj[0]:
            return [
                _parse_chatgpt_conversation(item)
                for item in obj
                if isinstance(item, dict)
            ]
        # Claude sometimes exports a flat list of chats with ``chat_messages``.
        if obj and isinstance(obj[0], dict) and "chat_messages" in obj[0]:
            return [
                _parse_claude_conversation(item)
                for item in obj
                if isinstance(item, dict)
            ]
        # Otherwise assume it's a list of Promptly conversation payloads.
        out: list[ParsedConversation] = []
        for item in obj:
            if not isinstance(item, dict):
                continue
            if item.get("format") == "promptly.conversation":
                out.append(_parse_promptly_conversation(item))
            elif "chat_messages" in item:
                out.append(_parse_claude_conversation(item))
            elif "mapping" in item:
                out.append(_parse_chatgpt_conversation(item))
        if out:
            return out

    # Claude object wrapper: {"conversations": [...]}.
    if isinstance(obj, dict) and "conversations" in obj and isinstance(
        obj["conversations"], list
    ):
        items = obj["conversations"]
        if items and isinstance(items[0], dict) and "chat_messages" in items[0]:
            return [
                _parse_claude_conversation(it)
                for it in items
                if isinstance(it, dict)
            ]
        if items and isinstance(items[0], dict) and "mapping" in items[0]:
            return [
                _parse_chatgpt_conversation(it)
                for it in items
                if isinstance(it, dict)
            ]

    raise ImportError(
        "Couldn't recognise the JSON structure. "
        "Supported sources: Promptly export, ChatGPT export (conversations.json), "
        "Claude export (conversations.json)."
    )


# ---------------------------------------------------------------------
# Promptly native parser (round-trip with ``export.py``)
# ---------------------------------------------------------------------


def _parse_iso(value: Any) -> datetime | None:
    """Tolerant ISO-8601 parser. Accepts ``Z`` or ``+00:00`` suffixes;
    returns ``None`` for anything we can't confidently parse rather
    than raising — import jobs should never die over a single bad
    timestamp, the message body is what actually matters."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _parse_promptly_conversation(obj: dict[str, Any]) -> ParsedConversation:
    conv = obj.get("conversation") or {}
    messages_in = obj.get("messages") or []
    if not isinstance(messages_in, list):
        raise ImportError("Promptly export is missing a valid 'messages' list.")

    msgs: list[ParsedMessage] = []
    for m in messages_in:
        if not isinstance(m, dict):
            continue
        role = (m.get("role") or "").strip().lower()
        if role not in ("user", "assistant", "system"):
            continue
        content = m.get("content") or ""
        if not isinstance(content, str):
            continue
        msgs.append(
            ParsedMessage(
                role=role,
                content=content,
                created_at=_parse_iso(m.get("created_at")),
                sources=m.get("sources") if isinstance(m.get("sources"), list) else None,
                attachments=(
                    m.get("attachments")
                    if isinstance(m.get("attachments"), list)
                    else None
                ),
            )
        )

    return ParsedConversation(
        title=(conv.get("title") if isinstance(conv, dict) else None) or None,
        messages=msgs,
        source_format="promptly",
        created_at=_parse_iso(
            conv.get("created_at") if isinstance(conv, dict) else None
        ),
    )


# ---------------------------------------------------------------------
# ChatGPT export parser
# ---------------------------------------------------------------------


def _parse_chatgpt_conversation(obj: dict[str, Any]) -> ParsedConversation:
    """Walk ChatGPT's ``mapping`` tree from the root into a linear
    turn-by-turn list.

    The mapping is a dict ``{node_id -> {message, parent, children}}``
    describing a tree (ChatGPT supports regeneration branches). We
    take the *first* child at each branch — that matches "what the
    user saw last" well enough for an import; preserving every branch
    would require projectised alt-takes on the message model which
    we don't have.
    """
    title = obj.get("title") or None
    mapping = obj.get("mapping") or {}
    if not isinstance(mapping, dict):
        raise ImportError("ChatGPT export node had a malformed 'mapping' field.")

    # Root = node whose parent is None.
    root_id: str | None = None
    for nid, node in mapping.items():
        if not isinstance(node, dict):
            continue
        if node.get("parent") is None:
            root_id = nid
            break
    if root_id is None:
        # Some exports use a fixed sentinel key. Fall back to any key.
        root_id = next(iter(mapping.keys()), None)
    if root_id is None:
        return ParsedConversation(
            title=title, source_format="chatgpt", messages=[]
        )

    msgs: list[ParsedMessage] = []
    node_id: str | None = root_id
    # Cap iteration to a very generous 10k nodes as a runaway-graph
    # safety net — real ChatGPT threads top out at a few hundred.
    for _ in range(10_000):
        if node_id is None:
            break
        node = mapping.get(node_id)
        if not isinstance(node, dict):
            break
        msg = node.get("message")
        if isinstance(msg, dict):
            parsed = _chatgpt_message(msg)
            if parsed is not None:
                msgs.append(parsed)
        children = node.get("children") or []
        node_id = children[0] if isinstance(children, list) and children else None

    return ParsedConversation(
        title=title,
        messages=msgs,
        source_format="chatgpt",
        created_at=_chatgpt_root_created_at(obj),
    )


def _chatgpt_root_created_at(obj: dict[str, Any]) -> datetime | None:
    val = obj.get("create_time")
    if isinstance(val, (int, float)):
        try:
            return datetime.fromtimestamp(val, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    return None


def _chatgpt_message(msg: dict[str, Any]) -> ParsedMessage | None:
    author = msg.get("author") or {}
    role = (author.get("role") if isinstance(author, dict) else None) or ""
    role = role.strip().lower()
    if role not in ("user", "assistant", "system"):
        # Tool / function rows are ignored — we don't have a place
        # to put them and a Promptly tool-call snapshot wouldn't be
        # meaningful without the original tool registry.
        return None

    content = msg.get("content") or {}
    text = _chatgpt_extract_text(content)
    if not text.strip() and role == "system":
        # Hidden system seeds clutter the import without adding value.
        return None

    ts = msg.get("create_time")
    created_at: datetime | None = None
    if isinstance(ts, (int, float)):
        try:
            created_at = datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            created_at = None

    return ParsedMessage(role=role, content=text, created_at=created_at)


def _chatgpt_extract_text(content: Any) -> str:
    """Pluck the displayable text out of a ChatGPT ``content`` blob.

    Known shapes::

        {"content_type": "text", "parts": ["..."]}
        {"content_type": "multimodal_text", "parts": [{"text": "..."}, ...]}
        {"content_type": "code", "text": "..."}
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, dict):
        return ""
    if "parts" in content and isinstance(content["parts"], list):
        out: list[str] = []
        for p in content["parts"]:
            if isinstance(p, str):
                out.append(p)
            elif isinstance(p, dict):
                # Multimodal: prefer inline text, otherwise a placeholder.
                if isinstance(p.get("text"), str):
                    out.append(p["text"])
                elif p.get("content_type") == "image_asset_pointer":
                    out.append("[image attachment]")
        return "\n\n".join(s for s in out if s)
    if "text" in content and isinstance(content["text"], str):
        return content["text"]
    return ""


# ---------------------------------------------------------------------
# Claude export parser
# ---------------------------------------------------------------------


def _parse_claude_conversation(obj: dict[str, Any]) -> ParsedConversation:
    title = obj.get("name") or obj.get("title") or None
    messages = obj.get("chat_messages") or obj.get("messages") or []
    if not isinstance(messages, list):
        return ParsedConversation(
            title=title, source_format="claude", messages=[]
        )

    msgs: list[ParsedMessage] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = (m.get("sender") or m.get("role") or "").strip().lower()
        # Claude uses "human"/"assistant"; normalise to our "user".
        if role == "human":
            role = "user"
        if role not in ("user", "assistant", "system"):
            continue

        text = _claude_extract_text(m)
        if not text:
            continue
        msgs.append(
            ParsedMessage(
                role=role,
                content=text,
                created_at=_parse_iso(m.get("created_at") or m.get("timestamp")),
            )
        )

    return ParsedConversation(
        title=title,
        messages=msgs,
        source_format="claude",
        created_at=_parse_iso(obj.get("created_at")),
    )


def _claude_extract_text(msg: dict[str, Any]) -> str:
    # Newer Claude exports: ``content`` is a list of content blocks.
    content = msg.get("content")
    if isinstance(content, list):
        out: list[str] = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                out.append(block["text"])
        if out:
            return "\n\n".join(out)
    # Older / simpler: ``text`` field.
    if isinstance(msg.get("text"), str):
        return msg["text"]
    if isinstance(content, str):
        return content
    return ""


# ---------------------------------------------------------------------
# Plain Markdown parser (fallback + Promptly's own Markdown export)
# ---------------------------------------------------------------------


_HEADING_RE = re.compile(
    r"^##\s+(User|Assistant|System)\s*$", re.IGNORECASE | re.MULTILINE
)


def _parse_markdown_transcript(text: str) -> ParsedConversation:
    """Split a Markdown transcript on ``## User`` / ``## Assistant``
    headings. Very permissive — we don't require the Promptly-style
    preamble or the ``---`` separators. Anything before the first
    heading becomes a "system" message so notes / preambles aren't
    silently dropped."""
    # Optional top-level title: first ``# Foo`` line in the file.
    title: str | None = None
    first_line = (text.splitlines() or [""])[0].strip()
    if first_line.startswith("# "):
        title = first_line[2:].strip() or None

    matches = list(_HEADING_RE.finditer(text))
    msgs: list[ParsedMessage] = []
    if not matches:
        # Whole document becomes one assistant message — fallback
        # behaviour that at least preserves the content.
        body = text.strip()
        if body:
            msgs.append(ParsedMessage(role="assistant", content=body))
        return ParsedConversation(
            title=title, messages=msgs, source_format="markdown"
        )

    # Preamble content (before first heading).
    first_start = matches[0].start()
    preamble = text[:first_start].strip()
    # Skip the title line from the preamble when computing extra
    # context — otherwise the title doubles up inside a system msg.
    if title:
        preamble = re.sub(r"^#\s+.*\n?", "", preamble, count=1).strip()
    # Remove common ``> Exported from Promptly ...`` metadata block
    # so re-imported Promptly Markdown doesn't tack the metadata on
    # as a system message.
    preamble = re.sub(
        r"(?:^>\s?.*\n?)+", "", preamble, flags=re.MULTILINE
    ).strip()
    # Any stray `---` separators in the preamble are noise.
    preamble = preamble.replace("---", "").strip()
    if preamble:
        msgs.append(ParsedMessage(role="system", content=preamble))

    for i, m in enumerate(matches):
        role = m.group(1).lower()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end]
        # Strip Promptly's ``---`` separators and attachment chip line
        # but keep everything else verbatim.
        chunk = re.sub(r"^---\s*$", "", chunk, flags=re.MULTILINE)
        chunk = re.sub(
            r"^\*\*Attachments:\*\*.*$", "", chunk, flags=re.MULTILINE
        )
        content = chunk.strip()
        if not content:
            continue
        msgs.append(ParsedMessage(role=role, content=content))

    return ParsedConversation(
        title=title, messages=msgs, source_format="markdown"
    )


# ---------------------------------------------------------------------
# Utility for the router: generate a tolerant title if none provided.
# ---------------------------------------------------------------------


def synthesise_title(parsed: ParsedConversation) -> str:
    """Best-effort title fallback when the source didn't have one.

    Picks the first non-trivial line of the first user message,
    trimmed to ~80 chars. Keeps imports looking like real chats
    rather than rows of "Untitled"."""
    if parsed.title and parsed.title.strip():
        return parsed.title.strip()[:255]
    for m in parsed.messages:
        if m.role != "user":
            continue
        snippet = (m.content or "").strip().splitlines()
        snippet = [ln for ln in snippet if ln.strip()]
        if snippet:
            head = snippet[0].strip()
            if len(head) > 80:
                head = head[:77].rstrip() + "..."
            return head[:255]
    return "Imported conversation"


# Re-export the public surface for easy star-import in the router.
__all__ = [
    "ParsedConversation",
    "ParsedMessage",
    "ImportError",
    "parse_upload",
    "synthesise_title",
]


# ---------------------------------------------------------------------
# Small iter-helper — only used in tests but handy to ship alongside.
# ---------------------------------------------------------------------


def iter_messages(conversations: Iterable[ParsedConversation]) -> Iterable[ParsedMessage]:
    for c in conversations:
        yield from c.messages


# Ensure the unused-import linter doesn't trip on ``uuid`` — imported
# above so test harnesses can generate message ids off it if needed,
# and keeping the symbol available on the module makes the imports
# path symmetrical with ``export.py``.
_ = uuid
