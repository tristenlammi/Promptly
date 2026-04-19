"""Attach-a-text-file tool — proves the assistant-attachment path.

This is the second of the two Phase A1 smoke-test tools. ``echo`` checks
that the model can dispatch a function and consume its return value;
this one additionally verifies that a tool can produce a real file (via
:func:`app.files.generated.persist_generated_file`), have it routed into
the correct system folder, and have the chat router stamp the resulting
attachment onto the assistant message so a chip renders next to the
reply.

Real artefact tools (image gen, PDF authoring) replace this in later
phases; until then it's the contract test for the attachment plumbing.
"""
from __future__ import annotations

from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.files.generated import GeneratedFileError, persist_generated_file


class AttachDemoFileTool(Tool):
    name = "attach_demo_file"
    description = (
        "Generate a small text file with the supplied content and attach "
        "it to your reply. Use this only when the user explicitly asks "
        "you to produce or attach a file for testing — don't volunteer "
        "it for normal answers. The file lands in the user's "
        "'Generated Files' folder."
    )
    prompt_hint = (
        "Attach a small plaintext file to your reply. Diagnostic only — "
        "call only when the user explicitly asks for a test attachment."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "filename": {
                "type": "string",
                "description": (
                    "File name to give the generated file. Must end in "
                    ".txt. Maximum 100 characters."
                ),
                "maxLength": 100,
            },
            "content": {
                "type": "string",
                "description": (
                    "UTF-8 text body to write into the file. Maximum "
                    "10 000 characters."
                ),
                "maxLength": 10_000,
            },
        },
        "required": ["filename", "content"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        filename = args.get("filename")
        content = args.get("content")

        if not isinstance(filename, str) or not filename.strip():
            raise ToolError("`filename` is required and must be a string")
        if not isinstance(content, str):
            raise ToolError("`content` must be a string")

        filename = filename.strip()
        # Force a .txt extension. Anything else would invite a tool that
        # claims "image.png" but writes UTF-8 — and the user-facing
        # download path trusts the row's MIME type.
        if not filename.lower().endswith(".txt"):
            raise ToolError("`filename` must end in .txt")
        if len(filename) > 100:
            raise ToolError("`filename` exceeds 100-char limit")
        if len(content) > 10_000:
            raise ToolError("`content` exceeds 10 000-char limit")

        try:
            row = await persist_generated_file(
                ctx.db,
                user=ctx.user,
                filename=filename,
                mime_type="text/plain",
                content=content.encode("utf-8"),
            )
        except GeneratedFileError as e:
            raise ToolError(str(e)) from e

        return ToolResult(
            content=(
                f"Wrote {row.size_bytes} bytes to '{row.filename}' and "
                "attached it to the reply."
            ),
            attachment_ids=[row.id],
            meta={"filename": row.filename, "size_bytes": row.size_bytes},
        )
