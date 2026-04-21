"""Conversation export — render a persisted chat to Markdown / JSON / PDF.

Lives in its own module (rather than the already-very-long ``router.py``)
because the interesting work isn't HTTP — it's serialisation. Three
surface-level formats the router wires up to::

    fmt = "markdown"  -> UTF-8 text/markdown, human-readable transcript
    fmt = "json"      -> application/json, Promptly's native schema (the
                         same shape the import endpoint will accept in
                         round-trip mode)
    fmt = "pdf"       -> application/pdf, the Markdown transcript piped
                         through the existing ``render_markdown_to_pdf``
                         pipeline used by the PDF-authoring tool

Each renderer takes a :class:`Conversation` plus its ordered
:class:`Message` list (already loaded by the router via the shared
access-check helper) so the DB plumbing stays in the router and the
renderers stay easy to unit-test.

Author + collaborator metadata is intentionally *omitted* from the
Markdown transcript (it'd add noise to a solo-chat export) and
*included* in the JSON payload (needed for round-trip fidelity and
for archival value). This mirrors the UX decision we made for
printed PDFs in the share-view.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from app.chat.models import Conversation, Message


# ---------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------

EXPORT_SCHEMA_VERSION = 1
"""Bumped whenever the JSON payload shape changes in a
   backward-incompatible way. The import endpoint uses it to pick a
   parser; older exports keep working because we only ever add fields
   in minor revisions of the same major version."""


def _iso(dt: datetime | None) -> str | None:
    """Timezone-aware ISO-8601 with ``Z`` suffix for UTC.

    ``datetime.isoformat`` alone produces ``+00:00``, which is valid
    ISO but historically inconsistent with the rest of our API
    payloads. Normalising here keeps Promptly JSON exports
    self-consistent regardless of what the DB driver returned."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _role_label(role: str) -> str:
    """Human-readable role heading for the Markdown transcript.

    ``assistant`` becomes ``Assistant``, ``user`` → ``User``, etc.
    Kept trivial because any future personalisation (e.g. the
    collaborator's display name in a shared chat) would push this
    into the author-chip territory we explicitly skip for solo
    exports."""
    return role.capitalize() if role else "Unknown"


# ---------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------


def render_conversation_markdown(
    conv: Conversation, messages: list[Message]
) -> str:
    """Render a chat to a Markdown transcript.

    Format (stable, meant for humans and for re-importable round-trip
    with the ``plain-markdown`` parser)::

        # <Title>

        > Exported from Promptly on <date>
        > <N> messages · model: <display>

        ---

        ## User

        <content>

        ## Assistant

        <content>

    Attachments produce a compact chip line below the message so the
    export is still useful when the original files are long gone. We
    deliberately don't inline image data — that'd balloon the file
    size and Markdown renderers outside Promptly won't know how to
    display our blob ids anyway.
    """
    title = conv.title.strip() if conv.title else "Untitled conversation"
    lines: list[str] = [f"# {title}", ""]

    meta_parts: list[str] = []
    meta_parts.append(f"Exported from Promptly on {_iso(datetime.now(timezone.utc))}")
    meta_parts.append(f"{len(messages)} message{'s' if len(messages) != 1 else ''}")
    if conv.model_id:
        meta_parts.append(f"model: `{conv.model_id}`")
    for m in meta_parts:
        lines.append(f"> {m}")
    lines.append("")
    lines.append("---")
    lines.append("")

    for msg in messages:
        if msg.role == "system":
            # System rows are implementation detail — skip from the
            # human-readable transcript to avoid exposing internal
            # personal-context / tool preambles. They're still in the
            # JSON export for fidelity.
            continue
        lines.append(f"## {_role_label(msg.role)}")
        lines.append("")
        body = (msg.content or "").rstrip()
        if body:
            lines.append(body)
            lines.append("")
        if msg.attachments:
            chips = []
            for a in msg.attachments:
                name = (a or {}).get("filename", "(attachment)")
                mime = (a or {}).get("mime_type", "application/octet-stream")
                chips.append(f"`{name}` ({mime})")
            if chips:
                lines.append("**Attachments:** " + ", ".join(chips))
                lines.append("")
        if msg.sources:
            lines.append("**Sources:**")
            lines.append("")
            for idx, src in enumerate(msg.sources, start=1):
                s = src if isinstance(src, dict) else {}
                url = s.get("url") or ""
                title_s = s.get("title") or url or "(untitled)"
                if url:
                    lines.append(f"{idx}. [{title_s}]({url})")
                else:
                    lines.append(f"{idx}. {title_s}")
            lines.append("")
        lines.append("---")
        lines.append("")

    # Drop the trailing separator for a clean EOF.
    while lines and lines[-1] in ("", "---"):
        lines.pop()
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------
# JSON (Promptly's native schema — also the import format for
# round-trips so we can claim "your data is yours")
# ---------------------------------------------------------------------


