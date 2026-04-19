"""``generate_pdf`` — author a PDF document from Markdown source.

Phase A2 of the AI-artefacts plan. The assistant calls this when the
user asks for a PDF / report / printable doc. We persist *two* files
as a pair so the source remains editable:

* a ``markdown_source`` row holding the authoritative Markdown (the
  Phase A3 side-panel editor mutates this row directly); and
* a ``rendered_pdf`` row whose ``source_file_id`` points at the
  Markdown source. Editing the source + re-rendering should overwrite
  this row's blob in place (Phase A3 behaviour).

Only the rendered PDF is attached to the assistant message — the
Markdown sidecar stays out of the chat thread but is visible in the
user's ``Generated Files / Files`` folder, which is enough surface for
the Phase A3 editor to find it.

Routing notes:

* Both rows land in ``Generated Files / Files`` (PDFs are documents,
  not media — see ``app.files.system_folders``).
* Storage quotas are enforced *per file*, but we deliberately persist
  the source first so a quota failure on the PDF leaves the source on
  disk for the user to retry against. ``persist_generated_file`` is
  transactional per-call, so partial-pair states are visible — that's
  by design (better than rolling back the source and losing a
  perfectly good Markdown doc).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.generated_kinds import GeneratedKind

logger = logging.getLogger("promptly.tools.generate_pdf")

# Soft caps. The model can hand us anything that fits in its own token
# budget; these protect the renderer from a runaway hallucination and
# bound the PDF size before we even start typesetting. 100k chars of
# Markdown is a comfortably-thick report (~30-40 pages typeset).
_MAX_FILENAME = 100
_MAX_TITLE = 200
_MAX_MARKDOWN_CHARS = 100_000


class GeneratePdfTool(Tool):
    name = "generate_pdf"
    description = (
        "Render a PDF file from Markdown and attach it to your reply. "
        "Call this whenever the user asks for a PDF, report, write-up, "
        "brief, document, memo, summary doc, printable, export, or "
        "anything they want to download / save / print as a file. "
        "Examples that should trigger this tool: 'make me a PDF of...', "
        "'write a report on...', 'turn this into a document', 'export "
        "this conversation as a PDF', 'generate a brief about...', "
        "'save this as a file'. The Markdown source is also saved "
        "alongside (in 'Generated Files / Files') so the user can edit "
        "it later in the side-panel editor and re-render. Supports "
        "headings, bold/italic/strikethrough, ordered + bulleted lists, "
        "GFM tables, fenced code blocks with syntax labels, blockquotes, "
        "and links. Do NOT call this for a chat-style answer the user "
        "just wants to read on screen — only when an actual downloadable "
        "file is the goal."
    )
    # Conversational version for the tool-aware system prompt. Kept
    # short because it appears in a bullet list with the other tools.
    prompt_hint = (
        "Render a downloadable PDF (with editable Markdown source) and "
        "attach it to your reply. Use whenever the user wants a file, "
        "report, document, brief, write-up, or anything printable / "
        "downloadable — never refuse this on the grounds that you "
        "'can't generate files'."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "filename": {
                "type": "string",
                "description": (
                    "Output PDF filename. Must end in .pdf. Pick "
                    "something the user will recognise in their files "
                    f"list. Maximum {_MAX_FILENAME} characters."
                ),
                "maxLength": _MAX_FILENAME,
            },
            "markdown": {
                "type": "string",
                "description": (
                    "The full Markdown source to render. Use standard "
                    "GitHub-flavoured Markdown — headings (#, ##, ...), "
                    "**bold**, *italic*, lists, | tables |, ```fenced "
                    "code```, > block quotes, and [links](url). Keep "
                    f"under {_MAX_MARKDOWN_CHARS:,} characters."
                ),
                "maxLength": _MAX_MARKDOWN_CHARS,
            },
            "title": {
                "type": "string",
                "description": (
                    "Optional document title rendered above the body "
                    "in a larger weight. Omit if the Markdown body "
                    "already starts with a top-level heading the user "
                    f"will read as the title. Maximum {_MAX_TITLE} "
                    "characters."
                ),
                "maxLength": _MAX_TITLE,
            },
        },
        "required": ["filename", "markdown"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        filename = args.get("filename")
        markdown_source = args.get("markdown")
        title = args.get("title")

        # ---- Validate args (mirrors attach_demo's defensive style) ----
        if not isinstance(filename, str) or not filename.strip():
            raise ToolError("`filename` is required and must be a string")
        if not isinstance(markdown_source, str):
            raise ToolError("`markdown` must be a string")
        if title is not None and not isinstance(title, str):
            raise ToolError("`title`, when provided, must be a string")

        filename = filename.strip()
        if not filename.lower().endswith(".pdf"):
            raise ToolError("`filename` must end in .pdf")
        if len(filename) > _MAX_FILENAME:
            raise ToolError(
                f"`filename` exceeds {_MAX_FILENAME}-char limit"
            )
        if len(markdown_source) > _MAX_MARKDOWN_CHARS:
            raise ToolError(
                f"`markdown` exceeds {_MAX_MARKDOWN_CHARS:,}-char limit"
            )
        if not markdown_source.strip():
            raise ToolError("`markdown` is empty — nothing to render")
        if title is not None and len(title) > _MAX_TITLE:
            raise ToolError(f"`title` exceeds {_MAX_TITLE}-char limit")

        # ---- Step 1: persist the Markdown source as a sidecar ----
        # Naming convention: PDF "report.pdf" -> source "report.md".
        # Stripping the .pdf and re-appending .md keeps the pair
        # discoverable by name even if a future column lookup fails.
        md_filename = filename[: -len(".pdf")] + ".md"
        try:
            md_row = await persist_generated_file(
                ctx.db,
                user=ctx.user,
                filename=md_filename,
                mime_type="text/markdown",
                content=markdown_source.encode("utf-8"),
                source_kind=GeneratedKind.MARKDOWN_SOURCE.value,
            )
        except GeneratedFileError as e:
            raise ToolError(f"Couldn't save Markdown source: {e}") from e

        # ---- Step 2: render the PDF (offload to thread, sync API) ----
        try:
            pdf_bytes = await asyncio.to_thread(
                render_markdown_to_pdf, markdown_source, title
            )
        except PdfRenderError as e:
            # Source is already on disk; the user keeps it so they can
            # edit + retry. We just signal the failure to the model.
            logger.info(
                "generate_pdf: render failed user=%s md_id=%s err=%s",
                ctx.user.id,
                md_row.id,
                e,
            )
            raise ToolError(f"PDF rendering failed: {e}") from e
        except Exception as e:  # pragma: no cover — defensive
            # An unexpected typesetting bug shouldn't tear down the
            # stream. Surface the class name only — the message could
            # contain sensitive paths.
            logger.exception(
                "generate_pdf: unexpected render error user=%s",
                ctx.user.id,
            )
            raise ToolError(
                f"PDF renderer crashed ({type(e).__name__}); "
                "try simpler markup."
            ) from e

        # ---- Step 3: persist the PDF, link to its source ----
        try:
            pdf_row = await persist_generated_file(
                ctx.db,
                user=ctx.user,
                filename=filename,
                mime_type="application/pdf",
                content=pdf_bytes,
                source_kind=GeneratedKind.RENDERED_PDF.value,
                source_file_id=md_row.id,
            )
        except GeneratedFileError as e:
            raise ToolError(f"Couldn't save PDF: {e}") from e

        logger.info(
            "generate_pdf: ok user=%s md_id=%s pdf_id=%s pdf_bytes=%d",
            ctx.user.id,
            md_row.id,
            pdf_row.id,
            pdf_row.size_bytes,
        )

        return ToolResult(
            content=(
                f"Generated '{pdf_row.filename}' "
                f"({pdf_row.size_bytes:,} bytes) from "
                f"{len(markdown_source):,} characters of Markdown. "
                f"The editable source is saved as '{md_row.filename}' "
                "in Generated Files / Files."
            ),
            attachment_ids=[pdf_row.id],
            meta={
                "filename": pdf_row.filename,
                "size_bytes": pdf_row.size_bytes,
                "source_filename": md_row.filename,
                "source_file_id": str(md_row.id),
                "rendered_file_id": str(pdf_row.id),
            },
        )


__all__ = ["GeneratePdfTool"]
