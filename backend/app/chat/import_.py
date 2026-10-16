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
  tree into a linear message list: the branch the user kept, from
  ``current_node`` back to the root.
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
    # Tree position in the source (Promptly JSON v2 keeps regenerations and
    # edits as siblings, R-307). None = chain linearly after the previous.
    source_id: str | None = None
    parent_source_id: str | None = None
    model_id: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[Any] | None = None


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
    # The visible branch's last message (a ``source_id``) when the source
    # kept a tree.
    active_leaf_source_id: str | None = None
    # Stable id of the chat in its source ("chatgpt:<id>", …), so a retried
    # import skips what already came in instead of duplicating it (R-309).
    source_key: str | None = None


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


# Uncompressed-size budget for the conversations file inside an archive.
# A 61 KB zip expanded to 63 MB in testing, so a 100 MB upload could
# inflate past the container's memory (R-308). A heavy ChatGPT account's
# conversations.json is well under this.
MAX_ZIP_MEMBER_BYTES = 400 * 1024 * 1024


def _parse_zip(data: bytes) -> list[ParsedConversation]:
    try:
        zf = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ImportError("The uploaded file isn't a valid ZIP archive.") from exc

    names = zf.namelist()
    bases = {n.rsplit("/", 1)[-1].lower() for n in names}
    if "manifest.json" in bases and any(n.startswith(("chats/", "notes/")) for n in names):
        # A Promptly *workspace* export: readable transcripts, not a chat
        # archive (R-327).
        raise ImportError(
            "This is a Promptly workspace export. It's a readable copy of the "
            "workspace, not a chat archive — export chats as JSON to move them."
        )

    # Look for the canonical ``conversations.json`` first — covers
    # both ChatGPT and Claude layouts. Fall back to the first .json
    # in the archive if nothing named that.
    candidates: list[str] = []
    for name in names:
        base = name.rsplit("/", 1)[-1].lower()
        if base == "conversations.json":
            candidates.insert(0, name)  # prioritise
        elif base.endswith(".json") and base != "manifest.json":
            candidates.append(name)

    if not candidates:
        raise ImportError(
            "ZIP archive didn't contain a conversations.json file."
        )

    info = zf.getinfo(candidates[0])
    if info.file_size > MAX_ZIP_MEMBER_BYTES:
        raise ImportError(
            f"{info.filename} is too large to import "
            f"({info.file_size // (1024 * 1024)} MB uncompressed; "
            f"max {MAX_ZIP_MEMBER_BYTES // (1024 * 1024)} MB)."
        )
    with zf.open(info) as fp:
        # Read through a bound — the declared size can lie.
        raw = fp.read(MAX_ZIP_MEMBER_BYTES + 1)
    if len(raw) > MAX_ZIP_MEMBER_BYTES:
        raise ImportError(f"{info.filename} is too large to import.")
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ImportError(f"{info.filename} is invalid JSON.") from exc
    del raw

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
    if not isinstance(conv, dict):
        conv = {}
    messages_in = obj.get("messages") or []
    if not isinstance(messages_in, list):
        raise ImportError("Promptly export is missing a valid 'messages' list.")

    def _str(v: Any) -> str | None:
        return v if isinstance(v, str) and v else None

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
                # v2 exports carry the tree; v1 files have no parent_id
                # and import as a straight line, as before.
                source_id=_str(m.get("id")) if "parent_id" in m else None,
                parent_source_id=_str(m.get("parent_id")),
                model_id=_str(m.get("model_id")),
                reasoning_content=_str(m.get("reasoning_content")),
                tool_calls=m.get("tool_calls") if isinstance(m.get("tool_calls"), list) else None,
            )
        )

    conv_id = _str(conv.get("id"))
    return ParsedConversation(
        title=conv.get("title") or None,
        messages=msgs,
        source_format="promptly",
        created_at=_parse_iso(conv.get("created_at")),
        active_leaf_source_id=_str(conv.get("active_leaf_message_id")),
        source_key=f"promptly:{conv_id}" if conv_id else None,
    )


# ---------------------------------------------------------------------
# ChatGPT export parser
# ---------------------------------------------------------------------