def render_conversation_json(
    conv: Conversation, messages: list[Message]
) -> dict[str, Any]:
    """Render a chat as Promptly's canonical export JSON.

    Shape (``schema_version`` = 1)::

        {
          "schema_version": 1,
          "format": "promptly.conversation",
          "exported_at": "<iso>",
          "conversation": {
            "id": "<uuid>",
            "title": "...",
            "created_at": "<iso>",
            "updated_at": "<iso>",
            "model_id": "...",
            "provider_id": "<uuid>",
            "web_search_mode": "off" | "auto" | "always",
            "pinned": bool,
            "starred": bool,
            "temporary_mode": null | "auto" | "manual" | "until_close",
            "expires_at": "<iso>" | null
          },
          "messages": [
            {
              "id": "<uuid>",
              "role": "user" | "assistant" | "system",
              "content": "...",
              "created_at": "<iso>",
              "sources": [...] | null,
              "attachments": [...] | null,
              "prompt_tokens": int | null,
              "completion_tokens": int | null,
              "ttft_ms": int | null,
              "total_ms": int | null,
              "cost_usd_micros": int | null
            }
          ]
        }

    The import endpoint (phase 2 of this rollout) will consume this
    verbatim — all extra fields are optional so an older export never
    breaks a newer importer.
    """
    return {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "format": "promptly.conversation",
        "exported_at": _iso(datetime.now(timezone.utc)),
        "conversation": {
            "id": str(conv.id),
            "title": conv.title,
            "created_at": _iso(conv.created_at),
            "updated_at": _iso(conv.updated_at),
            "model_id": conv.model_id,
            "provider_id": str(conv.provider_id) if conv.provider_id else None,
            "web_search_mode": conv.web_search_mode,
            "pinned": bool(getattr(conv, "pinned", False)),
            "starred": bool(getattr(conv, "starred", False)),
            "temporary_mode": getattr(conv, "temporary_mode", None),
            "expires_at": _iso(getattr(conv, "expires_at", None)),
        },
        "messages": [
            {
                "id": str(m.id),
                "role": m.role,
                "content": m.content,
                "created_at": _iso(m.created_at),
                "sources": m.sources,
                "attachments": m.attachments,
                "prompt_tokens": m.prompt_tokens,
                "completion_tokens": m.completion_tokens,
                "ttft_ms": m.ttft_ms,
                "total_ms": m.total_ms,
                "cost_usd_micros": m.cost_usd_micros,
            }
            for m in messages
        ],
    }


def render_conversation_json_bytes(
    conv: Conversation, messages: list[Message]
) -> bytes:
    """UTF-8 JSON bytes with 2-space indent + sorted keys.

    Pretty-printed on purpose — the export is a user-facing archive
    first and an API payload second. ``sort_keys`` makes the output
    deterministic (handy for diffing exports across time)."""
    payload = render_conversation_json(conv, messages)
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, indent=2
    ).encode("utf-8")


# ---------------------------------------------------------------------
# PDF (re-uses the Markdown transcript + existing renderer)
# ---------------------------------------------------------------------


def render_conversation_pdf(
    conv: Conversation, messages: list[Message]
) -> bytes:
    """Render a chat to PDF bytes.

    Implementation note: we feed the *Markdown* transcript through the
    existing ``render_markdown_to_pdf`` pipeline rather than building a
    second HTML template. That way typography, page margins, and code-
    block rendering stay consistent with the PDF-authoring tool the
    assistant itself can invoke — consistency free.

    CPU-bound. The router wraps this in :func:`asyncio.to_thread` so
    the event loop stays responsive on large transcripts.
    """
    from app.chat.pdf_render import render_markdown_to_pdf

    md = render_conversation_markdown(conv, messages)
    title = (
        conv.title.strip() if conv.title and conv.title.strip() else "Conversation"
    )
    return render_markdown_to_pdf(md, title=title)


# ---------------------------------------------------------------------
# Filename + Content-Disposition
# ---------------------------------------------------------------------


_UNSAFE_FILENAME_RE_CHARS = set('<>:"/\\|?*\x00')


def safe_export_filename(conv: Conversation, fmt: str) -> str:
    """Build a filesystem-safe filename for a conversation export.

    Strategy: keep the title if it's non-empty, strip characters that
    Windows / macOS reject in filenames, collapse whitespace, truncate
    to 80 chars (leaving headroom for the extension and a date suffix)
    and fall back to the short id if the cleaned name is empty.

    The extension maps 1:1 with ``fmt``:
        markdown -> .md
        json     -> .json
        pdf      -> .pdf
    """
    ext = {"markdown": "md", "json": "json", "pdf": "pdf"}.get(fmt, fmt)
    title = (conv.title or "").strip()
    cleaned = "".join(c for c in title if c not in _UNSAFE_FILENAME_RE_CHARS)
    cleaned = " ".join(cleaned.split())  # collapse whitespace
    if not cleaned:
        cleaned = f"conversation-{str(conv.id)[:8]}"
    cleaned = cleaned[:80].rstrip(" .")
    date_suffix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"{cleaned} · {date_suffix}.{ext}"
