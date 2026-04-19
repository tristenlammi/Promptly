"""Echo tool — the simplest possible smoke test for the tool spine.

The model gets a single string argument and the tool just hands it back
unchanged. Useful as the "hello world" of tool calling: if this fires
end-to-end (model → router dispatch → tool_finished SSE → second model
call → assistant reply) we know the plumbing is correct, independent of
any artefact-attachment logic.
"""
from __future__ import annotations

from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult


class EchoTool(Tool):
    name = "echo"
    description = (
        "Echoes a piece of text back unchanged. Use this only when the "
        "user explicitly asks you to test the tool system or to demonstrate "
        "a tool call. Don't volunteer it for normal questions."
    )
    prompt_hint = (
        "Echo text back unchanged. Diagnostic only — call only when the "
        "user explicitly asks to test tool calling."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The text to echo back. Maximum 500 characters.",
                "maxLength": 500,
            }
        },
        "required": ["text"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        text = args.get("text", "")
        if not isinstance(text, str):
            raise ToolError("`text` must be a string")
        if len(text) > 500:
            raise ToolError("`text` exceeds 500-char limit")
        # The content string is what the model sees in the follow-up call.
        # Wrap it in quotes so the model can clearly distinguish "the echo
        # came back as <X>" from prose around it.
        return ToolResult(content=f'echo: "{text}"')