def _parse_chatgpt_conversation(obj: dict[str, Any]) -> ParsedConversation:
    """Walk ChatGPT's ``mapping`` tree into a linear turn-by-turn list.

    The mapping is a dict ``{node_id -> {message, parent, children}}``
    describing a tree: a regeneration or an edited prompt is a later
    *child*. We follow the branch the user kept — from ``current_node`` (the
    active leaf) up the parent pointers — and fall back to the *last* child
    at each fork when it's missing. Taking the first child imported the
    drafts the user had rejected and dropped everything after (R-306).
    """
    title = obj.get("title") or None
    mapping = obj.get("mapping") or {}
    if not isinstance(mapping, dict):
        raise ImportError("ChatGPT export node had a malformed 'mapping' field.")
    conv_id = obj.get("conversation_id") or obj.get("id")
    source_key = f"chatgpt:{conv_id}" if isinstance(conv_id, str) and conv_id else None

    leaf = obj.get("current_node")
    if not (isinstance(leaf, str) and isinstance(mapping.get(leaf), dict)):
        leaf = _chatgpt_last_leaf(mapping)
    if leaf is None:
        return ParsedConversation(
            title=title, source_format="chatgpt", messages=[], source_key=source_key
        )

    # Leaf → root, then reverse. Capped and cycle-guarded against a
    # malformed graph — real threads are a few hundred nodes.
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    node_id: Any = leaf
    while isinstance(node_id, str) and node_id not in seen and len(chain) < 10_000:
        seen.add(node_id)
        node = mapping.get(node_id)
        if not isinstance(node, dict):
            break
        chain.append(node)
        node_id = node.get("parent")
    chain.reverse()

    msgs: list[ParsedMessage] = []
    for node in chain:
        msg = node.get("message")
        if isinstance(msg, dict):
            parsed = _chatgpt_message(msg)
            if parsed is not None:
                msgs.append(parsed)

    return ParsedConversation(
        title=title,
        messages=msgs,
        source_format="chatgpt",
        created_at=_chatgpt_root_created_at(obj),
        source_key=source_key,
    )


def _chatgpt_last_leaf(mapping: dict[str, Any]) -> str | None:
    """No ``current_node``: from the root, take the newest child at each fork."""
    root_id: str | None = None
    for nid, node in mapping.items():
        if isinstance(node, dict) and node.get("parent") is None:
            root_id = nid
            break
    if root_id is None:
        root_id = next(iter(mapping.keys()), None)
    node_id = root_id
    seen: set[str] = set()
    while isinstance(node_id, str) and node_id not in seen:
        seen.add(node_id)
        node = mapping.get(node_id)
        children = node.get("children") if isinstance(node, dict) else None
        if not (isinstance(children, list) and children):
            return node_id
        node_id = children[-1]
    return node_id if isinstance(node_id, str) else None


def _chatgpt_root_created_at(obj: dict[str, Any]) -> datetime | None:
    val = obj.get("create_time")
    if isinstance(val, (int, float)):
        try:
            return datetime.fromtimestamp(val, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    return None


# Rows that aren't part of the visible conversation: reasoning, custom
# instructions, tool output and browsing display (R-313). They imported as
# blank bubbles or stray tool-call code.
_CHATGPT_HIDDEN_TYPES = frozenset(
    {
        "thoughts",
        "reasoning_recap",
        "user_editable_context",
        "model_editable_context",
        "execution_output",
        "tether_browsing_display",
        "tether_quote",
        "system_error",
        "sonic_webpage",
    }
)

# ChatGPT marks citations with private-use characters:
# "\ue200cite\ue202turn0search3\ue201". They rendered as odd glyphs.
_CHATGPT_CITE_RE = re.compile("\ue200[^\ue201]*\ue201")
_CHATGPT_PUA_RE = re.compile("[\ue200-\ue2ff]")


def _chatgpt_message(msg: dict[str, Any]) -> ParsedMessage | None:
    author = msg.get("author") or {}
    role = (author.get("role") if isinstance(author, dict) else None) or ""
    role = role.strip().lower()
    if role not in ("user", "assistant", "system"):
        # Tool / function rows are ignored — we don't have a place
        # to put them and a Promptly tool-call snapshot wouldn't be
        # meaningful without the original tool registry.
        return None
    meta = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}
    if meta.get("is_visually_hidden_from_conversation"):
        return None
    recipient = msg.get("recipient")
    if isinstance(recipient, str) and recipient not in ("all", ""):
        # Addressed to a tool (browsing, python, …): a tool call, not a reply.
        return None

    content = msg.get("content") or {}
    if isinstance(content, dict) and content.get("content_type") in _CHATGPT_HIDDEN_TYPES:
        return None
    text = _chatgpt_extract_text(content)
    text = _CHATGPT_PUA_RE.sub("", _CHATGPT_CITE_RE.sub("", text))
    if not text.strip():
        # Nothing to show — a blank bubble, and a blank row sent to the
        # model if the chat is continued.
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
    conv_id = obj.get("uuid") or obj.get("id")
    source_key = f"claude:{conv_id}" if isinstance(conv_id, str) and conv_id else None
    messages = obj.get("chat_messages") or obj.get("messages") or []
    if not isinstance(messages, list):
        return ParsedConversation(
            title=title, source_format="claude", messages=[], source_key=source_key
        )
    messages = _claude_active_branch([m for m in messages if isinstance(m, dict)])

    msgs: list[ParsedMessage] = []
    for m in messages:
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
        source_key=source_key,
    )


def _claude_active_branch(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Retried and edited turns carry ``parent_message_uuid``: follow the
    last message's parents back so abandoned branches stay out. Exports
    without the pointers stay linear."""
    by_id = {m.get("uuid"): m for m in messages if isinstance(m.get("uuid"), str)}
    if not messages or len(by_id) != len(messages):
        return messages
    if not any(isinstance(m.get("parent_message_uuid"), str) for m in messages):
        return messages
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    cur: dict[str, Any] | None = messages[-1]
    while cur is not None and cur["uuid"] not in seen:
        seen.add(cur["uuid"])
        chain.append(cur)
        cur = by_id.get(cur.get("parent_message_uuid"))
    chain.reverse()
    return chain


def _fence(body: str, lang: str = "") -> str:
    """A code fence longer than any backtick run inside ``body``."""
    longest = max((len(r) for r in re.findall(r"`+", body)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}{lang}\n{body.rstrip()}\n{ticks}"


def _claude_extract_text(msg: dict[str, Any]) -> str:
    """The message text plus what Claude exports keep beside it: pasted or
    uploaded document text (``attachments[].extracted_content``), file
    names, and artifacts (``tool_use`` blocks) — the replies refer to them,
    so they used to read as nonsense without them (R-330)."""
    parts: list[str] = []
    content = msg.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if isinstance(block.get("text"), str) and block.get("type") in (None, "text"):
                parts.append(block["text"])
            elif block.get("type") == "tool_use":
                inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                body = inp.get("content")
                if isinstance(body, str) and body.strip():
                    label = inp.get("title") or block.get("name") or "Artifact"
                    lang = inp.get("language") if isinstance(inp.get("language"), str) else ""
                    parts.append(f"**{label}**\n\n{_fence(body, lang)}")
    if not parts:
        # Older / simpler: ``text`` field.
        if isinstance(msg.get("text"), str) and msg["text"].strip():
            parts.append(msg["text"])
        elif isinstance(content, str) and content.strip():
            parts.append(content)
    for att in msg.get("attachments") or []:
        if not isinstance(att, dict):
            continue
        name = att.get("file_name") or "Attachment"
        extracted = att.get("extracted_content")
        if isinstance(extracted, str) and extracted.strip():
            parts.append(f"**{name}**\n\n{_fence(extracted)}")
        else:
            parts.append(f"[attachment: {name}]")
    for f in msg.get("files") or []:
        if isinstance(f, dict) and f.get("file_name"):
            parts.append(f"[file: {f['file_name']}]")
    return "\n\n".join(p for p in parts if p and p.strip())


# ---------------------------------------------------------------------
# Plain Markdown parser (fallback + Promptly's own Markdown export)
# ---------------------------------------------------------------------


_HEADING_RE = re.compile(r"^##\s+(User|Assistant|System)\s*$", re.IGNORECASE)
# Promptly's own Markdown export marks each message (R-325) so the split
# never depends on a heading that could also appear in a message.
_MARKER_RE = re.compile(r"^<!--\s*promptly:message\s+role=(user|assistant|system)\s*-->\s*$", re.IGNORECASE)
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_SOURCES_RE = re.compile(r"\n\*\*Sources:\*\*\s*\n((?:\s*\d+\.\s+.*\n?)+)\s*$")
_SOURCE_LINE_RE = re.compile(r"^\s*\d+\.\s+(?:\[(.*)\]\((\S+)\)|(.*))\s*$")


def _split_points(lines: list[str]) -> list[tuple[int, str, bool]]:
    """(line index, role, is_marker) for each message start outside code
    fences. Markers win when present — a heading inside a message then
    can't split it."""
    fence: str | None = None
    marks: list[tuple[int, str, bool]] = []
    heads: list[tuple[int, str, bool]] = []
    for idx, line in enumerate(lines):
        f = _FENCE_RE.match(line)
        if f:
            token = f.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        m = _MARKER_RE.match(line)
        if m:
            marks.append((idx, m.group(1).lower(), True))
            continue
        h = _HEADING_RE.match(line)
        if h:
            heads.append((idx, h.group(1).lower(), False))
    return marks or heads


def _take_sources(body: str) -> tuple[str, list[dict[str, str]] | None]:
    """Promptly's exporter appends a numbered **Sources:** list; turn it
    back into ``sources`` instead of leaving it in the text."""
    m = _SOURCES_RE.search("\n" + body)
    if not m:
        return body, None
    out: list[dict[str, str]] = []
    for line in m.group(1).splitlines():
        sm = _SOURCE_LINE_RE.match(line)
        if not sm:
            continue
        if sm.group(2):
            out.append({"title": sm.group(1) or sm.group(2), "url": sm.group(2)})
        elif sm.group(3):
            out.append({"title": sm.group(3).strip()})
    return ("\n" + body)[: m.start()].strip(), out or None


def _parse_markdown_transcript(text: str) -> ParsedConversation:
    """Split a Markdown transcript into messages — on Promptly's message
    markers, else on ``## User`` / ``## Assistant`` headings — never inside
    a code fence, so a chat about Markdown no longer splits mid-answer and
    swaps roles (R-325). Anything before the first message becomes a
    "system" message so notes / preambles aren't silently dropped."""
    import hashlib

    source_key = "markdown:" + hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:40]
    # Optional top-level title: first ``# Foo`` line in the file.
    title: str | None = None
    first_line = (text.splitlines() or [""])[0].strip()
    if first_line.startswith("# "):
        title = first_line[2:].strip() or None

    lines = text.split("\n")
    points = _split_points(lines)
    msgs: list[ParsedMessage] = []
    if not points:
        # Whole document becomes one assistant message — fallback
        # behaviour that at least preserves the content.
        body = text.strip()
        if body:
            msgs.append(ParsedMessage(role="assistant", content=body))
        return ParsedConversation(
            title=title, messages=msgs, source_format="markdown", source_key=source_key
        )

    # Preamble content (before the first message).
    preamble = "\n".join(lines[: points[0][0]]).strip()
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
    preamble = re.sub(r"^---\s*$", "", preamble, flags=re.MULTILINE).strip()
    if preamble:
        msgs.append(ParsedMessage(role="system", content=preamble))

    for n, (idx, role, is_marker) in enumerate(points):
        end = points[n + 1][0] if n + 1 < len(points) else len(lines)
        body_lines = lines[idx + 1 : end]
        if is_marker and body_lines and _HEADING_RE.match(body_lines[0]):
            body_lines = body_lines[1:]  # the heading under the marker
        # Promptly's separator between messages: only the trailing one.
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        if body_lines and body_lines[-1].strip() == "---":
            body_lines.pop()
        body = "\n".join(body_lines)
        # The attachment chip line is the exporter's; the files themselves
        # don't travel.
        body = re.sub(r"^\*\*Attachments:\*\*.*$", "", body, flags=re.MULTILINE)
        body, sources = _take_sources(body.strip())
        content = body.strip()
        if not content:
            continue
        msgs.append(ParsedMessage(role=role, content=content, sources=sources))

    return ParsedConversation(
        title=title, messages=msgs, source_format="markdown", source_key=source_key
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
